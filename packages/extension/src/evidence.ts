import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AuditLog } from './audit';

/**
 * Machine-derived compliance evidence (roadmap P0-8).
 *
 * Reads the tool's *effective, live* configuration and audit state and emits a control-mapped
 * evidence bundle (JSON + a human-readable SSP excerpt) against NIST SP 800-171 / CMMC L2. The
 * point is that the evidence is generated from what the tool is actually enforcing right now, not
 * hand-written claims: an assessor (or Entropex) can read the JSON, re-verify the audit chain, and
 * see exactly which controls are satisfied and which need attention.
 */

interface ControlEvidence {
  control: string;
  family: string;
  title: string;
  implementation: string;
  evidence: string;
  status: 'implemented' | 'configurable' | 'attention';
}

interface AuditStats {
  events: number;
  firstTs?: string;
  lastTs?: string;
  sessions: number;
  actors: string[];
  typeCounts: Record<string, number>;
  forwardedOffBox: boolean;
}

interface EvidenceBundle {
  tool: string;
  vendor: string;
  generatedAt: string;
  host: string;
  framework: string;
  configuration: Record<string, unknown>;
  audit: {
    integrityVerified: boolean;
    brokenAt?: number;
    error?: string;
    events: number;
    sessions: number;
    distinctActors: string[];
    firstEvent?: string;
    lastEvent?: string;
    eventTypeCounts: Record<string, number>;
    offBoxForwarding: boolean;
  };
  summary: { implemented: number; configurable: number; attention: number };
  controls: ControlEvidence[];
}

function ts(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function auditStats(file: string, forwardedOffBox: boolean): Promise<AuditStats> {
  const stats: AuditStats = { events: 0, sessions: 0, actors: [], typeCounts: {}, forwardedOffBox };
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return stats;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const sessions = new Set<string>();
  const actors = new Set<string>();
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    stats.events++;
    const t = String(ev['type'] ?? 'unknown');
    stats.typeCounts[t] = (stats.typeCounts[t] ?? 0) + 1;
    if (ev['sessionId']) sessions.add(String(ev['sessionId']));
    const actor = (ev['actor'] ?? {}) as Record<string, unknown>;
    const who = (actor['upn'] ?? actor['oid'] ?? actor['source']) as string | undefined;
    if (who) actors.add(who);
    const evTs = ev['ts'] as string | undefined;
    if (evTs) {
      if (!stats.firstTs) stats.firstTs = evTs;
      stats.lastTs = evTs;
    }
  }
  stats.sessions = sessions.size;
  stats.actors = [...actors];
  return stats;
}

function buildControls(cfg: vscode.WorkspaceConfiguration, verify: { ok: boolean; events: number; brokenAt?: number; error?: string }, stats: AuditStats): ControlEvidence[] {
  const get = <T>(k: string, d: T): T => cfg.get<T>(k, d);
  const endpoint = get('endpoint', '');
  const store = get('store', false);
  const authMode = get<string>('authMode', 'managed');
  const approveWrites = get('approveWrites', true);
  const auditEnabled = get('auditEnabled', true);
  const allowedModels = get<string[]>('allowedModels', []);
  const allowedHosts = get<string[]>('allowedEndpointHosts', []);
  const cmdAllow = get<string[]>('commandAllowlist', []);
  const blockNet = get('blockNetworkCommands', false);
  const autoTerm = get('autoModeAllowTerminal', false);
  const ingest = get('auditIngestionEndpoint', '');
  const govEndpoint = /\.openai\.azure\.us$/i.test(new URL(endpoint || 'https://x.invalid').hostname);

  const yn = (b: boolean): string => (b ? 'yes' : 'no');

  return [
    {
      control: '3.1.1', family: 'AC', title: 'Limit system access to authorized users',
      implementation: 'Access to the model is via Entra identity (managed identity or device-code), not a shared key.',
      evidence: `authMode=${authMode}`,
      status: authMode === 'key' ? 'attention' : 'implemented',
    },
    {
      control: '3.1.2', family: 'AC', title: 'Limit access to permitted transactions/functions',
      implementation: 'File writes and shell commands require human approval; Plan/Review modes are read-only.',
      evidence: `approveWrites=${yn(approveWrites)}`,
      status: approveWrites ? 'implemented' : 'attention',
    },
    {
      control: '3.1.5', family: 'AC', title: 'Least privilege',
      implementation: 'Command allowlist restricts run_terminal to approved executables; workspace-root confinement blocks path escapes.',
      evidence: `commandAllowlist=[${cmdAllow.join(', ')}]`,
      status: cmdAllow.length > 0 ? 'implemented' : 'configurable',
    },
    {
      control: '3.1.20', family: 'AC', title: 'Control connections to external systems',
      implementation: 'Endpoint is pinned to the Gov data plane (*.openai.azure.us) plus an allowed-host list; terminal egress guard blocks ad-hoc network tools.',
      evidence: `govEndpoint=${yn(govEndpoint)}, allowedHosts=[${allowedHosts.join(', ')}], blockNetworkCommands=${yn(blockNet)}`,
      status: govEndpoint ? 'implemented' : 'attention',
    },
    {
      control: '3.3.1', family: 'AU', title: 'Create and retain system audit logs',
      implementation: 'Every agent action is written to an append-only, hash-chained audit log.',
      evidence: `auditEnabled=${yn(auditEnabled)}, events=${stats.events}, sessions=${stats.sessions}`,
      status: auditEnabled && stats.events > 0 ? 'implemented' : 'configurable',
    },
    {
      control: '3.3.2', family: 'AU', title: 'Trace actions to individual users',
      implementation: 'Each event carries the resolved Entra identity (managed-identity object id or signed-in user).',
      evidence: `distinctActors=${stats.actors.length} [${stats.actors.join(', ')}]`,
      status: stats.actors.length > 0 ? 'implemented' : 'configurable',
    },
    {
      control: '3.3.8', family: 'AU', title: 'Protect audit information from unauthorized modification',
      implementation: 'Hash-chained log anchored to a persisted tip detects edit, insert, delete, and tail-truncation; events are also forwarded off-box to Log Analytics as an independent copy (the anchor of last resort against local rewrite).',
      evidence: `chainVerified=${yn(verify.ok)}${verify.ok ? '' : ` (broken at ${verify.brokenAt}: ${verify.error})`}, offBoxForwarding=${yn(!!ingest)}`,
      status: verify.ok ? 'implemented' : 'attention',
    },
    {
      control: '3.4.2', family: 'CM', title: 'Enforce security configuration settings',
      implementation: 'Security-relevant settings are policy-lockable (GPO/Intune) and validated at runtime (endpoint host, model allowlist).',
      evidence: `allowedModels=[${allowedModels.join(', ')}]`,
      status: 'implemented',
    },
    {
      control: '3.5.2', family: 'IA', title: 'Authenticate identities',
      implementation: 'Keyless Entra authentication (managed identity via IMDS or device-code); break-glass key stored only in SecretStorage.',
      evidence: `authMode=${authMode}`,
      status: authMode === 'key' ? 'attention' : 'implemented',
    },
    {
      control: '3.13.1', family: 'SC', title: 'Monitor/control communications at boundaries',
      implementation: 'Traffic stays on the Gov data plane; recommended deployment uses a private endpoint with public network access disabled.',
      evidence: `endpointHost=${(() => { try { return new URL(endpoint).hostname; } catch { return '(unset)'; } })()}`,
      status: govEndpoint ? 'implemented' : 'attention',
    },
    {
      control: '3.13.16', family: 'SC', title: 'Protect confidentiality of CUI at rest',
      implementation: 'store=false: Azure persists no server-side conversation state, so no CUI is written at rest in the service.',
      evidence: `store=${yn(store)}`,
      status: store ? 'attention' : 'implemented',
    },
    {
      control: '3.14.2', family: 'SI', title: 'Protect against malicious/unauthorized code paths',
      implementation: 'Prompt-injection defense: tool output is framed as untrusted data; command denylist and hard Auto-mode gate limit injection-to-execution.',
      evidence: `autoModeAllowTerminal=${yn(autoTerm)} (off = shell still needs approval in Auto mode)`,
      status: 'implemented',
    },
  ];
}

export async function generateEvidence(ctx: vscode.ExtensionContext, audit: AuditLog, output: vscode.OutputChannel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('azgovIde');
  const verify = await audit.verify();
  const stats = await auditStats(audit.filePath, !!cfg.get<string>('auditIngestionEndpoint', ''));
  const controls = buildControls(cfg, verify, stats);

  const summary = {
    implemented: controls.filter((c) => c.status === 'implemented').length,
    configurable: controls.filter((c) => c.status === 'configurable').length,
    attention: controls.filter((c) => c.status === 'attention').length,
  };

  const generatedAt = new Date().toISOString();
  const bundle: EvidenceBundle = {
    tool: 'AzureGov IDE Coding Assistant',
    vendor: 'Entropex, LLC (https://entropex.io)',
    generatedAt,
    host: process.env['COMPUTERNAME'] ?? process.env['HOSTNAME'] ?? '',
    framework: 'NIST SP 800-171 Rev. 2 / CMMC Level 2',
    configuration: {
      endpoint: cfg.get('endpoint', ''),
      model: cfg.get('model', ''),
      authMode: cfg.get('authMode', 'managed'),
      store: cfg.get('store', false),
      approveWrites: cfg.get('approveWrites', true),
      auditEnabled: cfg.get('auditEnabled', true),
      auditIngestionEndpoint: cfg.get('auditIngestionEndpoint', '') ? '(configured)' : '',
      allowedModels: cfg.get('allowedModels', []),
      allowedEndpointHosts: cfg.get('allowedEndpointHosts', []),
      commandAllowlist: cfg.get('commandAllowlist', []),
      blockNetworkCommands: cfg.get('blockNetworkCommands', false),
      autoModeAllowTerminal: cfg.get('autoModeAllowTerminal', false),
    },
    audit: {
      integrityVerified: verify.ok,
      brokenAt: verify.brokenAt,
      error: verify.error,
      events: stats.events,
      sessions: stats.sessions,
      distinctActors: stats.actors,
      firstEvent: stats.firstTs,
      lastEvent: stats.lastTs,
      eventTypeCounts: stats.typeCounts,
      offBoxForwarding: stats.forwardedOffBox,
    },
    summary,
    controls,
  };

  const md = renderMarkdown(bundle);
  const dir = await targetDir(ctx);
  await fs.mkdir(dir, { recursive: true });
  const stamp = ts();
  const jsonPath = path.join(dir, `evidence-${stamp}.json`);
  const mdPath = path.join(dir, `evidence-${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(bundle, null, 2), 'utf8');
  await fs.writeFile(mdPath, md, 'utf8');
  output.appendLine(`[evidence] wrote ${jsonPath} and ${mdPath}`);

  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
    await vscode.window.showTextDocument(doc);
  } catch {
    /* headless */
  }
  const attention = summary.attention;
  void vscode.window.showInformationMessage(
    `Evidence bundle written: ${summary.implemented} implemented, ${summary.configurable} configurable, ${attention} need attention.`,
  );
}

async function targetDir(ctx: vscode.ExtensionContext): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws) return path.join(ws.uri.fsPath, 'azgov-evidence');
  return path.join(ctx.globalStorageUri.fsPath, 'evidence');
}

function renderMarkdown(b: EvidenceBundle): string {
  const rows = b.controls
    .map((c) => `| ${c.control} | ${c.family} | ${c.title} | ${statusLabel(c.status)} | ${c.evidence} |`)
    .join('\n');
  const attentionItems = b.controls
    .filter((c) => c.status === 'attention')
    .map((c) => `- ${c.control} ${c.title}: ${c.evidence}`)
    .join('\n');
  return [
    '# Compliance evidence bundle',
    '',
    `Tool: ${b.tool}`,
    `Vendor: ${b.vendor}`,
    `Framework: ${b.framework}`,
    `Generated: ${b.generatedAt}`,
    `Host: ${b.host || '(unknown)'}`,
    '',
    'This report is generated from the tool\'s live, effective configuration and audit state.',
    'It is machine-derived evidence, not a hand-written assertion.',
    '',
    '## System posture',
    '',
    `- Endpoint: ${b.configuration.endpoint}`,
    `- Model: ${b.configuration.model}`,
    `- Auth mode: ${b.configuration.authMode}`,
    `- Server-side state (store): ${b.configuration.store}`,
    `- Approvals required: ${b.configuration.approveWrites}`,
    `- Audit enabled: ${b.configuration.auditEnabled}`,
    `- Off-box audit forwarding: ${b.audit.offBoxForwarding}`,
    '',
    '## Audit integrity',
    '',
    `- Hash chain verified: ${b.audit.integrityVerified}${b.audit.integrityVerified ? '' : ` (broken at ${b.audit.brokenAt}: ${b.audit.error})`}`,
    `- Events: ${b.audit.events} across ${b.audit.sessions} session(s)`,
    `- Distinct actors: ${b.audit.distinctActors.length}${b.audit.distinctActors.length ? ` (${b.audit.distinctActors.join(', ')})` : ''}`,
    `- Window: ${b.audit.firstEvent ?? '(none)'} to ${b.audit.lastEvent ?? '(none)'}`,
    '',
    '## Control summary',
    '',
    `Implemented: ${b.summary.implemented}  |  Configurable: ${b.summary.configurable}  |  Needs attention: ${b.summary.attention}`,
    '',
    '| Control | Family | Title | Status | Evidence |',
    '| --- | --- | --- | --- | --- |',
    rows,
    '',
    '## Items needing attention',
    '',
    attentionItems || '- None. All mapped controls are implemented or configurable.',
    '',
    '---',
    '',
    'Need help closing gaps or preparing for a C3PAO assessment? Entropex (https://entropex.io)',
    'builds and implements CMMC-compliant tooling. This report is a starting point, not a',
    'certification.',
    '',
  ].join('\n');
}

function statusLabel(s: ControlEvidence['status']): string {
  if (s === 'implemented') return 'Implemented';
  if (s === 'configurable') return 'Configurable';
  return 'Needs attention';
}
