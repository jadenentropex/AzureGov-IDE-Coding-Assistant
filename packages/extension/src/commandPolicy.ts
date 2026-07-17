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

/** First executable token of a single (unchained) command, stripped of path and extension. */
export function firstExe(command: string): string {
  const m = command.trim().match(/^"([^"]+)"|^(\S+)/);
  let tok = (m?.[1] ?? m?.[2] ?? '').trim();
  tok = tok.split(/[\\/]/).pop() ?? tok;
  return tok.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '').toLowerCase();
}

/**
 * Split a command line into the segments a shell would run separately, so the allowlist and the
 * Auto-mode gate inspect EVERY executable, not just the first. Covers `&&`, `||`, `;`, `|`, `&`,
 * newlines, and one level of command substitution (`$(...)` and backticks). This is a best-effort
 * tokenizer, not a full shell parser: its job is to make chaining/substitution surface the extra
 * executables to the allowlist rather than hide them behind an approved first token.
 */
function segments(command: string): string[] {
  const out = command.split(/&&|\|\||[;&|\n]/);
  const reSub = /\$\(([^()]*)\)|`([^`]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = reSub.exec(command)) !== null) out.push(m[1] ?? m[2] ?? '');
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Every executable invoked by the command line (across chaining and substitution). */
export function commandExes(command: string): string[] {
  return segments(command).map(firstExe).filter(Boolean);
}

export interface CommandPolicyOpts {
  allowlist: string[];
  blockNetwork: boolean;
}

/** Whether EVERY executable in the (possibly chained) command is on the non-empty allowlist. */
export function isAllowlisted(command: string, allowlist: string[]): boolean {
  const al = allowlist.map((s) => s.toLowerCase());
  if (al.length === 0) return false;
  const exes = commandExes(command);
  return exes.length > 0 && exes.every((e) => al.includes(e));
}

/** Reason the command must be blocked, or null if it may run (possibly with approval). */
export function commandBlockReason(command: string, opts: CommandPolicyOpts): string | null {
  if (DENY.some((r) => r.test(command))) return 'BLOCKED: command matches a denied pattern.';
  if (opts.allowlist.length > 0) {
    const al = opts.allowlist.map((s) => s.toLowerCase());
    const bad = commandExes(command).filter((e) => !al.includes(e));
    if (bad.length > 0) {
      return `BLOCKED: ${bad.map((b) => `'${b}'`).join(', ')} not on the command allowlist (azgovIde.commandAllowlist). Chained or substituted commands must have every executable allowlisted.`;
    }
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
