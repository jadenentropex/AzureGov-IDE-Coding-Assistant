const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadModule } = require('./_harness.cjs');

const { verifyAuditChain } = loadModule('src/audit.ts', {});
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function writeChain(file, events, { tamper } = {}) {
  let prev = 'GENESIS';
  const lines = events.map((e, i) => {
    const base = { v: 1, ts: `2026-07-17T20:0${i}:00.000Z`, seq: i + 1, sessionId: 's1', type: e.type, actor: { source: 'managed-identity', oid: 'oid1', upn: 'u@x.us' }, host: 'vm', ...(e.fields || {}), prevHash: prev };
    const hash = sha256(JSON.stringify(base) + prev);
    prev = hash;
    return JSON.stringify({ ...base, hash });
  });
  if (tamper) { const ev = JSON.parse(lines[1]); ev.type = 'EVIL'; lines[1] = JSON.stringify(ev); }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

function vscodeMock(settings, gsDir, notes) {
  return {
    workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), workspaceFolders: undefined, openTextDocument: async () => ({}) },
    window: { showTextDocument: async () => ({}), showInformationMessage: async (m) => notes.push(m), showErrorMessage: async (m) => notes.push('ERR:' + m) },
    Uri: { file: (p) => ({ fsPath: p }) },
  };
}

async function run(settings, auditEvents, opts = {}) {
  const gsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
  const auditFile = path.join(gsDir, 'audit.jsonl');
  writeChain(auditFile, auditEvents, opts);
  const notes = [];
  const ev = loadModule('src/evidence.ts', vscodeMock(settings, gsDir, notes));
  const fakeAudit = { filePath: auditFile, verify: () => verifyAuditChain(auditFile) };
  await ev.generateEvidence({ globalStorageUri: { fsPath: gsDir } }, fakeAudit, { appendLine() {} });
  const dir = path.join(gsDir, 'evidence');
  const files = fs.readdirSync(dir);
  const bundle = JSON.parse(fs.readFileSync(path.join(dir, files.find((f) => f.endsWith('.json'))), 'utf8'));
  const md = fs.readFileSync(path.join(dir, files.find((f) => f.endsWith('.md'))), 'utf8');
  return { bundle, md, notes };
}

const COMPLIANT = {
  endpoint: 'https://aoai-azgov-ide.openai.azure.us', model: 'gpt-4.1', authMode: 'managed', store: false,
  approveWrites: true, auditEnabled: true, auditIngestionEndpoint: 'https://dce.ingest.monitor.azure.us',
  allowedModels: ['gpt-4.1', 'gpt-5.1'], allowedEndpointHosts: [], commandAllowlist: ['az', 'git'],
  blockNetworkCommands: true, autoModeAllowTerminal: false,
};
const RISKY = {
  endpoint: 'https://evil.openai.azure.com', model: 'gpt-4.1', authMode: 'key', store: true,
  approveWrites: false, auditEnabled: true, auditIngestionEndpoint: '', allowedModels: [], allowedEndpointHosts: [],
  commandAllowlist: [], blockNetworkCommands: false, autoModeAllowTerminal: true,
};

test('compliant config + valid chain: 12 controls, 0 attention, verified', async () => {
  const { bundle, md, notes } = await run(COMPLIANT, [{ type: 'session_start' }, { type: 'tool_call' }, { type: 'turn' }]);
  assert.equal(bundle.controls.length, 12);
  assert.equal(bundle.summary.attention, 0);
  assert.equal(bundle.audit.integrityVerified, true);
  assert.doesNotMatch(md, /[^\x00-\x7F]/, 'markdown is ASCII-clean');
  assert.equal(notes.length, 1);
});

test('risky config + tampered chain: exactly 7 attention, integrity false', async () => {
  const { bundle } = await run(RISKY, [{ type: 'session_start' }, { type: 'tool_call' }, { type: 'turn' }], { tamper: true });
  assert.equal(bundle.controls.length, 12);
  assert.equal(bundle.summary.attention, 7);
  assert.equal(bundle.audit.integrityVerified, false);
});
