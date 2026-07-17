import * as vscode from 'vscode';

/**
 * Redact secrets from text that gets persisted (audit log, which is forwarded off-box) or
 * displayed (change/approval cards, tool lines). Value-level masking preserves intent - a
 * reviewer still sees `az login --password [REDACTED]`, not a blank - while keeping the secret
 * out of the audit trail and off screens (NIST SP 800-171 3.1.19 / 3.13.16, and MP handling).
 *
 * It is deliberately NOT applied to what the model receives or to bytes written to disk: the
 * model is in-boundary and needs real content to function, and files must be written verbatim.
 * The threat this addresses is a secret leaking into a widely-readable audit copy or a screenshot,
 * not the in-boundary model seeing it.
 */

interface Rule {
  re: RegExp;
  to: string;
}

// High-precision rules, ordered so structured secrets are caught before generic key=value.
const RULES: Rule[] = [
  { re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, to: '[REDACTED PRIVATE KEY]' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, to: '[REDACTED JWT]' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, to: 'Bearer [REDACTED]' },
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, to: '$1$2:[REDACTED]@' }, // creds in a URL
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, to: '[REDACTED AWS KEY]' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, to: '[REDACTED TOKEN]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, to: '[REDACTED TOKEN]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, to: '[REDACTED TOKEN]' },
  { re: /\bAccountKey=[^;"'\s]+/gi, to: 'AccountKey=[REDACTED]' },
  { re: /\bsig=[A-Za-z0-9%]{20,}/gi, to: 'sig=[REDACTED]' }, // SAS signature
  { re: /(--password|--client-secret|--secret|--api-key|--account-key|--sas-token|-p)(\s+)("[^"]*"|'[^']*'|[^\s"']+)/gi, to: '$1$2[REDACTED]' },
  { re: /\b(pass(?:word)?|pwd|secret|token|api[_-]?key|apikey|client[_-]?secret|access[_-]?key|connection[_-]?string)\b(\s*["']?\s*[:=]\s*["']?)([^\s"',;)}&]{4,})/gi, to: '$1$2[REDACTED]' },
];

/** Mask secret values in a string. Pure; safe to call on any text. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const r of RULES) out = out.replace(r.re, r.to);
  return out;
}

/** Redact only when azgovIde.redactSecrets is enabled (default on). */
export function redactIfEnabled(text: string): string {
  if (!text) return text;
  const on = vscode.workspace.getConfiguration('azgovIde').get<boolean>('redactSecrets', true);
  return on ? redactSecrets(text) : text;
}
