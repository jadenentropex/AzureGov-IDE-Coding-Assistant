import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { exec, spawn, type ChildProcess } from 'node:child_process';
import type { Tool } from '@azgov-ide/agents-client';

export interface ChangePreview {
  kind: 'create' | 'edit' | 'folder' | 'command';
  path?: string;
  added?: number;
  removed?: number;
  diff?: string;
  command?: string;
}

export interface ChangeResult {
  ok?: boolean;
  rejected?: boolean;
  error?: string;
  exitCode?: number;
  output?: string;
}

export interface ToolDeps {
  /** Absolute workspace root; all tool paths are confined within it. */
  root: string;
  /** Require confirmation before mutating actions. */
  approveWrites: boolean;
  /** Auto mode: skip approval. */
  autoApprove?: boolean;
  /** Plan/Review modes: expose only read-only tools. */
  readOnly?: boolean;
  log: (msg: string) => void;
  /** Show an inline change/approval card in the panel; resolves with the decision + card id. */
  requestChange?: (preview: ChangePreview, needsApproval: boolean) => Promise<{ approved: boolean; id: string }>;
  /** Finalize a change card (applied / rejected / error / command output). */
  changeDone?: (id: string, result: ChangeResult) => void;
}

const READONLY_TOOLS = new Set(['list_dir', 'read_file', 'grep']);

function confine(root: string, p: string): string {
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel === '') return resolved;
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path '${p}' escapes the workspace root`);
  return resolved;
}

const DENY: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bmkfs\b/i,
  /\bformat\s+[a-z]:/i,
  /\bcurl\b[^\n|]*\|\s*(sh|bash)\b/i,
  /\bwget\b[^\n|]*\|\s*(sh|bash)\b/i,
  /Invoke-Expression|iex\s/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
];

/** Bounded line diff → added/removed counts + a compact hunk of changed lines. */
function lineDiff(oldStr: string, newStr: string): { added: number; removed: number; hunk: string } {
  const a = oldStr === '' ? [] : oldStr.split('\n');
  const b = newStr === '' ? [] : newStr.split('\n');
  const m = a.length;
  const n = b.length;
  if (m > 3000 || n > 3000 || m * n > 4_000_000) {
    return { added: Math.max(0, n - m), removed: Math.max(0, m - n), hunk: `(large file: ${m} → ${n} lines)` };
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push('-' + a[i]); removed++; i++; }
    else { out.push('+' + b[j]); added++; j++; }
  }
  while (i < m) { out.push('-' + a[i]); removed++; i++; }
  while (j < n) { out.push('+' + b[j]); added++; j++; }
  return { added, removed, hunk: out.slice(0, 300).join('\n') };
}

/** Kill a process AND its children (a foreground `npm start`/`flask run` spawns a tree). */
function killTree(pid?: number): void {
  if (!pid) return;
  if (process.platform === 'win32') exec(`taskkill /pid ${pid} /T /F`, () => {});
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

function runCmd(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ code: number; out: string; err: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let child: ChildProcess;
    const onAbort = (): void => killTree(child?.pid);
    const finish = (r: { code: number; out: string; err: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ...r, timedOut });
    };
    child = exec(command, { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (e, stdout, stderr) => {
      const code = e && typeof e.code === 'number' ? e.code : e ? 1 : 0;
      finish({ code, out: stdout || '', err: stderr || '' });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child?.pid);
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort);
  });
}

export function createTools(deps: ToolDeps): Tool[] {
  const { root } = deps;
  const needsApproval = deps.approveWrites && !deps.autoApprove;

  /** Run a mutating action behind an inline approval card (or a modal fallback). */
  const guarded = async (
    preview: ChangePreview,
    apply: () => Promise<{ message: string; exitCode?: number; output?: string }>,
  ): Promise<string> => {
    if (deps.requestChange) {
      const { approved, id } = await deps.requestChange(preview, needsApproval);
      if (!approved) {
        deps.changeDone?.(id, { rejected: true });
        return 'DENIED by user.';
      }
      try {
        const r = await apply();
        deps.changeDone?.(id, { ok: true, exitCode: r.exitCode, output: r.output });
        return r.message;
      } catch (e) {
        deps.changeDone?.(id, { error: (e as Error).message });
        throw e;
      }
    }
    // Fallback for hosts without a panel.
    if (needsApproval) {
      const detail = preview.command ?? preview.diff ?? preview.path ?? '';
      const title = preview.kind === 'command' ? 'Run command?' : `${preview.kind} ${preview.path}?`;
      const pick = await vscode.window.showWarningMessage(title, { modal: true, detail: detail.slice(0, 2000) }, 'Approve');
      if (pick !== 'Approve') return 'DENIED by user.';
    }
    const r = await apply();
    return r.message;
  };

  const all: Tool[] = [
    {
      name: 'list_dir',
      description: 'List files and folders in a workspace directory. Use "." for the workspace root.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async run(args) {
        const dir = confine(root, String(args['path'] ?? '.'));
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)';
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file in the workspace (truncated at ~60KB).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async run(args) {
        const file = confine(root, String(args['path']));
        const buf = await fs.readFile(file, 'utf8');
        return buf.length > 60_000 ? `${buf.slice(0, 60_000)}\n...[truncated]` : buf;
      },
    },
    {
      name: 'grep',
      description: 'Search workspace files for a case-insensitive regex. Returns up to 100 matches (path:line: text).',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' }, glob: { type: 'string', description: 'optional include glob, e.g. **/*.ts' } },
        required: ['pattern'],
        additionalProperties: false,
      },
      async run(args) {
        let re: RegExp;
        try {
          re = new RegExp(String(args['pattern']), 'i');
        } catch (e) {
          return `Invalid regex: ${(e as Error).message}`;
        }
        const glob = args['glob'] ? String(args['glob']) : '**/*';
        const uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(vscode.Uri.file(root), glob),
          '**/{node_modules,.git,dist,out}/**',
          500,
        );
        const out: string[] = [];
        for (const u of uris) {
          if (out.length >= 100) break;
          let text: string;
          try {
            text = Buffer.from(await vscode.workspace.fs.readFile(u)).toString('utf8');
          } catch {
            continue;
          }
          const rel = path.relative(root, u.fsPath);
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && out.length < 100; i++) {
            const line = lines[i] ?? '';
            if (re.test(line)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
          }
        }
        return out.join('\n') || '(no matches)';
      },
    },
    {
      name: 'create_folder',
      description: 'Create a directory (and parents) in the workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async run(args) {
        const dir = confine(root, String(args['path']));
        const rel = path.relative(root, dir);
        return guarded({ kind: 'folder', path: rel }, async () => {
          await fs.mkdir(dir, { recursive: true });
          deps.log(`created folder ${rel}`);
          return { message: `Created folder ${rel}.` };
        });
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 file in the workspace (creates parent folders). Shows a diff for approval unless in Auto mode.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      async run(args) {
        const file = confine(root, String(args['path']));
        const rel = path.relative(root, file);
        const content = String(args['content']);
        const existed = await fs.access(file).then(() => true).catch(() => false);
        const oldContent = existed ? await fs.readFile(file, 'utf8').catch(() => '') : '';
        const { added, removed, hunk } = lineDiff(oldContent, content);
        const preview: ChangePreview = { kind: existed ? 'edit' : 'create', path: rel, added, removed, diff: hunk };
        return guarded(preview, async () => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, content, 'utf8');
          deps.log(`wrote ${rel} (+${added} -${removed})`);
          return { message: `Wrote ${rel} (+${added} -${removed}).` };
        });
      },
    },
    {
      name: 'run_terminal',
      description:
        'Run a shell command in the workspace root and return exit code, stdout, and stderr. ' +
        'Use for builds/tests, Azure CLI (`az`, `az rest` for Graph), Terraform/Bicep (IaC), and tunnels. ' +
        'For dev servers, tunnels, or any long-lived process set background:true — it starts detached and returns ' +
        'immediately instead of blocking. Foreground commands are killed after 120s. Shown for approval unless in Auto mode.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          background: { type: 'boolean', description: 'Start detached and return immediately (for servers/tunnels/long-lived processes).' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const command = String(args['command']);
        const background = args['background'] === true;
        if (DENY.some((r) => r.test(command))) return 'BLOCKED: command matches a denied pattern.';
        return guarded({ kind: 'command', command }, async () => {
          deps.log(`${background ? 'bg' : 'run'}: ${command}`);
          if (background) {
            const child = spawn(command, { cwd: root, shell: true, detached: true, stdio: 'ignore', windowsHide: true });
            child.unref();
            const pid = child.pid ?? 0;
            return { message: `Started in background (pid ${pid}): ${command}`, exitCode: 0, output: `▶ started detached (pid ${pid})` };
          }
          const { code, out, err, timedOut } = await runCmd(command, root, ctx.signal);
          const note = timedOut ? ' [killed after 120s — use background:true for long-lived commands]' : '';
          const outputPreview = `exit ${code}${note}\n${out.slice(0, 4000)}${err ? `\n[stderr] ${err.slice(0, 2000)}` : ''}`;
          return {
            message: `exit: ${code}${note}\n--- stdout ---\n${out.slice(0, 12000)}\n--- stderr ---\n${err.slice(0, 6000)}`,
            exitCode: code,
            output: outputPreview,
          };
        });
      },
    },
  ];

  return deps.readOnly ? all.filter((t) => READONLY_TOOLS.has(t.name)) : all;
}
