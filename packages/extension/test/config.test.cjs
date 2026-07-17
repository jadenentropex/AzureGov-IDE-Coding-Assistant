const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, mockConfig } = require('./_harness.cjs');

function withSettings(settings) {
  return loadModule('src/config.ts', mockConfig(settings));
}

const govCfg = { endpoint: 'https://aoai-azgov-ide.openai.azure.us', model: 'gpt-4.1', authMode: 'managed', tenantId: '', store: false, approveWrites: true, costBudgetUsd: 0 };

test('accepts a Gov endpoint and an allowed model', () => {
  const { assertBoundary } = withSettings({ allowedEndpointHosts: [], allowedModels: ['gpt-4.1', 'gpt-5.1'] });
  assert.doesNotThrow(() => assertBoundary(govCfg));
});

test('rejects a commercial / off-boundary endpoint', () => {
  const { assertBoundary } = withSettings({ allowedEndpointHosts: [], allowedModels: [] });
  assert.throws(() => assertBoundary({ ...govCfg, endpoint: 'https://evil.openai.azure.com' }), /not on the allowlist|boundary/i);
});

test('rejects an off-allowlist model', () => {
  const { assertBoundary } = withSettings({ allowedEndpointHosts: [], allowedModels: ['gpt-4.1'] });
  assert.throws(() => assertBoundary({ ...govCfg, model: 'gpt-4o' }), /model .* not on the allowlist/i);
});

test('honors an extra allowed private host', () => {
  const { assertBoundary } = withSettings({ allowedEndpointHosts: ['aoai.privatelink.openai.azure.us'], allowedModels: ['gpt-4.1'] });
  assert.doesNotThrow(() => assertBoundary({ ...govCfg, endpoint: 'https://aoai.privatelink.openai.azure.us' }));
});

test('rejects a malformed endpoint URL', () => {
  const { assertBoundary } = withSettings({ allowedEndpointHosts: [], allowedModels: [] });
  assert.throws(() => assertBoundary({ ...govCfg, endpoint: 'not a url' }), /Invalid/i);
});
