import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** Bundle the extension (and the ESM agents-client) into a single CJS file the
 *  VS Code extension host can load. `vscode` is provided by the host at runtime. */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching…');
} else {
  await esbuild.build(options);
  console.log('[esbuild] build complete → dist/extension.js');
}
