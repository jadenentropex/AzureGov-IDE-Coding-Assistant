/* Pure-logic tests for the install wizard (no Azure calls). */
const assert = require('assert');
const w = require('../index.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

t('buildParams maps answers and defaults models', () => {
  const p = w.buildParams({ location: 'usgovtexas', namePrefix: 'acme', deployPrivateEndpoint: true, privateEndpointSubnetId: '/sub/net', callerPrincipalId: 'oid1' }).parameters;
  assert.strictEqual(p.location.value, 'usgovtexas');
  assert.strictEqual(p.namePrefix.value, 'acme');
  assert.strictEqual(p.deployPrivateEndpoint.value, true);
  assert.strictEqual(p.privateEndpointSubnetId.value, '/sub/net');
  assert.strictEqual(p.callerPrincipalId.value, 'oid1');
  assert.strictEqual(p.disableLocalAuth.value, true, 'disableLocalAuth defaults true');
  assert.deepStrictEqual(p.deployments.value, w.DEFAULT_MODELS);
});

t('buildParams honors explicit disableLocalAuth=false and custom models', () => {
  const models = [{ name: 'gpt-4.1', version: 'v', sku: 'Standard', capacity: 10 }];
  const p = w.buildParams({ disableLocalAuth: false, models }).parameters;
  assert.strictEqual(p.disableLocalAuth.value, false);
  assert.deepStrictEqual(p.deployments.value, models);
});

t('buildSettings pins CMMC posture and strips trailing slash', () => {
  const s = w.buildSettings({}, { openAiEndpoint: 'https://aoai-x.openai.azure.us/', auditIngestionEndpoint: 'https://dce.ingest.monitor.azure.us', auditDcrImmutableId: 'dcr-1', auditStreamName: 'Custom-AzgovIdeAudit_CL' });
  assert.strictEqual(s['azgovIde.endpoint'], 'https://aoai-x.openai.azure.us');
  assert.strictEqual(s['azgovIde.store'], false);
  assert.strictEqual(s['azgovIde.approveWrites'], true);
  assert.strictEqual(s['azgovIde.auditEnabled'], true);
  assert.strictEqual(s['azgovIde.authMode'], 'managed');
  assert.strictEqual(s['azgovIde.auditDcrImmutableId'], 'dcr-1');
  assert.deepStrictEqual(s['azgovIde.allowedModels'], ['gpt-4.1', 'gpt-5.1']);
  assert.ok(!('azgovIde.commandAllowlist' in s), 'no allowlist key when empty');
});

t('buildSettings adds optional security keys when set', () => {
  const s = w.buildSettings({ commandAllowlist: ['az', 'git'], blockNetworkCommands: true, tenantId: 'tid' }, {});
  assert.deepStrictEqual(s['azgovIde.commandAllowlist'], ['az', 'git']);
  assert.strictEqual(s['azgovIde.blockNetworkCommands'], true);
  assert.strictEqual(s['azgovIde.tenantId'], 'tid');
});

t('mergeSettings preserves existing and overrides collisions', () => {
  const m = w.mergeSettings({ 'editor.fontSize': 14, 'azgovIde.store': true }, { 'azgovIde.store': false });
  assert.strictEqual(m['editor.fontSize'], 14);
  assert.strictEqual(m['azgovIde.store'], false);
});

t('readOutputs flattens az output shape', () => {
  const o = w.readOutputs({ properties: { outputs: { openAiEndpoint: { value: 'https://x' }, auditDcrImmutableId: { value: 'dcr-9' } } } });
  assert.strictEqual(o.openAiEndpoint, 'https://x');
  assert.strictEqual(o.auditDcrImmutableId, 'dcr-9');
});

t('parseArgs reads flags', () => {
  const a = w.parseArgs(['--dry-run', '--config', 'a.json', '--template', 't.bicep']);
  assert.strictEqual(a.dryRun, true);
  assert.strictEqual(a.config, 'a.json');
  assert.strictEqual(a.template, 't.bicep');
});

console.log(`${pass} passed`);
