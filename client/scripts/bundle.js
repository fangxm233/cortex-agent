// Bundle the client into a self-contained ESM artifact (dist/client.mjs) — the update
// artifact the server pushes to devices, no npm install on the device.
//
// dist/cortex-run-watcher.mjs is a COMPATIBILITY STUB. cortex-run was removed, but the
// update package is a fixed, ordered file set validated on BOTH ends: a client installed
// before the removal rejects any package missing that name and can then never auto-update.
// The stub keeps those clients updating. Drop it (here and from BUNDLE_FILES in
// client/src/self-update.ts + agent-server/src/domain/remote/client-hot-reload.ts) once no
// pre-removal client is left in the field.
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
  entryPoints: ['src/client.ts'],
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

// Compatibility stub — see the header note. Not executable code any client should run.
const STUB = [
  '#!/usr/bin/env node',
  '// cortex-run was removed. This file exists only so clients installed before the removal',
  '// accept this update package (the file set is validated by name on both ends).',
  'process.exit(0);',
  '',
].join('\n');
fs.writeFileSync(path.join(pkgRoot, 'dist/cortex-run-watcher.mjs'), STUB);

for (const f of ['dist/client.mjs', 'dist/cortex-run-watcher.mjs']) {
  fs.chmodSync(path.join(pkgRoot, f), 0o755);
}
console.log('Bundled: dist/client.mjs (+ dist/cortex-run-watcher.mjs compatibility stub)');
