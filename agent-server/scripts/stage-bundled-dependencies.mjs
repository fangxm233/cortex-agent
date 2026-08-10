// input:  package manifest and hoisted workspace dependencies
// output: recoverable dependency staging for npm pack
// pos:    Bridges hoisted installs to bundledDependencies
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageModules = path.join(packageRoot, 'node_modules');
const workspaceModules = path.resolve(packageRoot, '..', 'node_modules');
const marker = path.join(packageModules, '.cortex-bundled-staging.json');
const markerTemporary = `${marker}.tmp`;

function removeEntry(entry) {
  const destination = path.join(packageModules, entry);
  fs.rmSync(destination, { recursive: true, force: true });
  const parent = path.dirname(destination);
  if (parent !== packageModules && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
    fs.rmdirSync(parent);
  }
}

function removeStaged() {
  if (!fs.existsSync(marker)) {
    fs.rmSync(markerTemporary, { force: true });
    return;
  }
  const entries = JSON.parse(fs.readFileSync(marker, 'utf8'));
  for (const entry of entries) removeEntry(entry);
  fs.rmSync(marker, { force: true });
  fs.rmSync(markerTemporary, { force: true });
}

function writeMarker(entries) {
  fs.writeFileSync(markerTemporary, `${JSON.stringify(entries)}\n`);
  fs.renameSync(markerTemporary, marker);
}

function bundledDependencies() {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (!Array.isArray(manifest.bundleDependencies)) {
    throw new Error('package.json bundleDependencies must be an array');
  }
  return manifest.bundleDependencies;
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
  removeStaged();
  fs.mkdirSync(packageModules, { recursive: true });
  const staged = [];
  try {
    writeMarker(staged);
    for (const entry of bundledDependencies()) {
      if (fs.existsSync(path.join(packageModules, entry))) continue;
      staged.push(entry);
      writeMarker(staged);
      copyTree(path.join(workspaceModules, entry), path.join(packageModules, entry));
    }
  } catch (error) {
    removeStaged();
    throw error;
  }
}

if (process.argv.includes('--cleanup')) removeStaged();
else stageDependencies();
