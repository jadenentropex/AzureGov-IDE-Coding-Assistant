import * as vscode from 'vscode';
import { ResponsesAdapter, runAgentTurn } from '@azgov-ide/agents-client';
import { readConfig } from './config';
import { getTokenProvider } from './auth';
import { createTools } from './tools';

const SYSTEM =
  'You are AzureGov IDE Assistant, a coding agent running entirely inside Azure US Government (CMMC/CUI boundary). ' +
  'Use the tools (list_dir, read_file, grep, write_file, run_terminal) to inspect the local workspace before answering. ' +
  'Prefer minimal, focused edits and explain what you did. Be concise.';

/**
 * Non-chat entry point: an input box that runs the agent loop and streams the
 * answer into an output pane. Works with zero dependency on the VS Code Chat UI,
 * so it's usable even where the Chat view requires a Copilot sign-in.
 */
export async function runAsk(ctx: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('AzureGov IDE: open a folder/workspace first.');
    return;
  }

  const question = await vscode.window.showInputBox({
    prompt: 'Ask the AzureGov coding agent',
    placeHolder: 'e.g. What does src/app.ts do?',
    ignoreFocusOut: true,
  });
  if (!question) return;

  const cfg = readConfig();
  let auth;
  try {
    auth = await getTokenProvider(ctx, cfg);
  } catch (e) {
    void vscode.window.showErrorMessage((e as Error).message);
    return;
  }

  const brain = new ResponsesAdapter({ endpoint: cfg.endpoint, deployment: cfg.model, auth, store: cfg.store });
  const tools = createTools({ root: folder.uri.fsPath, approveWrites: cfg.approveWrites, log: (m) => output.appendLine(m) });

  output.clear();
  output.show(true);
  output.appendLine(`### ${cfg.model}  ·  store=${cfg.store}  ·  auth=${cfg.authMode}`);
  output.appendLine(`> ${question}\n`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `AzureGov agent (${cfg.model})…`, cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        await runAgentTurn({
          brain,
          system: SYSTEM,
          tools,
          userMessage: question,
          stream: true,
          signal: abort.signal,
          onEvent: (e) => {
            if (e.type === 'text_delta') output.append(e.text ?? '');
            else if (e.type === 'tool_call') output.appendLine(`\n  → ${e.tool}(${(e.args ?? '').slice(0, 80)})`);
            else if (e.type === 'tool_result') output.appendLine(`  ← ${(e.result ?? '').split('\n')[0]?.slice(0, 100) ?? ''}`);
            else if (e.type === 'final') output.appendLine('\n\n— done —');
          },
        });
      } catch (e) {
        const msg = (e as Error).message;
        output.appendLine(`\nERROR: ${msg}`);
        void vscode.window.showErrorMessage(`AzureGov IDE: ${msg}`);
      }
    },
  );
}
