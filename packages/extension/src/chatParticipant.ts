import * as vscode from 'vscode';
import { ResponsesAdapter, runAgentTurn } from '@azgov-ide/agents-client';
import { readConfig, type ExtConfig } from './config';
import { getTokenProvider } from './auth';
import { createTools } from './tools';

const PARTICIPANT_ID = 'azgov-ide.coder';

function systemPrompt(cfg: ExtConfig, command?: string): string {
  const base =
    'You are AzureGov IDE Assistant, a coding agent running entirely inside Azure US Government (CMMC/CUI boundary). ' +
    'You have tools to inspect and modify the developer\'s local workspace: list_dir, read_file, grep, write_file, run_terminal. ' +
    'Always inspect relevant files with read_file/grep before proposing or making changes. ' +
    'Prefer minimal, focused edits. Explain what you changed and why. Be concise.';
  if (command === 'explain') return `${base}\nThe user wants an explanation. Do not modify files; read what you need and explain clearly.`;
  if (command === 'fix') return `${base}\nThe user wants a fix. Diagnose first (read_file/grep), then apply a minimal edit with write_file and verify if possible.`;
  return base;
}

/** Context about the active editor, prepended so the agent knows what the user is looking at. */
function activeEditorContext(): string {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return '';
  const rel = vscode.workspace.asRelativePath(ed.document.uri);
  const sel = ed.selection;
  let ctx = `[active file: ${rel}]`;
  if (sel && !sel.isEmpty) {
    const text = ed.document.getText(sel);
    ctx += `\n[selection ${sel.start.line + 1}-${sel.end.line + 1}]:\n${text.slice(0, 4000)}`;
  }
  return ctx;
}

function truncate(s: string | undefined, n: number): string {
  const v = s ?? '';
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

export function registerChatParticipant(ctx: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
    const cfg = readConfig();

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      stream.markdown('⚠️ Open a folder or workspace so the agent has files to work with.');
      return;
    }

    let auth;
    try {
      auth = await getTokenProvider(ctx, cfg);
    } catch (e) {
      stream.markdown(`⚠️ ${(e as Error).message}`);
      return;
    }

    const brain = new ResponsesAdapter({ endpoint: cfg.endpoint, deployment: cfg.model, auth, store: cfg.store });
    const tools = createTools({ root: folder.uri.fsPath, approveWrites: cfg.approveWrites, log: (m) => output.appendLine(m) });

    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());

    stream.progress(`${cfg.model} · store=${cfg.store} · ${cfg.authMode}`);
    output.appendLine(`--- turn: model=${cfg.model} store=${cfg.store} auth=${cfg.authMode} cmd=${request.command ?? '(chat)'} ---`);

    const editorCtx = activeEditorContext();
    const userMessage = (editorCtx ? `${editorCtx}\n\n` : '') + request.prompt;

    try {
      await runAgentTurn({
        brain,
        system: systemPrompt(cfg, request.command),
        tools,
        userMessage,
        stream: true,
        signal: abort.signal,
        onEvent: (e) => {
          if (e.type === 'text_delta') stream.markdown(e.text ?? '');
          else if (e.type === 'tool_call') stream.progress(`${e.tool}(${truncate(e.args, 60)})`);
          else if (e.type === 'tool_result') output.appendLine(`← ${e.tool}: ${truncate(e.result, 200)}`);
        },
      });
    } catch (e) {
      const msg = (e as Error).message;
      stream.markdown(`\n\n⚠️ ${msg}`);
      output.appendLine(`ERROR: ${(e as Error).stack ?? msg}`);
      if (/401/.test(msg)) {
        stream.markdown(
          '\n\nAuth failed. For keyless Entra in US Gov, set `microsoft-sovereign-cloud.environment` to `AzureUSGovernment`, ' +
            'or switch `azgovIde.authMode` to `key` and run **AzureGov IDE: Set break-glass API key**.',
        );
      }
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('shield');
  ctx.subscriptions.push(participant);
}
