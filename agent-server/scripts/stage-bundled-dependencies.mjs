// input:  package manifest, the hoisted workspace node_modules it resolves against
// output: direct bundles and recoverable runtime package asset
// pos:    Stages the runtime closure the workspace actually resolves, for npm pack
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageModules = path.join(packageRoot, 'node_modules');
const workspaceRoot = path.resolve(packageRoot, '..');
const workspaceModules = path.join(workspaceRoot, 'node_modules');
const stagingRoot = path.join(packageRoot, 'bundled-dependencies');
const marker = path.join(packageModules, '.cortex-bundled-staging.json');
const markerTemporary = `${marker}.tmp`;

function readManifest(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
}

function bundledDependencies(manifest) {
  if (!Array.isArray(manifest.bundleDependencies)) {
    throw new Error('package.json bundleDependencies must be an array');
  }
  return manifest.bundleDependencies;
}

/**
 * Locate `name` the way Node does from `fromDirectory`: the nearest enclosing node_modules that
 * holds it, stopping at the workspace root. Returns the link path (not its realpath) so the
 * staged location mirrors where the workspace placed the package.
 */
function resolvePackage(name, fromDirectory) {
  let directory = fromDirectory;
  for (;;) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (directory === workspaceRoot) return null;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Where a resolved package lands under a node_modules root, e.g. `a` or `a/node_modules/b`. */
function stagedLocation(resolved) {
  for (const root of [packageModules, workspaceModules]) {
    const relative = path.relative(root, resolved);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  }
  throw new Error(`${resolved} is outside every node_modules root`);
}

function dependencyRequests(manifest) {
  const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  const requests = [];
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    requests.push({ name, optional: optionalNames.has(name) });
  }
  for (const name of optionalNames) {
    if (!(name in (manifest.dependencies ?? {}))) requests.push({ name, optional: true });
  }
  // Peers are provided by whoever installed the package; when the workspace runs without one, the
  // published package must too, so a missing peer is never an error here.
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    requests.push({ name, optional: true });
  }
  return requests;
}

/**
 * Every package reachable from this manifest's runtime dependencies, resolved exactly as the
 * workspace resolves them. The workspace is what the daemon and the tests run against, so its
 * resolution — not a lockfile's idea of it — is the closure a packaged install must reproduce.
 * Returns staged location → source link path, hoisted entries and nested conflicts alike.
 */
function runtimeClosure() {
  const closure = new Map();
  const visited = new Set();
  const queue = dependencyRequests(readManifest(packageRoot))
    .map((request) => ({ ...request, fromDirectory: packageRoot }));
  while (queue.length > 0) {
    const { name, optional, fromDirectory } = queue.shift();
    const resolved = resolvePackage(name, fromDirectory);
    if (resolved === null) {
      if (optional) continue;
      throw new Error(`workspace node_modules omitted ${name} (required by ${fromDirectory})`);
    }
    const identity = fs.realpathSync(resolved);
    if (visited.has(identity)) continue;
    visited.add(identity);
    closure.set(stagedLocation(resolved), resolved);
    for (const request of dependencyRequests(readManifest(resolved))) {
      queue.push({ ...request, fromDirectory: resolved });
    }
  }
  return closure;
}

function copyTree(source, destination, { skipNestedModules = false } = {}) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    copyTree(fs.realpathSync(source), destination, { skipNestedModules });
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      if (skipNestedModules && entry === 'node_modules') continue;
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

/**
 * npm pack only ships `bundleDependencies` it finds under the package's own node_modules; the
 * hoisted workspace keeps them one level up, so each is copied down for the duration of the pack.
 * The install-time closure sync replaces these copies with the staged ones anyway.
 */
function stageDirectDependencies(manifest) {
  fs.mkdirSync(packageModules, { recursive: true });
  const staged = [];
  writeMarker(staged);
  for (const entry of bundledDependencies(manifest)) {
    if (!(entry in (manifest.dependencies ?? {})) && !(entry in (manifest.optionalDependencies ?? {}))) {
      throw new Error(`package.json dependencies omit bundled ${entry}`);
    }
    const source = resolvePackage(entry, packageRoot);
    if (source === null) {
      if (entry in (manifest.optionalDependencies ?? {})) continue;
      throw new Error(`workspace node_modules omitted ${entry}`);
    }
    if (fs.existsSync(path.join(packageModules, entry))) continue;
    staged.push(entry);
    writeMarker(staged);
    copyTree(source, path.join(packageModules, entry));
  }
}

/**
 * Nested packages are staged at their nested location so a conflicting version keeps shadowing
 * the hoisted one exactly as it does in the workspace; each package is copied without its own
 * node_modules, which the walk stages explicitly only where something reaches them.
 */
function stageRuntimeClosure(closure) {
  for (const [location, source] of [...closure].sort(([a], [b]) => a.localeCompare(b))) {
    copyTree(source, path.join(stagingRoot, location), { skipNestedModules: true });
  }
}

function cleanup() {
  removeDirectStaging();
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

function stageDependencies() {
  cleanup();
  try {
    const manifest = readManifest(packageRoot);
    stageDirectDependencies(manifest);
    stageRuntimeClosure(runtimeClosure());
  } catch (error) {
    cleanup();
    throw error;
  }
}

if (process.argv.includes('--cleanup')) cleanup();
else stageDependencies();
