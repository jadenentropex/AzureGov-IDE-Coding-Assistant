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

/** Token getter for the Azure Monitor scope; returns undefined when forwarding is unavailable. */
export type MonitorTokenFn = () => Promise<string | undefined>;

/**
 * Forwards audit events off-box to a Log Analytics workspace via the Azure Monitor Logs
 * Ingestion API (Gov: `*.ingest.monitor.azure.us`). This gives the audit log a second,
 * independent home so a compromised endpoint cannot both act and erase its own trail
 * (NIST SP 800-171 3.3.8 - protect audit information). The full hash-chained event is
 * carried in `RawEvent`, so the off-box copy stays independently verifiable.
 *
 * Forwarding is best-effort and never blocks or fails the agent: events queue in memory,
 * flush on a short debounce, and are retried on transient failure. When the ingestion
 * endpoint/DCR are not configured (or no Monitor token is available), the log simply
 * stays local-only.
 */
class LogForwarder {
  private queue: Record<string, unknown>[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private warned = false;
  private dropped = 0;
  private static readonly MAX_QUEUE = 1000;
  private static readonly BATCH = 200;
  private static readonly TRIGGER = 25;
  private static readonly DEBOUNCE_MS = 4000;

  constructor(private readonly getToken: MonitorTokenFn, private readonly output: vscode.OutputChannel) {}

  private cfg(): { endpoint: string; dcr: string; stream: string } | undefined {
    const c = vscode.workspace.getConfiguration('azgovIde');
    const endpoint = (c.get<string>('auditIngestionEndpoint', '') || '').replace(/\/+$/, '');
    const dcr = c.get<string>('auditDcrImmutableId', '') || '';
    const stream = c.get<string>('auditStreamName', 'Custom-AzgovIdeAudit_CL') || 'Custom-AzgovIdeAudit_CL';
    if (!endpoint || !dcr) return undefined;
    return { endpoint, dcr, stream };
  }

  enqueue(record: Record<string, unknown>): void {
    if (!this.cfg()) return; // not configured: stay local-only
    this.queue.push(record);
    if (this.queue.length > LogForwarder.MAX_QUEUE) {
      const over = this.queue.length - LogForwarder.MAX_QUEUE;
      this.queue.splice(0, over);
      this.dropped += over;
      this.output.appendLine(`[audit] forwarder queue full, dropped ${this.dropped} oldest event(s) pending flush`);
    }
    if (this.queue.length >= LogForwarder.TRIGGER) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), LogForwarder.DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.flushing || this.queue.length === 0) return;
    const cfg = this.cfg();
    if (!cfg) return;
    this.flushing = true;
    try {
      const token = await this.getToken();
      if (!token) {
        if (!this.warned) {
          this.output.appendLine('[audit] forwarding configured but no Monitor token available; log stays local-only for now');
          this.warned = true;
        }
        return; // keep the queue; retry on the next event
      }
      this.warned = false;
      const batch = this.queue.slice(0, LogForwarder.BATCH);
      const url = `${cfg.endpoint}/dataCollectionRules/${cfg.dcr}/streams/${encodeURIComponent(cfg.stream)}?api-version=2023-01-01`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (res.ok) {
        this.queue.splice(0, batch.length); // only drop what we confirmed sent
        if (this.queue.length > 0) void this.flush(); // drain remaining batches
      } else {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        this.output.appendLine(`[audit] forward failed (${res.status}): ${body}; ${this.queue.length} event(s) queued for retry`);
      }
    } catch (e) {
      this.output.appendLine(`[audit] forward error: ${(e as Error).message}; ${this.queue.length} event(s) queued for retry`);
    } finally {
      this.flushing = false;
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    void this.flush();
  }
}

/** Flatten a hash-chained event into the Log Analytics custom-table row shape. */
function toRow(ev: Record<string, unknown>): Record<string, unknown> {
  const actor = (ev['actor'] ?? {}) as Record<string, unknown>;
  const row: Record<string, unknown> = {
    TimeGenerated: ev['ts'],
    Seq: ev['seq'],
    SessionId: ev['sessionId'],
    EventType: ev['type'],
    ActorSource: actor['source'],
    ActorOid: actor['oid'],
    ActorUpn: actor['upn'],
    ActorName: actor['name'],
    ActorTenantId: actor['tid'],
    AppId: actor['appid'],
    MiResource: actor['miResource'],
    Host: ev['host'],
    Model: ev['model'],
    Endpoint: ev['endpoint'],
    Mode: ev['mode'],
    ResponseId: ev['responseId'],
    Tool: ev['tool'],
    ToolArgs: ev['args'],
    ToolResult: ev['result'],
    ChangeId: ev['changeId'],
    ChangeKind: ev['kind'],
    ChangePath: ev['path'],
    Command: ev['command'],
    LinesAdded: ev['added'],
    LinesRemoved: ev['removed'],
    BeforeSha: ev['beforeSha'],
    AfterSha: ev['afterSha'],
    NeedsApproval: ev['needsApproval'],
    Approved: ev['approved'],
    Ok: ev['ok'],
    Rejected: ev['rejected'],
    ExitCode: ev['exitCode'],
    ErrorMessage: ev['error'] ?? ev['message'],
    InputTokens: ev['inputTokens'],
    OutputTokens: ev['outputTokens'],
    CostUsd: ev['costUsd'],
    Steps: ev['steps'],
    Messages: ev['messages'],
    Hash: ev['hash'],
    PrevHash: ev['prevHash'],
    RawEvent: JSON.stringify(ev),
  };
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  return row;
}

/**
 * Tamper-evident, append-only audit log of agent actions. Because store=false means Azure
 * keeps no conversation state, the client is the only possible audit source, so this is the
 * load-bearing AU control (NIST SP 800-171 3.3.1 / 3.3.2 / 3.3.8). Every event is
 * hash-chained to the previous one, and carries a UTC timestamp, session id, and the
 * resolved Entra identity so actions trace to an individual (or the VM identity). Events are
 * also forwarded off-box to Log Analytics (when configured) for an independent copy.
 */
export class AuditLog {
  private readonly dir: string;
  private readonly file: string;
  private lastHash: string;
  private seq: number;
  private actor: Actor = { source: 'unknown' };
  private readonly ready: Promise<void>;
  private readonly forwarder?: LogForwarder;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    tokenFn?: MonitorTokenFn,
  ) {
    this.dir = path.join(ctx.globalStorageUri.fsPath, 'audit');
    this.file = path.join(this.dir, 'audit.jsonl');
    this.lastHash = ctx.globalState.get<string>(LAST_HASH_KEY, GENESIS);
    this.seq = ctx.globalState.get<number>(SEQ_KEY, 0);
    this.ready = fs.mkdir(this.dir, { recursive: true }).then(() => undefined);
    if (tokenFn) this.forwarder = new LogForwarder(tokenFn, output);
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
      const ev = { ...base, hash };
      await fs.appendFile(this.file, JSON.stringify(ev) + '\n', 'utf8');
      this.lastHash = hash;
      await this.ctx.globalState.update(LAST_HASH_KEY, hash);
      await this.ctx.globalState.update(SEQ_KEY, this.seq);
      this.forwarder?.enqueue(toRow(ev));
      const label = fields['path'] ?? fields['command'] ?? fields['tool'] ?? fields['responseId'] ?? '';
      this.output.appendLine(`[audit] ${type} ${label}`.trimEnd());
    } catch (e) {
      this.output.appendLine(`[audit] ERROR writing event: ${(e as Error).message}`);
    }
  }

  /** Flush any queued off-box events (call on shutdown). */
  dispose(): void {
    this.forwarder?.dispose();
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
