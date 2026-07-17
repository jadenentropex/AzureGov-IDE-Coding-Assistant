import * as vscode from 'vscode';

export interface ExtConfig {
  endpoint: string;
  model: string;
  authMode: 'entra' | 'key' | 'managed';
  tenantId: string;
  store: boolean;
  approveWrites: boolean;
}

export function readConfig(): ExtConfig {
  const c = vscode.workspace.getConfiguration('azgovIde');
  return {
    endpoint: c.get<string>('endpoint', 'https://aoai-azgov-ide.openai.azure.us'),
    model: c.get<string>('model', 'gpt-4.1'),
    authMode: c.get<'entra' | 'key' | 'managed'>('authMode', 'managed'),
    tenantId: c.get<string>('tenantId', ''),
    store: c.get<boolean>('store', false),
    approveWrites: c.get<boolean>('approveWrites', true),
  };
}

const ALLOWED_MODELS_DEFAULT = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-5.1', 'o3-mini', 'gpt-4o'];

function matchHost(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    return host.endsWith(suffix) || host === p.slice(2);
  }
  return host === p;
}

/**
 * Enforce the CUI boundary before any model call: refuse endpoints or models outside the
 * org allowlist so the agent cannot be repointed at a commercial or rogue endpoint and
 * stream CUI outside the Azure Gov boundary (NIST SP 800-171 3.13.1 / CM 3.4.2).
 */
export function assertBoundary(cfg: ExtConfig): void {
  let host: string;
  try {
    host = new URL(cfg.endpoint).host.toLowerCase();
  } catch {
    throw new Error(`Invalid azgovIde.endpoint URL: ${cfg.endpoint}`);
  }
  const c = vscode.workspace.getConfiguration('azgovIde');
  const allowedHosts = ['*.openai.azure.us', ...c.get<string[]>('allowedEndpointHosts', [])];
  if (!allowedHosts.some((p) => matchHost(host, p))) {
    throw new Error(
      `Blocked: endpoint host "${host}" is not on the allowlist (${allowedHosts.join(', ')}). ` +
        'This prevents sending CUI outside the Azure Gov boundary. ' +
        'Add an approved private host via azgovIde.allowedEndpointHosts.',
    );
  }
  const allowedModels = c.get<string[]>('allowedModels', ALLOWED_MODELS_DEFAULT);
  if (allowedModels.length && !allowedModels.includes(cfg.model)) {
    throw new Error(`Blocked: model "${cfg.model}" is not on the allowlist (${allowedModels.join(', ')}). Set azgovIde.allowedModels to change it.`);
  }
}
