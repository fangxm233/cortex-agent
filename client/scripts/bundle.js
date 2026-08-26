// Bundle the client into self-contained ESM artifacts (dist/client.mjs +
// dist/cortex-run-watcher.mjs). These two files are the complete update artifact
// the server pushes to devices — no npm install on the device.
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The createRequire shim lets bundled CJS deps (ws) require node builtins and
// probe optional native addons (bufferutil / utf-8-validate) at runtime.
const banner = [
  '#!/usr/bin/env node',
  'import { createRequire as __cortexCreateRequire } from "node:module";',
  'const require = __cortexCreateRequire(import.meta.url);',
].join('\n');

await build({
  entryPoints: ['src/client.ts', 'src/cortex-run-watcher.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: banner },
  logLevel: 'warning',
  absWorkingDir: pkgRoot,
});

for (const f of ['dist/client.mjs', 'dist/cortex-run-watcher.mjs']) {
  fs.chmodSync(path.join(pkgRoot, f), 0o755);
}
console.log('Bundled: dist/client.mjs, dist/cortex-run-watcher.mjs');
