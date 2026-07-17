import type { AgentBrain } from './agentBrain.js';
import type { InputItem, FunctionTool, ReasoningOptions } from './types.js';
import { toRegistry, type Tool } from './tools.js';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgentEvent {
  type: 'text_delta' | 'thinking_delta' | 'tool_call' | 'tool_result' | 'final' | 'usage' | 'step';
  text?: string;
  tool?: string;
  args?: string;
  result?: string;
  usage?: AgentUsage;
  step?: number;
}

export interface RunAgentOptions {
  brain: AgentBrain;
  /** System instructions (sent as Responses `instructions` each turn). */
  system: string;
  tools: Tool[];
  userMessage: string;
  /** Prior conversation items (client holds state under store=false). */
  history?: InputItem[];
  maxSteps?: number;
  signal?: AbortSignal;
  /** Stream assistant text (and reasoning summary) as it arrives. */
  stream?: boolean;
  /** Request reasoning-summary output (reasoning models only). */
  reasoning?: ReasoningOptions;
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentResult {
  finalText: string;
  /** Full item list (append to history for the next turn). */
  items: InputItem[];
  steps: number;
  /** Summed token usage across every model call in this turn. */
  usage: AgentUsage;
}

/**
 * The agentic loop. Runs model turns until the model stops requesting tools (or
 * maxSteps is hit). Tools execute locally; results feed back as
 * `function_call_output` items. Token usage is summed across every model call so
 * the host can compute per-turn cost.
 */
export async function runAgentTurn(opts: RunAgentOptions): Promise<AgentResult> {
  const toolSchemas: FunctionTool[] = opts.tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const registry = toRegistry(opts.tools);

  const items: InputItem[] = [...(opts.history ?? []), { role: 'user', content: opts.userMessage }];
  const maxSteps = opts.maxSteps ?? 16;

  let inputTokens = 0;
  let outputTokens = 0;
  const finish = (finalText: string, steps: number): AgentResult => {
    const usage: AgentUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
    opts.onEvent?.({ type: 'usage', usage });
    return { finalText, items, steps, usage };
  };

  for (let step = 1; step <= maxSteps; step++) {
    opts.onEvent?.({ type: 'step', step });
    const res = await opts.brain.createResponse(items, {
      instructions: opts.system,
      tools: toolSchemas,
      reasoning: opts.reasoning,
      signal: opts.signal,
      stream: opts.stream
        ? {
            onText: (d) => opts.onEvent?.({ type: 'text_delta', text: d }),
            onThinking: (d) => opts.onEvent?.({ type: 'thinking_delta', text: d }),
          }
        : undefined,
    });

    if (res.usage) {
      inputTokens += res.usage.input_tokens ?? 0;
      outputTokens += res.usage.output_tokens ?? 0;
    }

    for (const fc of res.functionCalls) items.push(fc);

    if (res.functionCalls.length === 0) {
      if (res.outputText) items.push({ role: 'assistant', content: res.outputText });
      opts.onEvent?.({ type: 'final', text: res.outputText });
      return finish(res.outputText, step);
    }

    for (const fc of res.functionCalls) {
      opts.onEvent?.({ type: 'tool_call', tool: fc.name, args: fc.arguments });
      let output: string;
      try {
        const tool = registry.get(fc.name);
        if (!tool) throw new Error(`Unknown tool: ${fc.name}`);
        const args = fc.arguments ? (JSON.parse(fc.arguments) as Record<string, unknown>) : {};
        output = await tool.run(args, { signal: opts.signal, callId: fc.call_id });
      } catch (err) {
        output = `ERROR: ${(err as Error).message}`;
      }
      opts.onEvent?.({ type: 'tool_result', tool: fc.name, result: output });
      items.push({ type: 'function_call_output', call_id: fc.call_id, output });
    }
  }

  return finish('[agent] reached max steps without a final answer.', maxSteps);
}
