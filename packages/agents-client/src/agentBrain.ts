import type { FunctionTool, InputItem, ReasoningOptions, ResponseResult, StreamHandlers } from './types.js';

/**
 * The agent "brain" abstraction. Today the only implementation is
 * `ResponsesAdapter` (Azure OpenAI Responses API in Gov). A `FoundryAgentAdapter`
 * (Microsoft Foundry Agent Service) can be added behind this same interface without
 * touching the loop, tools, UI, or auth — the classic Assistants API is intentionally
 * NOT implemented (it retires 2026-08-26).
 */
export interface CreateResponseOptions {
  /** System-level guidance (Responses API `instructions`). Resent every call under store=false. */
  instructions?: string;
  tools?: FunctionTool[];
  toolChoice?: 'auto' | 'required' | 'none';
  temperature?: number;
  maxOutputTokens?: number;
  /** Request reasoning-summary output (reasoning models only). */
  reasoning?: ReasoningOptions;
  signal?: AbortSignal;
  /** When present, the call streams and deltas are delivered here. */
  stream?: StreamHandlers;
}

export interface AgentBrain {
  /** Stable id, e.g. 'azure-openai-responses'. */
  readonly id: string;
  /** Deployment/model name, for logs and audit. */
  readonly model: string;
  /** Whether server-side state is persisted (false = CMMC posture, no CUI at rest). */
  readonly store: boolean;
  /** Run one model turn over the given input items. */
  createResponse(input: InputItem[], opts?: CreateResponseOptions): Promise<ResponseResult>;
}
