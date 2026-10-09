// Runs after tsc as part of `npm run build`.
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { stageClientBundle } from './client-bundle.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(scriptDir, '..');

// Ship the same-checkout client even when publish skips npm lifecycle scripts.
stageClientBundle(pkgRoot);

// --- 1. Shebang injection, for every command package.json `bin` publishes ---

const SHEBANG = '#!/usr/bin/env node\n';
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
for (const rel of Object.values(pkg.bin ?? {})) {
  const abs = path.join(pkgRoot, rel);
  if (!fs.existsSync(abs)) throw new Error(`package.json bin target was not built: ${rel}`);
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
