// input:  package node_modules and pnpm's hoisted workspace dependency tree
// output: temporary package-local dependency copies that npm pack bundles, then removes
// pos:    Prepack bridge from the hoisted workspace layout to npm bundledDependencies
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageModules = path.join(packageRoot, 'node_modules');
const workspaceModules = path.resolve(packageRoot, '..', 'node_modules');
const marker = path.join(packageModules, '.cortex-bundled-staging.json');

function removeStaged() {
  if (!fs.existsSync(marker)) return;
  const entries = JSON.parse(fs.readFileSync(marker, 'utf8'));
  for (const entry of entries) {
    fs.rmSync(path.join(packageModules, entry), { recursive: true, force: true });
  }
  fs.rmSync(marker, { force: true });
}

function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    copyTree(fs.realpathSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination);
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
}

if (process.argv.includes('--cleanup')) {
  removeStaged();
} else {
  removeStaged();
  fs.mkdirSync(packageModules, { recursive: true });
  const staged = [];
  for (const entry of fs.readdirSync(workspaceModules)) {
    if (entry.startsWith('.') || fs.existsSync(path.join(packageModules, entry))) continue;
    copyTree(path.join(workspaceModules, entry), path.join(packageModules, entry));
    staged.push(entry);
  }
  fs.writeFileSync(marker, `${JSON.stringify(staged)}\n`);
}
