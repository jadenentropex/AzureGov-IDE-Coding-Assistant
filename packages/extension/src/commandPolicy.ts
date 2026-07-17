/**
 * Pure command-execution policy for run_terminal (roadmap P0-7). Kept dependency-free (no vscode)
 * so it is unit-testable in isolation: the layered denylist, allowlist, network-egress guard, and
 * the hard Auto-mode gate all live here, and tools.ts just supplies the live settings.
 */

/** Always-blocked destructive patterns. */
export const DENY: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bmkfs\b/i,
  /\bformat\s+[a-z]:/i,
  /\bcurl\b[^\n|]*\|\s*(sh|bash)\b/i,
  /\bwget\b[^\n|]*\|\s*(sh|bash)\b/i,
  /Invoke-Expression|iex\s/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
];

/**
 * Ad-hoc network/egress tools. When blockNetworkCommands is on, these are refused so CUI cannot be
 * exfiltrated through the terminal. Deliberately NOT matched: package managers (npm, pip, dotnet)
 * and Azure CLI (`az`, `azcopy`) - they reach known registries / in-boundary Gov endpoints. The
 * sanctioned tunnel path is `az network bastion tunnel`, not raw ssh/scp.
 */
export const NETWORK: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bInvoke-RestMethod\b/i,
  /\biwr\b/i,
  /\birm\b/i,
  /\bStart-BitsTransfer\b/i,
  /\bbitsadmin\b/i,
  /\bcertutil\b[^\n]*-urlcache/i,
  /\b(nc|ncat|netcat|telnet|ftp|tftp|sftp|scp|rsync|ssh)\b/i,
];

/** First executable token of a command, stripped of path and extension, lowercased. */
export function firstExe(command: string): string {
  const m = command.trim().match(/^"([^"]+)"|^(\S+)/);
  let tok = (m?.[1] ?? m?.[2] ?? '').trim();
  tok = tok.split(/[\\/]/).pop() ?? tok;
  return tok.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '').toLowerCase();
}

export interface CommandPolicyOpts {
  allowlist: string[];
  blockNetwork: boolean;
}

/** Whether the command's executable is on the (non-empty) allowlist. */
export function isAllowlisted(command: string, allowlist: string[]): boolean {
  const al = allowlist.map((s) => s.toLowerCase());
  return al.length > 0 && al.includes(firstExe(command));
}

/** Reason the command must be blocked, or null if it may run (possibly with approval). */
export function commandBlockReason(command: string, opts: CommandPolicyOpts): string | null {
  if (DENY.some((r) => r.test(command))) return 'BLOCKED: command matches a denied pattern.';
  if (opts.allowlist.length > 0 && !isAllowlisted(command, opts.allowlist)) {
    return `BLOCKED: '${firstExe(command)}' is not on the command allowlist (azgovIde.commandAllowlist).`;
  }
  if (opts.blockNetwork && NETWORK.some((r) => r.test(command))) {
    return 'BLOCKED: network/egress commands are disabled by policy (azgovIde.blockNetworkCommands) so CUI cannot leave the boundary. Use az / az network bastion tunnel for sanctioned access.';
  }
  return null;
}

export interface GateOpts {
  approveWrites: boolean;
  autoApprove: boolean;
  autoAllowTerminal: boolean;
  onAllowlist: boolean;
}

/**
 * Hard Auto-mode gate: Auto mode auto-applies file edits, but shell execution still requires human
 * approval unless the org opted in (autoAllowTerminal) or the executable is allowlisted. This blunts
 * prompt-injection -> code execution.
 */
export function shouldGateShell(o: GateOpts): boolean {
  return o.approveWrites === true && o.autoApprove === true && !(o.autoAllowTerminal || o.onAllowlist);
}
