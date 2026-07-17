import * as vscode from 'vscode';
import type { TokenProvider } from '@azgov-ide/agents-client';

const KEY_SECRET = 'azgovIde.apiKey';
const TOKEN_SECRET = 'azgovIde.entraToken';

/** Azure US Government Entra authority. */
const GOV_AUTHORITY = 'https://login.microsoftonline.us';
/** Data-plane scope for Azure OpenAI in Gov, plus a refresh token. */
const GOV_SCOPE = 'https://cognitiveservices.azure.us/.default offline_access';
/** Azure CLI's well-known public client id — supports the device-code flow. */
const AZ_CLI_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
/** Data-plane audience for the VM's managed-identity token (IMDS). */
const GOV_MI_RESOURCE = 'https://cognitiveservices.azure.us';

let miCache: { token: string; exp: number } | undefined;

/**
 * Get a token from the Azure VM's system-assigned **managed identity** via the local
 * Instance Metadata Service (169.254.169.254). No browser, no CDN, no external egress,
 * no interactive sign-in — authentication happens entirely inside the VM. The VM's
 * identity must hold the "Cognitive Services OpenAI User" role on the resource.
 */
async function getManagedIdentityToken(): Promise<string> {
  if (miCache && miCache.exp - 60_000 > Date.now()) return miCache.token;
  const url =
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=' +
    encodeURIComponent(GOV_MI_RESOURCE);
  const res = await fetch(url, { headers: { Metadata: 'true' } });
  if (!res.ok) {
    throw new Error(
      `Managed identity token failed (${res.status}): ${(await res.text()).slice(0, 300)}. ` +
        'Ensure the VM has a system-assigned identity with the "Cognitive Services OpenAI User" role.',
    );
  }
  const t = (await res.json()) as { access_token: string; expires_on?: string };
  miCache = { token: t.access_token, exp: t.expires_on ? Number(t.expires_on) * 1000 : Date.now() + 3_600_000 };
  return t.access_token;
}

interface TokenCache {
  access_token: string;
  expires_at: number;
  refresh_token?: string;
}

/**
 * Keyless Microsoft Entra auth via the OAuth **device-code** flow. Unlike VS Code's
 * browser sign-in (which needs `aadcdn.msftauth.net` to render its page), device code
 * only talks to the token endpoint at `login.microsoftonline.us` — so it works on
 * locked-down / PAW workstations where the sign-in CDN is blocked. The user completes
 * the code on any machine; tokens are cached (refresh-token) in SecretStorage.
 */
class DeviceCodeAuth {
  private inflight?: Promise<string>;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly tenantId: string) {}

  private base(): string {
    return `${GOV_AUTHORITY}/${this.tenantId || 'organizations'}/oauth2/v2.0`;
  }

  async getToken(): Promise<string> {
    const cached = await this.read();
    if (cached && cached.expires_at - 60_000 > Date.now()) return cached.access_token;
    if (cached?.refresh_token) {
      try {
        return await this.refresh(cached.refresh_token);
      } catch {
        /* fall through to device code */
      }
    }
    if (!this.inflight) this.inflight = this.deviceCodeFlow().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async read(): Promise<TokenCache | undefined> {
    const raw = await this.ctx.secrets.get(TOKEN_SECRET);
    return raw ? (JSON.parse(raw) as TokenCache) : undefined;
  }

  private async write(t: { access_token: string; expires_in?: number; refresh_token?: string }): Promise<void> {
    const cache: TokenCache = {
      access_token: t.access_token,
      expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
      refresh_token: t.refresh_token,
    };
    await this.ctx.secrets.store(TOKEN_SECRET, JSON.stringify(cache));
  }

  private async refresh(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: AZ_CLI_CLIENT_ID,
      refresh_token: refreshToken,
      scope: GOV_SCOPE,
    });
    const res = await fetch(`${this.base()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error('refresh failed');
    const t = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
    await this.write(t);
    return t.access_token;
  }

  private async deviceCodeFlow(): Promise<string> {
    const dcRes = await fetch(`${this.base()}/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: AZ_CLI_CLIENT_ID, scope: GOV_SCOPE }),
    });
    if (!dcRes.ok) throw new Error(`Device-code request failed: ${dcRes.status} ${(await dcRes.text()).slice(0, 300)}`);
    const dc = (await dcRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in?: number;
      interval?: number;
    };

    await vscode.env.clipboard.writeText(dc.user_code);
    void vscode.window
      .showInformationMessage(
        `Azure Gov sign-in required. Code ${dc.user_code} was copied to your clipboard — open ${dc.verification_uri} and paste it.`,
        'Open sign-in page',
      )
      .then((pick) => {
        if (pick === 'Open sign-in page') void vscode.env.openExternal(vscode.Uri.parse(dc.verification_uri));
      });

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Waiting for Azure Gov sign-in — enter code ${dc.user_code}`, cancellable: true },
      async (_p, token) => {
        const deadline = Date.now() + (dc.expires_in ?? 900) * 1000;
        let interval = (dc.interval ?? 5) * 1000;
        while (Date.now() < deadline) {
          if (token.isCancellationRequested) throw new Error('Sign-in cancelled.');
          await new Promise((r) => setTimeout(r, interval));
          const tRes = await fetch(`${this.base()}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              client_id: AZ_CLI_CLIENT_ID,
              device_code: dc.device_code,
            }),
          });
          if (tRes.ok) {
            const t = (await tRes.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
            await this.write(t);
            return t.access_token;
          }
          const err = (await tRes.json().catch(() => ({}))) as { error?: string; error_description?: string };
          if (err.error === 'authorization_pending') continue;
          if (err.error === 'slow_down') {
            interval += 5000;
            continue;
          }
          throw new Error(`Sign-in failed: ${err.error_description ?? err.error ?? tRes.status}`);
        }
        throw new Error('Sign-in timed out.');
      },
    );
  }
}

/**
 * Build a TokenProvider for the Gov data plane.
 * - `key`   — break-glass API key from SecretStorage (over the private endpoint).
 * - `entra` — keyless device-code auth (works on locked-down boxes; no `aadcdn`).
 */
export async function getTokenProvider(
  ctx: vscode.ExtensionContext,
  cfg: { authMode: 'entra' | 'key' | 'managed'; tenantId: string },
): Promise<TokenProvider> {
  if (cfg.authMode === 'key') {
    const key = await ctx.secrets.get(KEY_SECRET);
    if (!key) {
      throw new Error('No break-glass API key set. Run "AzureGov IDE: Set break-glass API key", or switch azgovIde.authMode to "managed"/"entra".');
    }
    return { kind: 'apiKey', apiKey: key };
  }

  if (cfg.authMode === 'managed') {
    return { kind: 'bearer', getToken: () => getManagedIdentityToken() };
  }

  const auth = new DeviceCodeAuth(ctx, cfg.tenantId);
  return { kind: 'bearer', getToken: () => auth.getToken() };
}

export async function setApiKey(ctx: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: 'Azure OpenAI (US Gov) break-glass API key',
    password: true,
    ignoreFocusOut: true,
  });
  if (key) {
    await ctx.secrets.store(KEY_SECRET, key.trim());
    void vscode.window.showInformationMessage('AzureGov IDE: API key saved to SecretStorage.');
  }
}

export async function clearApiKey(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.secrets.delete(KEY_SECRET);
  await ctx.secrets.delete(TOKEN_SECRET);
  void vscode.window.showInformationMessage('AzureGov IDE: stored key and cached token cleared.');
}
