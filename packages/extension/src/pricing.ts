import * as vscode from 'vscode';

/** Price in USD per 1,000,000 tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * Default prices are **estimates** for planning only. Override with your actual
 * Azure Government contract rates via the `azgovIde.pricing` setting, e.g.:
 *   "azgovIde.pricing": { "gpt-4.1": { "input": 2.0, "output": 8.0 } }
 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-5.1': { input: 1.25, output: 10.0 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'gpt-4o': { input: 2.5, output: 10.0 },
};

export function priceFor(model: string): ModelPrice {
  const overrides = vscode.workspace.getConfiguration('azgovIde').get<Record<string, ModelPrice>>('pricing', {});
  return overrides[model] ?? DEFAULT_PRICES[model] ?? { input: 0, output: 0 };
}

/** Cost in USD for a given token split on a model. */
export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export function fmtUsd(n: number): string {
  if (!isFinite(n) || n === 0) return '$0.00';
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(n < 1 ? 3 : 2);
}
