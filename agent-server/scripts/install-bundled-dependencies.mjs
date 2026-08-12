// input:  packaged bundled-dependencies asset
// output: complete package-local runtime node_modules
// pos:    Installs the vendored runtime closure after npm extraction
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

function installDependencies() {
  // A source checkout has no pack-time closure asset (it is staged only by
  // prepack); the hoisted workspace install already provides the runtime
  // closure there, so the copy is only needed for packaged installs.
  if (!fs.existsSync(sourceRoot)) return;
  if (!fs.statSync(sourceRoot).isDirectory()) {
    throw new Error('installed package omitted bundled-dependencies');
  }
  for (const entry of packageEntries()) {
    const destination = path.join(destinationRoot, entry);
    if (fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(sourceRoot, entry), destination, { recursive: true });
  }
}

installDependencies();
