const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('./_harness.cjs');

const vscodeMock = { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) }, window: {} };
const { createTools } = loadModule('src/tools.ts', vscodeMock);

function askTool(deps) {
  const tools = createTools(Object.assign({ root: process.cwd(), approveWrites: true, log() {} }, deps));
  return tools.find((t) => t.name === 'ask_options');
}

test('ask_options is present and available in read-only (Plan/Review) mode', () => {
  assert.ok(askTool({ readOnly: false, askQuestion: async () => 'x' }), 'present normally');
  assert.ok(askTool({ readOnly: true, askQuestion: async () => 'x' }), 'present in read-only mode');
});

test('ask_options forwards question + options and returns the choice', async () => {
  let seen;
  const t = askTool({ askQuestion: async (q) => { seen = q; return 'Path A'; } });
  const r = await t.run({ question: 'Which route?', options: ['Path A', 'Path B'] }, {});
  assert.match(r, /The user chose: Path A/);
  assert.equal(seen.question, 'Which route?');
  assert.deepEqual(seen.options, ['Path A', 'Path B']);
});

test('ask_options handles the user dismissing (Other left blank)', async () => {
  const t = askTool({ askQuestion: async () => '' });
  const r = await t.run({ question: 'Q', options: ['a'] }, {});
  assert.match(r, /dismissed/i);
});

test('ask_options requires a question', async () => {
  const t = askTool({ askQuestion: async () => 'x' });
  const r = await t.run({ question: '   ', options: ['a'] }, {});
  assert.match(r, /required/i);
});

test('ask_options degrades gracefully with no UI hook', async () => {
  const t = askTool({});
  const r = await t.run({ question: 'Q', options: ['a'] }, {});
  assert.match(r, /best judgment/i);
});
