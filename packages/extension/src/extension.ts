import * as vscode from 'vscode';
import { registerChatParticipant } from './chatParticipant';
import { ChatViewProvider } from './chatView';
import { runAsk } from './ask';
import { setApiKey, clearApiKey } from './auth';
import { AuditLog, verifyAuditChain } from './audit';

let statusBar: vscode.StatusBarItem;

export function activate(ctx: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('AzureGov IDE Assistant');
  ctx.subscriptions.push(output);

  registerChatParticipant(ctx, output);

  // Tamper-evident audit log (the sole audit source under store=false).
  const audit = new AuditLog(ctx, output);

  // The dedicated chat panel (activity-bar view): the primary UI.
  const chatProvider = new ChatViewProvider(ctx, output, audit);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('azgovIde.ask', () => runAsk(ctx, output)),
    vscode.commands.registerCommand('azgovIde.setApiKey', () => setApiKey(ctx)),
    vscode.commands.registerCommand('azgovIde.clearApiKey', () => clearApiKey(ctx)),
    vscode.commands.registerCommand('azgovIde.selectModel', selectModel),
    vscode.commands.registerCommand('azgovIde.verifyAudit', async () => {
      const r = await verifyAuditChain(audit.filePath);
      if (r.ok) void vscode.window.showInformationMessage(`Audit log verified: ${r.events} events, hash chain intact.`);
      else void vscode.window.showErrorMessage(`Audit integrity FAILED at event ${r.brokenAt ?? '?'}: ${r.error ?? 'unknown'}`);
    }),
    vscode.commands.registerCommand('azgovIde.openAudit', async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(audit.filePath));
        await vscode.window.showTextDocument(doc);
      } catch {
        void vscode.window.showInformationMessage('No audit log yet - run the agent first.');
      }
    }),
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'azgovIde.selectModel';
  ctx.subscriptions.push(statusBar);
  updateStatusBar();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('azgovIde.model')) updateStatusBar();
    }),
  );

  output.appendLine('AzureGov IDE Assistant activated (Azure OpenAI Responses API, US Gov).');
}

export function deactivate(): void {
  // Disposables are cleaned up via ctx.subscriptions.
}

async function selectModel(): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'gpt-4.1', description: 'Fast workhorse — everyday edits, explain, quick fixes' },
      { label: 'gpt-5.1', description: 'Deep reasoning — complex/multi-file tasks (slower, DataZone)' },
    ],
    { placeHolder: 'Select the Azure OpenAI model (by task complexity)' },
  );
  if (pick) {
    await vscode.workspace.getConfiguration('azgovIde').update('model', pick.label, vscode.ConfigurationTarget.Global);
  }
}

function updateStatusBar(): void {
  const model = vscode.workspace.getConfiguration('azgovIde').get<string>('model', 'gpt-4.1');
  statusBar.text = `$(shield) ${model}`;
  statusBar.tooltip = 'AzureGov IDE model (click to change)';
  statusBar.show();
}
