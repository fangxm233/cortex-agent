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
