import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  ResponsesAdapter,
  runAgentTurn,
  type InputItem,
  type ReasoningOptions,
  type AgentUsage,
} from '@azgov-ide/agents-client';
import { readConfig } from './config';
import { getTokenProvider } from './auth';
import { createTools, type ChangePreview, type ChangeResult } from './tools';
import { computeCost } from './pricing';

const READONLY_TOOL_NAMES = new Set(['list_dir', 'read_file', 'grep']);

const BASE_SYSTEM =
  'You are AzureGov IDE Assistant, a coding + cloud agent running entirely inside Azure US Government (CMMC/CUI boundary). ' +
  'You can inspect and modify the local workspace and run commands — including Azure CLI (`az`, and `az rest` for Microsoft Graph), ' +
  'Terraform/Bicep for IaC, and opening tunnels (e.g. `az network bastion tunnel`) when the user directs. ' +
  'For dev servers, tunnels, or any long-lived process, call run_terminal with background:true so it starts ' +
  'detached and does NOT block — never run a server in the foreground. ' +
  'Inspect before changing; prefer minimal, focused edits; explain what you did; be concise.';

type Mode = 'ask' | 'plan' | 'auto' | 'review';
const REASONING_MODELS = new Set(['gpt-5.1', 'o3-mini']);

function modeSystem(mode: Mode): string {
  switch (mode) {
    case 'plan':
      return `${BASE_SYSTEM}\n\nPLAN MODE: Do NOT modify anything. Investigate with read-only tools and produce a clear, numbered, step-by-step plan for the user to approve.`;
    case 'auto':
      return `${BASE_SYSTEM}\n\nAUTO MODE: Execute the task end-to-end autonomously, using tools as needed without asking for confirmation. Narrate the actions you take.`;
    case 'review':
      return `${BASE_SYSTEM}\n\nREVIEW MODE: Act as a reviewer. Read the relevant code/changes and report findings (bugs, security, correctness, style), most important first. Do not modify anything.`;
    default:
      return BASE_SYSTEM;
  }
}

function modeToolOpts(mode: Mode): { readOnly: boolean; autoApprove: boolean } {
  if (mode === 'plan' || mode === 'review') return { readOnly: true, autoApprove: false };
  if (mode === 'auto') return { readOnly: false, autoApprove: true };
  return { readOnly: false, autoApprove: false };
}

interface SessionMsg { role: 'user' | 'assistant'; text: string; }
interface Session {
  id: string;
  title: string;
  ts: number;
  model: string;
  inTok: number;
  outTok: number;
  costUsd: number;
  items: InputItem[];
  messages: SessionMsg[];
}

const SESSIONS_KEY = 'azgovIde.sessions';
const ALL_TOKENS_KEY = 'azgovIde.allTokens';
const ALL_USD_KEY = 'azgovIde.allUsd';
const MAX_SESSIONS = 30;

/** The dedicated chat panel — a self-contained webview. Runs the agent loop, streams
 *  responses/thinking, tracks token usage + cost, keeps per-chat history, and
 *  auto-compacts the conversation when it grows large. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'azgovIde.chat';

  private view?: vscode.WebviewView;
  private current: Session = this.freshSession();
  private running = false;
  private abort?: AbortController;
  private approvals = new Map<string, (approved: boolean) => void>();
  private queue: { text: string; mode: Mode }[] = [];

  /** Post an inline change/approval card; resolve when the user decides (or auto). */
  private requestChange = (preview: ChangePreview, needsApproval: boolean): Promise<{ approved: boolean; id: string }> => {
    const id = `chg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    if (!needsApproval) {
      this.post({ type: 'change', id, preview });
      return Promise.resolve({ approved: true, id });
    }
    this.post({ type: 'approvalRequest', id, preview });
    return new Promise((resolve) => this.approvals.set(id, (approved) => resolve({ approved, id })));
  };

  private changeDone = (id: string, result: ChangeResult): void => {
    this.post({ type: 'changeResult', id, result });
  };

  private clearApprovals(): void {
    this.approvals.forEach((resolve) => resolve(false));
    this.approvals.clear();
  }

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('azgovIde.model')) this.post({ type: 'model', name: readConfig().model });
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.ctx.extensionUri] };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  private freshSession(): Session {
    return {
      id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      title: '',
      ts: Date.now(),
      model: readConfig().model,
      inTok: 0,
      outTok: 0,
      costUsd: 0,
      items: [],
      messages: [],
    };
  }

  private post(m: Record<string, unknown>): void {
    void this.view?.webview.postMessage(m);
  }

  private async onMessage(m: { type: string; text?: string; mode?: Mode; id?: string }): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'model', name: readConfig().model });
        this.postTotals();
        break;
      case 'ask': {
        const text = m.text ?? '';
        const mode = (m.mode ?? 'ask') as Mode;
        if (this.running && text.trim() && text.trim().toLowerCase() !== '/compact') {
          this.queue.push({ text, mode });
          this.post({ type: 'queued', text });
        } else {
          await this.handleAsk(text, mode);
        }
        break;
      }
      case 'cancel':
        this.abort?.abort();
        this.clearApprovals();
        this.queue = [];
        this.post({ type: 'queueCleared' });
        break;
      case 'approvalResponse': {
        const resolve = this.approvals.get(m.id ?? '');
        if (resolve) {
          this.approvals.delete(m.id ?? '');
          resolve(!!(m as { approved?: boolean }).approved);
        }
        break;
      }
      case 'newChat':
        this.abort?.abort();
        this.clearApprovals();
        this.queue = [];
        await this.saveCurrent();
        this.current = this.freshSession();
        this.post({ type: 'cleared' });
        this.postTotals();
        break;
      case 'selectModel':
        await vscode.commands.executeCommand('azgovIde.selectModel');
        this.post({ type: 'model', name: readConfig().model });
        break;
      case 'setKey':
        await vscode.commands.executeCommand('azgovIde.setApiKey');
        break;
      case 'getHistory':
        this.postHistory();
        break;
      case 'loadSession':
        await this.loadSession(m.id ?? '');
        break;
    }
  }

  private async handleAsk(text: string, mode: Mode): Promise<void> {
    if (this.running || !text.trim()) return;

    // Manual compaction command.
    if (text.trim().toLowerCase() === '/compact') {
      this.running = true;
      this.post({ type: 'userMessage', text });
      try {
        await this.compact('manual');
      } finally {
        this.running = false;
        this.post({ type: 'done' });
      }
      return;
    }

    const cfg = readConfig();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: 'error', message: 'Open a folder or workspace so the agent has files to work with.' });
      return;
    }

    let auth;
    try {
      auth = await getTokenProvider(this.ctx, cfg);
    } catch (e) {
      this.post({ type: 'needKey', message: (e as Error).message });
      return;
    }

    this.running = true;
    this.abort = new AbortController();

    // Auto-compact before the turn if the context has grown large.
    const threshold = vscode.workspace.getConfiguration('azgovIde').get<number>('autoCompactTokens', 100000);
    if (threshold > 0 && estimateTokens(this.current.items) > threshold) {
      await this.compact('auto');
    }

    this.post({ type: 'userMessage', text });
    this.post({ type: 'assistantStart' });
    this.current.messages.push({ role: 'user', text });
    if (!this.current.title) this.current.title = text.slice(0, 60);
    this.output.appendLine(`--- chat turn: model=${cfg.model} mode=${mode} store=${cfg.store} auth=${cfg.authMode} ---`);

    const brain = new ResponsesAdapter({ endpoint: cfg.endpoint, deployment: cfg.model, auth, store: cfg.store });
    const tOpts = modeToolOpts(mode);
    const tools = createTools({
      root: folder.uri.fsPath,
      approveWrites: cfg.approveWrites,
      autoApprove: tOpts.autoApprove,
      readOnly: tOpts.readOnly,
      log: (msg) => this.output.appendLine(msg),
      requestChange: this.requestChange,
      changeDone: this.changeDone,
    });
    const reasoning: ReasoningOptions | undefined = REASONING_MODELS.has(cfg.model)
      ? { summary: true, effort: 'medium' }
      : undefined;

    try {
      const result = await runAgentTurn({
        brain,
        system: modeSystem(mode),
        tools,
        userMessage: text,
        history: this.current.items,
        stream: true,
        reasoning,
        signal: this.abort.signal,
        onEvent: (e) => {
          if (e.type === 'text_delta') this.post({ type: 'delta', text: e.text });
          else if (e.type === 'thinking_delta') this.post({ type: 'thinking', text: e.text });
          else if (e.type === 'tool_call') {
            // Mutating tools render as rich change/approval cards (via requestChange); only show a
            // plain line for read-only tools here.
            if (READONLY_TOOL_NAMES.has(e.tool ?? '')) this.post({ type: 'tool', tool: e.tool, args: e.args });
          } else if (e.type === 'tool_result') this.output.appendLine(`  <- ${e.tool}: ${(e.result ?? '').slice(0, 200)}`);
        },
      });

      this.current.items = result.items;
      this.current.model = cfg.model;
      const turnCost = await this.applyUsage(cfg.model, result.usage);
      this.current.messages.push({ role: 'assistant', text: result.finalText });
      await this.saveCurrent();

      this.post({
        type: 'cost',
        turn: { input: result.usage.inputTokens, output: result.usage.outputTokens, total: result.usage.totalTokens, usd: turnCost },
        session: { input: this.current.inTok, output: this.current.outTok, total: this.current.inTok + this.current.outTok, usd: this.current.costUsd },
        allTime: { total: this.ctx.globalState.get<number>(ALL_TOKENS_KEY, 0), usd: this.ctx.globalState.get<number>(ALL_USD_KEY, 0) },
      });
      this.post({ type: 'done' });
    } catch (e) {
      if (this.abort?.signal.aborted) {
        this.post({ type: 'status', text: 'Stopped.' });
        this.post({ type: 'done' });
      } else {
        this.post({ type: 'error', message: (e as Error).message });
        this.output.appendLine(`ERROR: ${(e as Error).stack ?? (e as Error).message}`);
      }
    } finally {
      this.running = false;
      this.clearApprovals();
      this.drainQueue();
    }
  }

  /** After a turn ends, run the next queued message (added while the agent was busy). */
  private drainQueue(): void {
    if (!this.running && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) void this.handleAsk(next.text, next.mode);
    }
  }

  /** Summarize the conversation into a compact seed, freeing context (and cost). */
  private async compact(reason: 'auto' | 'manual'): Promise<void> {
    if (this.current.items.length < 4) {
      this.post({ type: 'status', text: 'Not enough conversation to compact yet.' });
      return;
    }
    const cfg = readConfig();
    let auth;
    try {
      auth = await getTokenProvider(this.ctx, cfg);
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
      return;
    }
    this.post({ type: 'status', text: reason === 'auto' ? 'Context is large — auto-compacting…' : 'Compacting conversation…' });
    const brain = new ResponsesAdapter({ endpoint: cfg.endpoint, deployment: cfg.model, auth, store: cfg.store });
    const transcript = this.current.items.map(itemToText).filter((s) => s).join('\n\n');
    try {
      const res = await brain.createResponse(
        [
          {
            role: 'user',
            content:
              'Summarize this coding-agent conversation so work can continue seamlessly. Capture the user goal, ' +
              'decisions, files created/edited (with paths), commands run and outcomes, and any open TODOs. ' +
              `Be complete but concise (under 500 words).\n\n===\n${transcript}`,
          },
        ],
        { instructions: 'You compress conversations so an agent can continue without losing context.', maxOutputTokens: 1500, signal: this.abort?.signal },
      );
      if (res.usage) {
        await this.applyUsage(cfg.model, {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          totalTokens: res.usage.total_tokens,
        });
      }
      const summary = res.outputText || '(summary unavailable)';
      this.current.items = [{ role: 'assistant', content: `[Earlier conversation compacted]\n${summary}` }];
      await this.saveCurrent();
      this.post({ type: 'compacted', summary });
      this.postTotals();
    } catch (e) {
      this.post({ type: 'error', message: 'Compaction failed: ' + (e as Error).message });
    }
  }

  private async applyUsage(model: string, usage: AgentUsage): Promise<number> {
    this.current.inTok += usage.inputTokens;
    this.current.outTok += usage.outputTokens;
    const turnCost = computeCost(model, usage.inputTokens, usage.outputTokens);
    this.current.costUsd += turnCost;
    const allTok = this.ctx.globalState.get<number>(ALL_TOKENS_KEY, 0) + usage.totalTokens;
    const allUsd = this.ctx.globalState.get<number>(ALL_USD_KEY, 0) + turnCost;
    await this.ctx.globalState.update(ALL_TOKENS_KEY, allTok);
    await this.ctx.globalState.update(ALL_USD_KEY, allUsd);
    return turnCost;
  }

  private postTotals(): void {
    this.post({
      type: 'cost',
      session: { input: this.current.inTok, output: this.current.outTok, total: this.current.inTok + this.current.outTok, usd: this.current.costUsd },
      allTime: { total: this.ctx.globalState.get<number>(ALL_TOKENS_KEY, 0), usd: this.ctx.globalState.get<number>(ALL_USD_KEY, 0) },
    });
  }

  private async saveCurrent(): Promise<void> {
    if (this.current.messages.length === 0) return;
    const sessions = this.ctx.globalState.get<Session[]>(SESSIONS_KEY, []);
    const idx = sessions.findIndex((s) => s.id === this.current.id);
    if (idx >= 0) sessions.splice(idx, 1);
    sessions.unshift(this.current);
    await this.ctx.globalState.update(SESSIONS_KEY, sessions.slice(0, MAX_SESSIONS));
  }

  private postHistory(): void {
    const sessions = this.ctx.globalState.get<Session[]>(SESSIONS_KEY, []);
    this.post({
      type: 'history',
      items: sessions.map((s) => ({ id: s.id, title: s.title || '(untitled)', ts: s.ts, model: s.model, total: s.inTok + s.outTok, usd: s.costUsd })),
    });
  }

  private async loadSession(id: string): Promise<void> {
    const sessions = this.ctx.globalState.get<Session[]>(SESSIONS_KEY, []);
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    await this.saveCurrent();
    this.current = s;
    this.post({ type: 'loadSession', messages: s.messages, model: s.model });
    this.postTotals();
  }

  private getHtml(): string {
    const nonce = getNonce();
    const file = path.join(this.ctx.extensionPath, 'media', 'chat.html');
    return readFileSync(file, 'utf8').replace(/{{nonce}}/g, nonce);
  }
}

/** Rough token estimate (~4 chars/token) for the auto-compact trigger. */
function estimateTokens(items: InputItem[]): number {
  let chars = 0;
  for (const it of items) {
    if ('role' in it) chars += (it.content ?? '').length;
    else if (it.type === 'function_call') chars += (it.arguments ?? '').length + 40;
    else chars += it.output.length;
  }
  return Math.ceil(chars / 4);
}

function itemToText(it: InputItem): string {
  if ('role' in it) return `${it.role}: ${it.content ?? ''}`;
  if (it.type === 'function_call') return `assistant -> ${it.name}(${(it.arguments ?? '').slice(0, 300)})`;
  return `tool result: ${it.output.slice(0, 500)}`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
