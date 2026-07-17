/**
 * Local tool contract. Tools execute on the developer's workstation (in the VS Code
 * extension: over `vscode.workspace.fs`, terminals, etc.), so source code never leaves
 * the machine — only the model call does. `agents-client` defines the shape; concrete
 * tools are supplied by the host.
 */

export interface ToolContext {
  /** Cancellation from the editor (maps to the chat request's CancellationToken). */
  signal?: AbortSignal;
  /** The model's tool-call id, so the host can correlate progress/results. */
  callId?: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
  /** Execute the tool and return a string result to feed back to the model. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export type ToolRegistry = Map<string, Tool>;

export function toRegistry(tools: Tool[]): ToolRegistry {
  return new Map(tools.map((t) => [t.name, t]));
}
