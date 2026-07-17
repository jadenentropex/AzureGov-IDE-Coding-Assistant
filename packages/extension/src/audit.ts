import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface Actor {
  source: string; // managed-identity | entra | api-key | unknown
  oid?: string;
  upn?: string;
  name?: string;
  tid?: string;
  appid?: string;
  miResource?: string;
}

const LAST_HASH_KEY = 'azgovIde.audit.lastHash';
const SEQ_KEY = 'azgovIde.audit.seq';
const GENESIS = 'GENESIS';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Decode the identity claims from an access token (JWT) for attribution. */
export function decodeTokenIdentity(token: string): Actor {
  try {
    const part = token.split('.')[1];
    if (!part) return { source: 'unknown' };
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const c = JSON.parse(json) as Record<string, unknown>;
    const miResource = c['xms_mirid'] as string | undefined;
    return {
      source: miResource ? 'managed-identity' : 'entra',
      oid: c['oid'] as string | undefined,
      upn: (c['upn'] ?? c['preferred_username']) as string | undefined,
      name: c['name'] as string | undefined,
      tid: c['tid'] as string | undefined,
      appid: (c['appid'] ?? c['azp']) as string | undefined,
      miResource,
    };
  } catch {
    return { source: 'unknown' };
  }
}

/**
 * Tamper-evident, append-only audit log of agent actions. Because store=false means Azure
 * keeps no conversation state, the client is the only possible audit source, so this is the
 * load-bearing AU control (NIST SP 800-171 3.3.1 / 3.3.2 / 3.3.8). Every event is
 * hash-chained to the previous one, and carries a UTC timestamp, session id, and the
 * resolved Entra identity so actions trace to an individual (or the VM identity).
 */
export class AuditLog {
  private readonly dir: string;
  private readonly file: string;
  private lastHash: string;
  private seq: number;
  private actor: Actor = { source: 'unknown' };
  private readonly ready: Promise<void>;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.dir = path.join(ctx.globalStorageUri.fsPath, 'audit');
    this.file = path.join(this.dir, 'audit.jsonl');
    this.lastHash = ctx.globalState.get<string>(LAST_HASH_KEY, GENESIS);
    this.seq = ctx.globalState.get<number>(SEQ_KEY, 0);
    this.ready = fs.mkdir(this.dir, { recursive: true }).then(() => undefined);
  }

  setActor(actor: Actor): void {
    this.actor = actor;
  }

  get filePath(): string {
    return this.file;
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('azgovIde').get<boolean>('auditEnabled', true);
  }

  async append(type: string, sessionId: string, fields: Record<string, unknown> = {}): Promise<void> {
    if (!this.enabled()) return;
    try {
      await this.ready;
      const prevHash = this.lastHash;
      const base: Record<string, unknown> = {
        v: 1,
        ts: new Date().toISOString(),
        seq: ++this.seq,
        sessionId,
        type,
        actor: this.actor,
        host: process.env['COMPUTERNAME'] ?? process.env['HOSTNAME'] ?? '',
        ...fields,
        prevHash,
      };
      const hash = sha256(JSON.stringify(base) + prevHash);
      const line = JSON.stringify({ ...base, hash }) + '\n';
      await fs.appendFile(this.file, line, 'utf8');
      this.lastHash = hash;
      await this.ctx.globalState.update(LAST_HASH_KEY, hash);
      await this.ctx.globalState.update(SEQ_KEY, this.seq);
      const label = fields['path'] ?? fields['command'] ?? fields['tool'] ?? fields['responseId'] ?? '';
      this.output.appendLine(`[audit] ${type} ${label}`.trimEnd());
    } catch (e) {
      this.output.appendLine(`[audit] ERROR writing event: ${(e as Error).message}`);
    }
  }
}

/** Verify the hash chain of an audit file. Detects any insertion, deletion, or edit. */
export async function verifyAuditChain(file: string): Promise<{ ok: boolean; events: number; brokenAt?: number; error?: string }> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    return { ok: false, events: 0, error: `cannot read ${file}: ${(e as Error).message}` };
  }
  const lines = text.split('\n').filter((l) => l.trim());
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let ev: { hash?: string } & Record<string, unknown>;
    try {
      ev = JSON.parse(lines[i] as string) as { hash?: string } & Record<string, unknown>;
    } catch {
      return { ok: false, events: lines.length, brokenAt: i + 1, error: 'invalid JSON' };
    }
    const { hash, ...base } = ev;
    if (base['prevHash'] !== prev) return { ok: false, events: lines.length, brokenAt: i + 1, error: 'prevHash mismatch' };
    if (sha256(JSON.stringify(base) + prev) !== hash) return { ok: false, events: lines.length, brokenAt: i + 1, error: 'hash mismatch' };
    prev = hash as string;
  }
  return { ok: true, events: lines.length };
}
