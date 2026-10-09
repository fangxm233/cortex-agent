import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteSync } from '@core/atomic-write.js';
import { withFileLock } from '@core/file-lock.js';
import { clientBundleHash, loadPackageClientBundle, type PackageClientBundle } from './package-client-bundle.js';
import type { MachineEntry } from './machine-registry.js';

export interface LocalClientPaths { DATA_DIR: string; CONFIG_DIR: string }
export interface LocalClientIntent {
  schema: 1;
  state: 'pending' | 'ready';
  device: string;
  configHash: string;
  bundleHash: string;
}
const STAGE = '.local-install-stage';
const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex');
const clientDir = (paths: LocalClientPaths): string => path.join(paths.DATA_DIR, 'client');
const intentFile = (paths: LocalClientPaths): string => path.join(clientDir(paths), 'local-install.json');
const configFile = (paths: LocalClientPaths): string => path.join(paths.CONFIG_DIR, 'cortex-client.json');

function configText(device: string): string {
  return JSON.stringify({ deviceName: device, serverHost: '127.0.0.1', serverPort: 3002 }, null, 2) + '\n';
}

function assertNotSymlink(file: string): void {
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Local client ownership cannot cover a symlink: ${file}`);
  }
}

export function readLocalClientIntent(paths: LocalClientPaths): LocalClientIntent | null {
  assertNotSymlink(clientDir(paths));
  const file = intentFile(paths);
  assertNotSymlink(file);
  if (!fs.existsSync(file)) return null;
  let intent: LocalClientIntent;
  try { intent = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Invalid local client ownership intent; inspect client/local-install.json'); }
  const valid = intent?.schema === 1 && ['pending', 'ready'].includes(intent.state)
    && typeof intent.device === 'string' && !!intent.device.trim()
    && intent.configHash === fingerprint(configText(intent.device))
    && typeof intent.bundleHash === 'string' && /^[a-f0-9]{64}$/.test(intent.bundleHash);
  if (!valid) throw new Error('Invalid local client ownership intent; inspect client/local-install.json');
  return intent;
}

export function assertLocalClientMachine(paths: LocalClientPaths, entry: MachineEntry | undefined): void {
  const valid = entry && !entry.ssh && !entry.clientCommand && entry.clientConnection !== 'ssh-reverse'
    && typeof entry.cortexPath === 'string' && path.resolve(entry.cortexPath) === path.resolve(paths.DATA_DIR);
  if (!valid) throw new Error('Local client machine conflicts with ownership; keep SSH/custom-command machines externally managed');
}

function validateRegistry(paths: LocalClientPaths, device: string): void {
  const file = path.join(paths.CONFIG_DIR, 'machines.json');
  if (!fs.existsSync(file)) return; // init has not written its registry yet
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertLocalClientMachine(paths, registry[device]);
}

function validateOwnedConfig(paths: LocalClientPaths, intent: LocalClientIntent): void {
  assertNotSymlink(paths.CONFIG_DIR);
  assertNotSymlink(configFile(paths));
  if (!fs.existsSync(configFile(paths))) return;
  if (fingerprint(fs.readFileSync(configFile(paths), 'utf8')) !== intent.configHash) {
    throw new Error('Owned local client config was modified; refusing to overwrite config/cortex-client.json');
  }
}

function assertFresh(paths: LocalClientPaths): void {
  const entries = fs.readdirSync(clientDir(paths)).filter(name => !name.startsWith('local-install.json.mutation-lock'));
  if (entries.length || fs.lstatSync(configFile(paths), { throwIfNoEntry: false })) {
    throw new Error('Unowned local client files/config exist; refusing to adopt or overwrite them');
  }
}

function saveIntent(paths: LocalClientPaths, intent: LocalClientIntent): void {
  atomicWriteSync(intentFile(paths), JSON.stringify(intent, null, 2) + '\n');
}

function validateIntent(paths: LocalClientPaths, intent: LocalClientIntent, device: string): void {
  if (intent.device !== device) throw new Error('Local client ownership belongs to a different device');
  validateRegistry(paths, device);
  validateOwnedConfig(paths, intent);
}

/** Explicit enrollment only. Validate payload before leaving any durable intent. */
export async function beginLocalClientInstall(paths: LocalClientPaths, device: string, installRoot?: string): Promise<void> {
  const bundle = loadPackageClientBundle(installRoot);
  assertNotSymlink(clientDir(paths));
  fs.mkdirSync(clientDir(paths), { recursive: true });
  await withFileLock(intentFile(paths), async () => {
    const existing = readLocalClientIntent(paths);
    if (existing) return validateIntent(paths, existing, device);
    validateRegistry(paths, device);
    assertFresh(paths);
    if (!device.trim()) throw new Error('Local client device must not be empty');
    saveIntent(paths, { schema: 1, state: 'pending', device,
      configHash: fingerprint(configText(device)), bundleHash: bundle.hash });
  });
}

function publishBundle(paths: LocalClientPaths, bundle: PackageClientBundle): void {
  const stage = path.join(clientDir(paths), STAGE);
  assertNotSymlink(stage);
  fs.mkdirSync(stage, { recursive: true });
  for (const file of bundle.files) {
    const destination = path.join(stage, file.name);
    assertNotSymlink(destination);
    atomicWriteSync(destination, Buffer.from(file.data, 'base64').toString('utf8'));
  }
  if (clientBundleHash(stage) !== bundle.hash) throw new Error('Staged local client hash mismatch');
  fs.renameSync(stage, path.join(clientDir(paths), 'current'));
}

function finishInstall(paths: LocalClientPaths, intent: LocalClientIntent, bundle: PackageClientBundle): void {
  const current = path.join(clientDir(paths), 'current');
  assertNotSymlink(current);
  if (fs.existsSync(current)) {
    if (intent.state === 'ready') return; // live updates belong to the existing hot-reload protocol
    if (clientBundleHash(current) !== intent.bundleHash) throw new Error('Pending local client publication hash mismatch');
  } else {
    saveIntent(paths, { ...intent, state: 'pending', bundleHash: bundle.hash });
    publishBundle(paths, bundle);
    intent = { ...intent, bundleHash: bundle.hash };
  }
  saveIntent(paths, { ...intent, state: 'ready' });
}

/** Daemon recovery may complete an existing intent, but must never enroll an ordinary home. */
export async function completeLocalClientInstall(paths: LocalClientPaths, device: string, installRoot?: string): Promise<void> {
  if (!readLocalClientIntent(paths)) throw new Error('Missing local client ownership intent');
  const bundle = loadPackageClientBundle(installRoot);
  await withFileLock(intentFile(paths), async () => {
    const intent = readLocalClientIntent(paths);
    if (!intent) throw new Error('Missing local client ownership intent');
    validateIntent(paths, intent, device);
    if (!fs.existsSync(configFile(paths))) atomicWriteSync(configFile(paths), configText(device));
    finishInstall(paths, intent, bundle);
  });
}
