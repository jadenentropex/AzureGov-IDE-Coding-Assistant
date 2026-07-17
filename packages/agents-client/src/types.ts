/**
 * Wire types for the Azure OpenAI Responses API, modeled for a `store=false`
 * (stateless) agent loop. Because we never persist server-side state, the client
 * carries the full running list of input items and resends it each turn — this is
 * the compliance keystone: no CUI-bearing conversation state at rest in Azure.
 */

/** A function tool exposed to the model. Responses API flattens the schema
 *  (name/description/parameters at the top level, unlike Chat Completions). */
export interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

/** Model's request to call a tool (an output item, also fed back as input). */
export interface FunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  /** Raw JSON string of arguments as emitted by the model. */
  arguments: string;
}

/** The locally-produced result for a FunctionCall, fed back to the model. */
export interface FunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

/** A plain conversational message item. */
export interface InputMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string;
}

/** Any item that can appear in the Responses `input` array. */
export type InputItem = InputMessage | FunctionCall | FunctionCallOutput;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** Normalized result of one Responses API call. */
export interface ResponseResult {
  responseId: string;
  status: string;
  /** Concatenated assistant text (empty when the turn is purely tool calls). */
  outputText: string;
  /** Tool calls the model wants executed before it can continue. */
  functionCalls: FunctionCall[];
  usage?: TokenUsage;
  /** Raw response object, for audit/debugging. */
  raw: unknown;
}

/** Streaming callbacks for a single Responses call. */
export interface StreamHandlers {
  /** Incremental assistant text (response.output_text.delta). */
  onText?: (delta: string) => void;
  /** Incremental reasoning-summary text (reasoning models, e.g. gpt-5.1). */
  onThinking?: (delta: string) => void;
  /** Raw SSE event names, for status UI (response.created, ...). */
  onEvent?: (event: string) => void;
}

/** Requests reasoning-summary output on reasoning-capable models. */
export interface ReasoningOptions {
  effort?: 'low' | 'medium' | 'high';
  /** Ask the model to stream a summary of its reasoning. */
  summary?: boolean;
}
