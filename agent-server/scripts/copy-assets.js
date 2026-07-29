// input:  compiled CLI files and shipped hook scripts
// output: executable CLI files and copied dist hook assets
// pos:    Post-build setup for package executables and assets
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Runs after tsc as part of `npm run build`.
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(scriptDir, '..');

// --- 1. Shebang injection ---

const SHEBANG = '#!/usr/bin/env node\n';
const cliEntryPoints = [
  'dist/entry/cli.js',
  'dist/entry/hook-cli.js',
  'dist/domain/tasks/system/cortex-run.js',
  'dist/domain/tasks/system/task-cli.js',
];
for (const rel of cliEntryPoints) {
  const abs = path.join(pkgRoot, rel);
  if (!fs.existsSync(abs)) continue;
  const content = fs.readFileSync(abs, 'utf8');
  if (content.startsWith('#!')) continue;
  fs.writeFileSync(abs, SHEBANG + content);
  fs.chmodSync(abs, 0o755);
  console.log(`Shebang injected: ${rel}`);
}

// --- 2. Copy hook scripts from defaults/hooks/ to dist/hooks/ ---
// tsc only compiles .ts files; standalone .mjs hook scripts need explicit copy.

const srcHooksDir = path.join(pkgRoot, 'defaults', 'hooks');
const distHooksDir = path.join(pkgRoot, 'dist', 'hooks');

if (fs.existsSync(srcHooksDir)) {
  fs.mkdirSync(distHooksDir, { recursive: true });
  const files = fs.readdirSync(srcHooksDir);
  for (const file of files) {
    if (!file.endsWith('.mjs')) continue;
    const src = path.join(srcHooksDir, file);
    const dst = path.join(distHooksDir, file);
    fs.copyFileSync(src, dst);
    console.log(`Hook copied: ${src} -> ${dst}`);
  }
}
