// input:  package lock and hoisted runtime dependencies
// output: recoverable bundled-dependencies package asset
// pos:    Stages the locked runtime closure for npm pack
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceModules = path.resolve(packageRoot, '..', 'node_modules');
const stagingRoot = path.join(packageRoot, 'bundled-dependencies');

function packageName(location) {
  const parts = location.slice('node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function runtimeDependencies() {
  const lock = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package-lock.json'), 'utf8'));
  const dependencies = new Map();
  for (const [location, metadata] of Object.entries(lock.packages ?? {})) {
    if (!location.startsWith('node_modules/') || metadata.dev === true) continue;
    const name = packageName(location);
    const optional = metadata.optional === true;
    dependencies.set(name, (dependencies.get(name) ?? true) && optional);
  }
  return [...dependencies].sort(([left], [right]) => left.localeCompare(right));
}

function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    copyTree(fs.realpathSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
}

function stageDependencies() {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  try {
    for (const [entry, optional] of runtimeDependencies()) {
      const source = path.join(workspaceModules, entry);
      if (!fs.existsSync(source)) {
        if (optional) continue;
        throw new Error(`workspace node_modules omitted ${entry}`);
      }
      copyTree(source, path.join(stagingRoot, entry));
    }
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv.includes('--cleanup')) {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
} else {
  stageDependencies();
}
