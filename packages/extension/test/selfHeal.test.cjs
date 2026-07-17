const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('./_harness.cjs');

const vscodeMock = {
  window: {},
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  commands: {},
  Uri: { file: (p) => ({ fsPath: p }) },
};
const { isRecoverableStreamError } = loadModule('src/chatView.ts', vscodeMock);

test('context/rate stream failures trigger self-heal (auto-compact + retry)', () => {
  const recoverable = [
    'Responses stream failed: no error detail returned',
    'This model maximum context length is 128000 tokens',
    'context_length_exceeded',
    'Please reduce the length of the messages',
    'Rate limit reached for gpt-4.1',
    '429 Too Many Requests',
    'Requests to the tokens per min (TPM) limit exceeded',
  ];
  for (const m of recoverable) assert.equal(isRecoverableStreamError(new Error(m)), true, m);
});

test('auth/boundary/config errors surface immediately (no heal)', () => {
  const surface = [
    'No break-glass API key set.',
    'Blocked: endpoint host "evil.openai.azure.com" is not on the allowlist',
    'Invalid azgovIde.endpoint URL: not a url',
    'Open a folder or workspace so the agent has files to work with.',
    'Unknown tool: frobnicate',
  ];
  for (const m of surface) assert.equal(isRecoverableStreamError(new Error(m)), false, m);
});

test('is null-safe', () => {
  assert.equal(isRecoverableStreamError(undefined), false);
  assert.equal(isRecoverableStreamError({}), false);
});
