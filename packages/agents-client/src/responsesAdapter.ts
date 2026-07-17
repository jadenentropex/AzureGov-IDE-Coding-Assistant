import type { AgentBrain, CreateResponseOptions } from './agentBrain.js';
import type { TokenProvider } from './auth.js';
import type { FunctionCall, InputItem, ResponseResult } from './types.js';

export interface ResponsesAdapterConfig {
  /** Gov endpoint base, e.g. https://aoai-azgov-ide.openai.azure.us */
  endpoint: string;
  /** Model deployment name, e.g. gpt-4.1 (Azure uses the DEPLOYMENT name as `model`). */
  deployment: string;
  auth: TokenProvider;
  /** CMMC posture — keep server-side state off. Defaults to false. */
  store?: boolean;
  /** Data-plane path. GA v1 path takes no api-version. */
  apiPath?: string;
}

/**
 * Azure OpenAI Responses API adapter. Verified working in Azure US Government
 * (`*.openai.azure.us`) with function-calling + streaming + store=false.
 * Also works against commercial (`*.openai.azure.com`) unchanged.
 */
export class ResponsesAdapter implements AgentBrain {
  readonly id = 'azure-openai-responses';
  readonly model: string;
  readonly store: boolean;
  private readonly url: string;
  private readonly auth: TokenProvider;

  constructor(cfg: ResponsesAdapterConfig) {
    this.model = cfg.deployment;
    this.store = cfg.store ?? false;
    this.auth = cfg.auth;
    this.url = cfg.endpoint.replace(/\/+$/, '') + (cfg.apiPath ?? '/openai/v1/responses');
  }

  private async headers(extra?: Record<string, string>): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.auth.kind === 'apiKey') h['api-key'] = this.auth.apiKey;
    else h['Authorization'] = `Bearer ${await this.auth.getToken()}`;
    return h;
  }

  /** Wraps the call with a small retry for transient (rate-limit / 5xx / network) failures. */
  async createResponse(input: InputItem[], opts: CreateResponseOptions = {}): Promise<ResponseResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.doCreate(input, opts);
      } catch (e) {
        if (attempt < 2 && !opts.signal?.aborted && isRetryable(e as Error)) {
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  private async doCreate(input: InputItem[], opts: CreateResponseOptions = {}): Promise<ResponseResult> {
    const body: Record<string, unknown> = { model: this.model, store: this.store, input };
    if (opts.instructions) body.instructions = opts.instructions;
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? 'auto';
    }
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.maxOutputTokens != null) body.max_output_tokens = opts.maxOutputTokens;
    if (opts.reasoning) {
      const r: Record<string, unknown> = {};
      if (opts.reasoning.effort) r['effort'] = opts.reasoning.effort;
      if (opts.reasoning.summary) r['summary'] = 'auto';
      body.reasoning = r;
    }

    if (opts.stream) {
      body.stream = true;
      return this.streamResponse(body, opts);
    }

    const res = await fetch(this.url, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`Responses API ${res.status} ${res.statusText}: ${(await res.text().catch(() => '')).slice(0, 800)}`);
    }
    return parseResponse(await res.json());
  }

  private async streamResponse(body: Record<string, unknown>, opts: CreateResponseOptions): Promise<ResponseResult> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: await this.headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Responses API stream ${res.status} ${res.statusText}: ${(await res.text().catch(() => '')).slice(0, 800)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResponse: unknown = null;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;

        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue; // keepalive / partial
        }
        const type = evt['type'] as string | undefined;
        if (type) opts.stream?.onEvent?.(type);
        if (type === 'response.output_text.delta' && typeof evt['delta'] === 'string') {
          opts.stream?.onText?.(evt['delta']);
        } else if (type === 'response.reasoning_summary_text.delta' && typeof evt['delta'] === 'string') {
          opts.stream?.onThinking?.(evt['delta']);
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          finalResponse = evt['response'] ?? finalResponse;
        } else if (type === 'response.failed') {
          const r = evt['response'] as
            | { error?: { code?: string; message?: string }; incomplete_details?: { reason?: string } }
            | undefined;
          const detail =
            r?.error?.message ??
            r?.error?.code ??
            r?.incomplete_details?.reason ??
            'no error detail returned (often a rate/context limit — try /compact or a smaller request)';
          throw new Error(`Responses stream failed: ${detail}`);
        }
      }
    }

    if (!finalResponse) throw new Error('Responses stream ended without response.completed');
    return parseResponse(finalResponse);
  }
}

/** Transient failures worth a quick retry (rate limit, 5xx, network blips). */
function isRetryable(e: Error): boolean {
  const m = e.message ?? '';
  return /\b(429|500|502|503|504)\b/.test(m) || /ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|network/i.test(m);
}

/** Normalize a raw Responses object into a ResponseResult. */
function parseResponse(data: unknown): ResponseResult {
  const d = data as {
    id?: string;
    status?: string;
    output?: Array<Record<string, unknown>>;
    output_text?: string;
    usage?: ResponseResult['usage'];
  };
  const output = d.output ?? [];

  const functionCalls: FunctionCall[] = output
    .filter((i) => i['type'] === 'function_call')
    .map((i) => ({
      type: 'function_call',
      call_id: String(i['call_id']),
      name: String(i['name']),
      arguments: typeof i['arguments'] === 'string' ? (i['arguments'] as string) : '{}',
    }));

  let outputText = '';
  for (const item of output) {
    if (item['type'] !== 'message') continue;
    const content = (item['content'] as Array<Record<string, unknown>>) ?? [];
    for (const c of content) {
      if (c['type'] === 'output_text' && typeof c['text'] === 'string') outputText += c['text'];
    }
  }
  if (!outputText && typeof d.output_text === 'string') outputText = d.output_text;

  return {
    responseId: d.id ?? '',
    status: d.status ?? 'unknown',
    outputText,
    functionCalls,
    usage: d.usage,
    raw: data,
  };
}
