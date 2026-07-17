/* Test harness: bundle a single src module (vscode external) and require it with a vscode mock. */
const path = require('path');
const os = require('os');
const Module = require('module');

const EXT = path.join(__dirname, '..');
const esbuild = require(path.join(EXT, 'node_modules', 'esbuild'));
const bundleCache = new Map();

function bundle(relSrc) {
  if (bundleCache.has(relSrc)) return bundleCache.get(relSrc);
  // Unique per process (node --test runs test files concurrently) so two files bundling the same
  // module do not race on one temp path and corrupt each other's output.
  const out = path.join(os.tmpdir(), `azgov-test-${process.pid}-${relSrc.replace(/[\\/.]/g, '_')}.cjs`);
  esbuild.buildSync({
    entryPoints: [path.join(EXT, relSrc)],
    bundle: true, platform: 'node', format: 'cjs', external: ['vscode'],
    outfile: out, absWorkingDir: EXT,
  });
  bundleCache.set(relSrc, out);
  return out;
}

/** Load a bundled module with `vscode` resolved to the given mock (default: {}). */
function loadModule(relSrc, vscodeMock) {
  const out = bundle(relSrc);
  const orig = Module._load;
  Module._load = (req, ...rest) => (req === 'vscode' ? (vscodeMock || {}) : orig(req, ...rest));
  try {
    delete require.cache[out];
    return require(out);
  } finally {
    Module._load = orig;
  }
}

/** Minimal vscode mock whose getConfiguration('azgovIde') returns the given settings map. */
function mockConfig(settings) {
  return { workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }) } };
}

module.exports = { loadModule, mockConfig };
