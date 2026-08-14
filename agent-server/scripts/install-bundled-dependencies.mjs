// input:  packaged bundled-dependencies asset
// output: synchronized package-local runtime node_modules
// pos:    Packaged runtime closure installer
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(packageRoot, 'bundled-dependencies');
const destinationRoot = path.join(packageRoot, 'node_modules');

function packageEntries() {
  return fs.readdirSync(sourceRoot).flatMap((entry) => {
    if (!entry.startsWith('@')) return [entry];
    return fs.readdirSync(path.join(sourceRoot, entry)).map((name) => path.join(entry, name));
  });
}

function rollbackDependency(staged, previous, destination, hadPrevious) {
  fs.rmSync(staged, { recursive: true, force: true });
  if (!hadPrevious || !fs.existsSync(previous)) return;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(previous, destination);
}

function replaceDependency(source, destination) {
  const suffix = `.cortex-sync-${process.pid}-${Date.now()}`;
  const staged = `${destination}${suffix}.new`;
  const previous = `${destination}${suffix}.old`;
  const hadPrevious = fs.existsSync(destination);
  try {
    fs.cpSync(source, staged, { recursive: true });
    if (hadPrevious) fs.renameSync(destination, previous);
    fs.renameSync(staged, destination);
    if (hadPrevious) fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    rollbackDependency(staged, previous, destination, hadPrevious);
    throw error;
  }
}

function installDependencies() {
  // A source checkout has no pack-time closure asset (it is staged only by
  // prepack); the hoisted workspace install already provides the runtime
  // closure there, so synchronization is only needed for packaged installs.
  if (!fs.existsSync(sourceRoot)) return;
  if (!fs.statSync(sourceRoot).isDirectory()) {
    throw new Error('installed package omitted bundled-dependencies');
  }
  for (const entry of packageEntries()) {
    const destination = path.join(destinationRoot, entry);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    replaceDependency(path.join(sourceRoot, entry), destination);
  }
}

installDependencies();
