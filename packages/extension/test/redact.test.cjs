const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, mockConfig } = require('./_harness.cjs');

const { redactSecrets, redactIfEnabled } = loadModule('src/redact.ts', {});

test('masks bearer tokens', () => {
  const r = redactSecrets('Authorization: Bearer eyabc.def.ghiJKLmnop1234567890XYZ');
  assert.match(r, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(r, /ghiJKLmnop/);
});

test('masks JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const r = redactSecrets('token=' + jwt);
  assert.match(r, /\[REDACTED JWT\]|\[REDACTED\]/);
  assert.doesNotMatch(r, /SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV/);
});

test('masks credentials embedded in a URL', () => {
  const r = redactSecrets('git remote add o https://user:supersecretpat@github.com/x/y.git');
  assert.match(r, /user:\[REDACTED\]@github\.com/);
  assert.doesNotMatch(r, /supersecretpat/);
});

test('masks --password style flags but keeps the command visible', () => {
  const r = redactSecrets('az login --username u --password Hunter2Hunter2');
  assert.match(r, /az login/);
  assert.match(r, /--password \[REDACTED\]/);
  assert.doesNotMatch(r, /Hunter2Hunter2/);
});

test('masks key=value secrets', () => {
  const r = redactSecrets('api_key="abcdefghij1234567890" other=fine');
  assert.match(r, /api_key[":=\s]+\[REDACTED\]/);
  assert.doesNotMatch(r, /abcdefghij1234567890/);
  assert.match(r, /other=fine/);
});

test('masks private keys, AWS keys, storage AccountKey, and SAS sig', () => {
  assert.match(redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----'), /\[REDACTED PRIVATE KEY\]/);
  assert.match(redactSecrets('id=AKIAIOSFODNN7EXAMPLE'), /\[REDACTED AWS KEY\]/);
  assert.match(redactSecrets('DefaultEndpointsProtocol=https;AccountKey=abc123def456==;'), /AccountKey=\[REDACTED\]/);
  assert.match(redactSecrets('https://x.blob.core.windows.net/c?sig=aB3%2Fxyz1234567890abcdef'), /sig=\[REDACTED\]/);
});

test('leaves ordinary text alone', () => {
  const s = 'function build() { return 42; } // no secrets here';
  assert.equal(redactSecrets(s), s);
});

test('redactIfEnabled honors the setting', () => {
  const secret = 'password=SuperSecret123';
  const off = loadModule('src/redact.ts', mockConfig({ redactSecrets: false }));
  assert.equal(off.redactIfEnabled(secret), secret);
  const on = loadModule('src/redact.ts', mockConfig({ redactSecrets: true }));
  assert.match(on.redactIfEnabled(secret), /password=\[REDACTED\]/);
});
