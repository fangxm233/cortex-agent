import fs from 'node:fs';
import path from 'node:path';
import type { FastInstallPlan, SyncTarget } from './fast-install.js';

// Keep this release contract aligned with scripts/bundle.mjs, not the source package manifest.
const RELEASE_FILES = [
  'dist/', 'defaults/', 'web/dist/', 'vendor/', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt',
  'scripts/bundle-prune-browser.mjs', 'scripts/postinstall-restart-trigger.mjs', '!**/*.map',
];
const DIRECTORIES = ['dist', 'defaults', 'web', 'vendor', 'scripts'];
const METADATA = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'package.json'];
const REQUIRED_FILES = [
  'dist/entry/cli.js', 'dist/entry/daemon.js', 'dist/entry/production-app-bootstrap.js',
  'dist/tui/index.js', 'dist/domain/mcp/bundled-server.js', 'dist/agent-adapter/claude/remote-mcp-proxy.js',
  'dist/core/pi-sdk.js', 'dist/domain/auth/cc-auth-cli.js', 'web/dist/index.html',
  'vendor/aistatus/gateway-cli.js', 'vendor/pi/dist/utils/image-resize-worker.js',
  'vendor/pi/dist/utils/image-resize.js', 'vendor/pi/dist/core/extensions/loader.js',
  'vendor/pi-ai/oauth-load.js', 'vendor/pi-ai/bedrock.js', 'vendor/pi/dist/extensions/codemode/execute.js',
  'vendor/pi/dist/codemode-worker.js', 'vendor/quickjs.wasm', 'vendor/pi/package.json',
  'vendor/pi/README.md', 'vendor/pi/CHANGELOG.md',
  'scripts/bundle-prune-browser.mjs', 'scripts/postinstall-restart-trigger.mjs', ...METADATA,
];
const REQUIRED_DIRECTORIES = [
  ...DIRECTORIES, 'web/dist', 'dist/client-bundle', 'vendor/pi/docs', 'vendor/pi/examples',
  'vendor/pi/schemas', 'vendor/pi/dist/modes/interactive/theme', 'vendor/pi/dist/modes/interactive/assets',
  'vendor/pi/dist/core/export-html',
];
const DEPENDENCY_FIELDS = [
  'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'bundleDependencies', 'bundledDependencies',
];
type Manifest = Record<string, unknown>;

export interface BundleInstallDirs {
  stageDir: string;
  installRoot: string;
}

export interface BundleInstallPlan extends FastInstallPlan, BundleInstallDirs {}

function readManifest(file: string): Manifest {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid manifest: ${file}`);
  return value as Manifest;
}

function sameEntries(left: unknown, right: string[]): boolean {
  return Array.isArray(left) && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function checkStageManifest(manifest: Manifest): void {
  if (manifest.name !== '@cortex-agent/server' || manifest.cortexBundle !== true) {
    throw new Error('Invalid bundle stage: expected @cortex-agent/server with cortexBundle:true');
  }
  if (!sameEntries(manifest.files, RELEASE_FILES)) throw new Error('Invalid bundle stage: package.json `files` changed');
}

function stageEntrypoints(manifest: Manifest): string[] {
  const bin = manifest.bin;
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) throw new Error('Invalid bundle stage: missing bin entries');
  const entries = [manifest.main, ...Object.values(bin)];
  for (const entry of entries) checkEntrypoint(entry);
  return entries as string[];
}

function checkEntrypoint(entry: unknown): void {
  if (typeof entry !== 'string') throw new Error('Invalid bundle stage: missing runtime entry');
  if (!entry.startsWith('dist/') || !entry.endsWith('.js') || entry.includes('\\')) {
    throw new Error(`Invalid bundle stage entry: ${entry}`);
  }
  if (entry.split('/').some((part) => part === '..' || part === '.')) throw new Error(`Unsafe stage entry: ${entry}`);
}

function requireType(root: string, name: string, directory: boolean): void {
  const file = path.join(root, name);
  const stat = fs.lstatSync(file);
  const correct = directory ? stat.isDirectory() : stat.isFile();
  if (!correct) throw new Error(`Invalid bundle stage entry (wrong type or symlink): ${file}`);
}

/** Enumerate only regular files. Stage symlinks could alias installed content or escape the release. */
function treeFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return treeFiles(file);
    if (entry.isFile()) return [file];
    throw new Error(`Invalid bundle stage: symlink or special entry: ${file}`);
  });
}

/** Validate all required release inputs before either fast replacement or npm replacement starts. */
export function validateBundleStage(stageDir: string): void {
  if (!stageDir) throw new Error('Bundle stage directory unset');
  const manifest = readManifest(path.join(stageDir, 'package.json'));
  checkStageManifest(manifest);
  for (const name of REQUIRED_DIRECTORIES) requireType(stageDir, name, true);
  for (const name of [...REQUIRED_FILES, ...stageEntrypoints(manifest)]) requireType(stageDir, name, false);
  for (const name of DIRECTORIES) treeFiles(path.join(stageDir, name));
}

/** Resolve existing ancestors too: a not-yet-installed child of a symlink must not evade overlap checks. */
function realLocation(file: string): string {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return missingLocation(absolute);
  }
}

function missingLocation(absolute: string): string {
  if (fs.lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return realLocation(path.resolve(path.dirname(absolute), fs.readlinkSync(absolute)));
  }
  return path.join(realLocation(path.dirname(absolute)), path.basename(absolute));
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function separateRoots(dirs: BundleInstallDirs): BundleInstallDirs {
  if (!dirs.stageDir || !dirs.installRoot) throw new Error('Bundle stage and install roots must be separate and set');
  const stageDir = realLocation(dirs.stageDir);
  const installRoot = realLocation(dirs.installRoot);
  if (contains(stageDir, installRoot) || contains(installRoot, stageDir)) {
    throw new Error('Bundle stage and install roots overlap; separate roots are required');
  }
  return { stageDir, installRoot };
}

// Compare npm dependency declarations, including optional peers and both bundling spellings.
function dependencyFingerprint(manifest: Manifest): string {
  return JSON.stringify(DEPENDENCY_FIELDS.map((field) => {
    const value = manifest[field];
    if (Array.isArray(value)) return [field, [...value].sort()];
    if (value && typeof value === 'object') {
      return [field, Object.entries(value).sort(([a], [b]) => a.localeCompare(b))];
    }
    return [field, value ?? null];
  }));
}

function dependencyReachable(from: string, name: string): boolean {
  let directory = from;
  for (;;) {
    if (fs.existsSync(path.join(directory, 'node_modules', name, 'package.json'))) return true;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function closureError(root: string, stage: Manifest, installed: Manifest): string | null {
  if (dependencyFingerprint(stage) !== dependencyFingerprint(installed)) return 'dependency closure changed';
  const mandatory = Object.keys((stage.dependencies ?? {}) as object);
  const missing = mandatory.find((name) => !dependencyReachable(root, name));
  return missing ? `installed dependency missing: ${missing}` : null;
}

function layoutError(root: string): string | null {
  try {
    for (const name of DIRECTORIES) requireType(root, name, true);
    for (const name of METADATA) requireType(root, name, false);
    return null;
  } catch {
    return 'installed bundle layout is incomplete or incompatible';
  }
}

function installedError(root: string, stage: Manifest): string | null {
  let installed: Manifest;
  try {
    installed = readManifest(path.join(root, 'package.json'));
  } catch {
    return 'no readable installed manifest — full install required';
  }
  if (installed.cortexBundle !== true || installed.name !== '@cortex-agent/server') {
    return 'installed package is not a Cortex bundle — full install required';
  }
  return closureError(root, stage, installed) ?? layoutError(root);
}

function target(dirs: BundleInstallDirs, name: string): SyncTarget {
  return { name, source: path.join(dirs.stageDir, name), destination: path.join(dirs.installRoot, name), exclude: [] };
}

/** Stage/safety errors throw, never suggesting a destructive npm fallback. Only installed mismatch blocks. */
export function planBundleInstall(input: BundleInstallDirs): BundleInstallPlan {
  validateBundleStage(input.stageDir);
  const dirs = separateRoots(input);
  const blocked = installedError(dirs.installRoot, readManifest(path.join(dirs.stageDir, 'package.json')));
  const names = [...DIRECTORIES, ...METADATA.filter((name) => name !== 'package.json')];
  return {
    ...dirs, blocked, targets: blocked ? [] : names.map((name) => target(dirs, name)),
    manifestSource: path.join(dirs.stageDir, 'package.json'),
    manifestDestination: path.join(dirs.installRoot, 'package.json'),
  };
}

interface Replacement {
  destination: string;
  staged: string;
  previous: string;
  movedPrevious: boolean;
  installedNew: boolean;
}

/** Finish *all* copies (including metadata) outside the install root before the first installed rename. */
function prepareReplacements(plan: BundleInstallPlan, workspace: string): Replacement[] {
  fs.mkdirSync(path.join(workspace, 'new'));
  fs.mkdirSync(path.join(workspace, 'old'));
  return [...plan.targets, target(plan, 'package.json')].map((entry) => {
    const staged = path.join(workspace, 'new', entry.name);
    fs.cpSync(entry.source, staged, { recursive: true, dereference: false, errorOnExist: true, force: false });
    return {
      destination: entry.destination, staged, previous: path.join(workspace, 'old', entry.name),
      movedPrevious: false, installedNew: false,
    };
  });
}

function replaceEntry(entry: Replacement): void {
  fs.renameSync(entry.destination, entry.previous);
  entry.movedPrevious = true;
  fs.renameSync(entry.staged, entry.destination);
  entry.installedNew = true;
}

function restoreEntries(entries: Replacement[]): unknown[] {
  const failures: unknown[] = [];
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.installedNew) fs.rmSync(entry.destination, { recursive: true, force: true });
      if (entry.movedPrevious) fs.renameSync(entry.previous, entry.destination);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function installPrepared(entries: Replacement[], workspace: string, warn: (message: string) => void): void {
  try {
    for (const entry of entries) replaceEntry(entry);
  } catch (error) {
    const failures = restoreEntries(entries);
    if (failures.length) {
      // Keep backups available for recovery when the filesystem also refuses rollback.
      throw new AggregateError([error, ...failures], `Bundle rollback incomplete; backups retained at ${workspace}`);
    }
    fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch (error) {
    // Replacement is committed: cleanup must not prevent the caller from restarting the old app.
    warn(`Bundle installed; backup cleanup failed at ${workspace}: ${error}`);
  }
}

/** Replace entire owned directories, never node_modules; metadata are files and package.json is last. */
export function applyBundleInstall(plan: BundleInstallPlan, warn: (message: string) => void = console.warn): string[] {
  if (plan.blocked) throw new Error(`bundle install blocked: ${plan.blocked}`);
  const current = planBundleInstall(plan); // Revalidate in case the stage changed after planning.
  if (current.blocked) throw new Error(`bundle install blocked: ${current.blocked}`);
  const workspace = fs.mkdtempSync(path.join(path.dirname(current.installRoot), '.cortex-bundle-'));
  let entries: Replacement[];
  try {
    entries = prepareReplacements(current, workspace);
  } catch (error) {
    fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
  installPrepared(entries, workspace, warn);
  return current.targets.map((entry) => entry.name);
}

function checkMapDestination(root: string, destination: string): void {
  let current = destination;
  while (current !== root) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Source map destination is a symlink: ${current}`);
    if (stat && (current === destination ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Source map destination has incompatible type: ${current}`);
    }
    current = path.dirname(current);
  }
}

/** npm excludes maps from the tarball; restore only local debugging maps, not any release JS/metadata. */
export function copyBundleSourceMaps(stageDir: string, installRoot: string): void {
  validateBundleStage(stageDir);
  const dirs = separateRoots({ stageDir, installRoot });
  const sources = DIRECTORIES.flatMap((name) => treeFiles(path.join(dirs.stageDir, name))).filter((file) => file.endsWith('.map'));
  // Read all source bytes and validate every destination before writing even the first map.
  const maps = sources.map((source) => {
    const destination = path.join(dirs.installRoot, path.relative(dirs.stageDir, source));
    checkMapDestination(dirs.installRoot, destination);
    return { destination, content: fs.readFileSync(source) };
  });
  for (const { destination, content } of maps) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}
