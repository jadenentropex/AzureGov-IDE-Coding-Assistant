const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('./_harness.cjs');

const { verifyAuditChain, sha256, decodeTokenIdentity } = loadModule('src/audit.ts', {});

// Build a valid chain the same way AuditLog.append does. Returns the tip {lastHash, seq}.
function writeChain(file, events, { tamper } = {}) {
  let prev = 'GENESIS';
  const lines = events.map((e, i) => {
    const base = { v: 1, ts: `2026-07-17T20:0${i}:00.000Z`, seq: i + 1, sessionId: 's1', type: e.type, actor: { source: 'managed-identity', oid: 'oid1' }, host: 'vm', ...(e.fields || {}), prevHash: prev };
    const hash = sha256(JSON.stringify(base) + prev);
    prev = hash;
    return JSON.stringify({ ...base, hash });
  });
  const tip = { lastHash: prev, seq: lines.length };
  if (tamper === 'edit') { const ev = JSON.parse(lines[1]); ev.type = 'EVIL'; lines[1] = JSON.stringify(ev); }
  if (tamper === 'delete') lines.splice(1, 1);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return tip;
}

function tmp() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'audit.jsonl'); }

test('valid chain verifies', async () => {
  const f = tmp();
  writeChain(f, [{ type: 'session_start' }, { type: 'tool_call' }, { type: 'turn' }]);
  assert.deepEqual(await verifyAuditChain(f), { ok: true, events: 3 });
});

test('an edited event is detected (hash mismatch)', async () => {
  const f = tmp();
  writeChain(f, [{ type: 'session_start' }, { type: 'tool_call' }, { type: 'turn' }], { tamper: 'edit' });
  const r = await verifyAuditChain(f);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 2);
});

test('a deleted event is detected (prevHash mismatch)', async () => {
  const f = tmp();
  writeChain(f, [{ type: 'session_start' }, { type: 'tool_call' }, { type: 'turn' }], { tamper: 'delete' });
  const r = await verifyAuditChain(f);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 2);
});

test('tail-truncation is detected with the persisted tip anchor', async () => {
  const f = tmp();
  const tip = writeChain(f, [{ type: 'session_start' }, { type: 'tool_call' }, { type: 'turn' }]);
  // Remove the last event line (erasing recent records).
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
  fs.writeFileSync(f, lines.slice(0, 2).join('\n') + '\n', 'utf8');
  // Without the anchor, a truncated chain still looks internally consistent (documents the limit).
  assert.equal((await verifyAuditChain(f)).ok, true);
  // With the anchor, the missing tail is caught.
  const r = await verifyAuditChain(f, tip);
  assert.equal(r.ok, false);
  assert.match(r.error, /truncat|count/i);
});

test('a full rewrite that omits an event is detected with the anchor', async () => {
  const f = tmp();
  const tip = writeChain(f, [{ type: 'session_start' }, { type: 'evil_tool' }, { type: 'turn' }]);
  // Rewrite from genesis omitting the evil event, recomputing all hashes (trivial without a key).
  writeChain(f, [{ type: 'session_start' }, { type: 'turn' }]);
  assert.equal((await verifyAuditChain(f)).ok, true); // internally valid
  const r = await verifyAuditChain(f, tip); // but the tip no longer matches
  assert.equal(r.ok, false);
});

test('decodeTokenIdentity extracts managed-identity claims', () => {
  const claims = { oid: 'obj-1', tid: 'tenant-1', xms_mirid: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/virtualMachines/vm' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
  const token = ['h', b64(claims), 'sig'].join('.');
  const actor = decodeTokenIdentity(token);
  assert.equal(actor.source, 'managed-identity');
  assert.equal(actor.oid, 'obj-1');
  assert.equal(actor.tid, 'tenant-1');
});

test('decodeTokenIdentity is safe on garbage', () => {
  assert.equal(decodeTokenIdentity('not-a-jwt').source, 'unknown');
});
