// Post-build: inject shebang into CLI entry point.
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(scriptDir, '..');

const SHEBANG = '#!/usr/bin/env node\n';
const cliEntryPoints = [
  'dist/client.js',
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
