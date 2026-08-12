// input:  package manifest, lock and hoisted runtime dependencies
// output: direct bundles and recoverable runtime package asset
// pos:    Stages the locked runtime closure for npm pack
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageModules = path.join(packageRoot, 'node_modules');
const workspaceModules = path.resolve(packageRoot, '..', 'node_modules');
const stagingRoot = path.join(packageRoot, 'bundled-dependencies');
const marker = path.join(packageModules, '.cortex-bundled-staging.json');
const markerTemporary = `${marker}.tmp`;

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
  return dependencies;
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

function writeMarker(entries) {
  fs.writeFileSync(markerTemporary, `${JSON.stringify(entries)}\n`);
  fs.renameSync(markerTemporary, marker);
}

function removeDirectEntry(entry) {
  const destination = path.join(packageModules, entry);
  fs.rmSync(destination, { recursive: true, force: true });
  const parent = path.dirname(destination);
  if (parent !== packageModules && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
    fs.rmdirSync(parent);
  }
}

function removeDirectStaging() {
  if (!fs.existsSync(marker)) {
    fs.rmSync(markerTemporary, { force: true });
    return;
  }
  for (const entry of JSON.parse(fs.readFileSync(marker, 'utf8'))) removeDirectEntry(entry);
  fs.rmSync(marker, { force: true });
  fs.rmSync(markerTemporary, { force: true });
}

function sourceFor(entry, optional) {
  const source = path.join(workspaceModules, entry);
  if (fs.existsSync(source)) return source;
  if (optional) return null;
  throw new Error(`workspace node_modules omitted ${entry}`);
}

function stageDirectDependencies(dependencies) {
  fs.mkdirSync(packageModules, { recursive: true });
  const staged = [];
  writeMarker(staged);
  for (const entry of bundledDependencies()) {
    if (!dependencies.has(entry)) throw new Error(`package-lock.json omitted ${entry}`);
    const source = sourceFor(entry, dependencies.get(entry));
    if (source === null || fs.existsSync(path.join(packageModules, entry))) continue;
    staged.push(entry);
    writeMarker(staged);
    copyTree(source, path.join(packageModules, entry));
  }
}

function stageRuntimeClosure(dependencies) {
  for (const [entry, optional] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) {
    const source = sourceFor(entry, optional);
    if (source !== null) copyTree(source, path.join(stagingRoot, entry));
  }
}

function cleanup() {
  removeDirectStaging();
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

function stageDependencies() {
  cleanup();
  try {
    const dependencies = runtimeDependencies();
    stageDirectDependencies(dependencies);
    stageRuntimeClosure(dependencies);
  } catch (error) {
    cleanup();
    throw error;
  }
}

if (process.argv.includes('--cleanup')) cleanup();
else stageDependencies();
