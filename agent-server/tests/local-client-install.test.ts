import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { OwnedLocalLaunchGate } from '../src/domain/remote/owned-local-launch.js';
import { loadPackageClientBundle } from '../src/domain/remote/package-client-bundle.js';
import { beginLocalClientInstall, completeLocalClientInstall, markLocalClientLaunchAttempted, readLocalClientIntent } from '../src/domain/remote/local-client-install.js';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let root: string;
let paths: { DATA_DIR: string; CONFIG_DIR: string };
let installRoot: string;
const names = ['client.mjs', 'cortex-run-watcher.mjs'];
function payload(tag = 'one'): string {
  const dir = path.join(installRoot, 'dist/client-bundle');
  fs.mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256');
  for (const name of names) {
    const data = `// ${tag} ${name}\n`;
    fs.writeFileSync(path.join(dir, name), data);
    hash.update(data);
  }
  const digest = hash.digest('hex');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '1.2.3', hash: digest, source: 'unknown' }));
  return digest;
}
function writeConfig(name: string, data: unknown): void {
  fs.mkdirSync(paths.CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(paths.CONFIG_DIR, name), JSON.stringify(data));
}
beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-local-test-'));
  paths = { DATA_DIR: path.join(root, 'custom-home'), CONFIG_DIR: path.join(root, 'custom-home/config') };
  installRoot = path.join(root, 'package');
  payload();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('package loader verifies the exact manifest and ordered byte hash', () => {
  expect(loadPackageClientBundle(installRoot).hash).toBe(payload());
  fs.appendFileSync(path.join(installRoot, 'dist/client-bundle/client.mjs'), 'tampered');
  expect(() => loadPackageClientBundle(installRoot)).toThrow(/hash/i);
});
test('missing payload cannot create enrollment intent', async () => {
  fs.unlinkSync(path.join(installRoot, 'dist/client-bundle/cortex-run-watcher.mjs'));
  await expect(beginLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow();
  expect(fs.existsSync(path.join(paths.DATA_DIR, 'client/local-install.json'))).toBe(false);
});
async function interruptFirstIntent(): Promise<string> {
  const marker = path.join(paths.DATA_DIR, 'client/local-install.json');
  let temporary = '';
  vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
    expect(to).toBe(marker);
    expect(fs.statSync(`${marker}.mutation-lock`).isDirectory()).toBe(true);
    temporary = String(from);
    expect(path.basename(temporary)).toMatch(/^local-install\.json\.tmp\.[1-9]\d*\.\d+\.[a-z0-9]{0,6}$/);
    expect(JSON.parse(fs.readFileSync(temporary, 'utf8')).state).toBe('pending');
    throw new Error('interrupted before first intent rename');
  });
  await expect(beginLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow(/interrupted/);
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(path.join(paths.CONFIG_DIR, 'cortex-client.json'))).toBe(false);
  expect(fs.existsSync(path.join(paths.DATA_DIR, 'client/current'))).toBe(false);
  return temporary;
}
test('first intent rename interruption can retry without adopting or deleting the leftover temp', async () => {
  const temporary = await interruptFirstIntent();
  const leftover = '{"device":"not-local","untrusted":"not an intent"}';
  fs.writeFileSync(temporary, leftover);
  await beginLocalClientInstall(paths, 'local', installRoot);
  await completeLocalClientInstall(paths, 'local', installRoot);
  expect(readLocalClientIntent(paths)).toMatchObject({ state: 'ready', device: 'local' });
  expect(fs.readFileSync(temporary, 'utf8')).toBe(leftover);
});
test.each(['foreign.txt', 'local-install.json.tmp.1.123.abcdef.extra', 'local-install.json.tmp.pid.123.abcdef',
  'local-install.json.tmp.1.123.abcdefg', 'local-install.json.tmp.1.123.ABCDEF', 'config', 'current', 'marker'])
('interrupted first intent still preserves and refuses foreign %s', async kind => {
  const temporary = await interruptFirstIntent();
  const bytes = fs.readFileSync(temporary, 'utf8');
  const foreign = kind === 'config' ? path.join(paths.CONFIG_DIR, 'cortex-client.json')
    : path.join(paths.DATA_DIR, 'client', kind === 'marker' ? 'local-install.json' : kind);
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, 'user-owned invalid bytes');
  await expect(beginLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow(/unowned|ownership/i);
  expect(fs.readFileSync(foreign, 'utf8')).toBe('user-owned invalid bytes');
  expect(fs.readFileSync(temporary, 'utf8')).toBe(bytes);
  if (kind !== 'marker') expect(readLocalClientIntent(paths)).toBeNull();
});
test.each(['directory', 'symlink'])('temp-shaped %s cannot be ignored as an atomic-write file', async kind => {
  const client = path.join(paths.DATA_DIR, 'client');
  fs.mkdirSync(client, { recursive: true });
  const file = path.join(client, 'local-install.json.tmp.1.123.abcdef');
  if (kind === 'directory') fs.mkdirSync(file);
  else fs.symlinkSync(installRoot, file, 'junction');
  await expect(beginLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow(/unowned/i);
  expect(fs.lstatSync(file).isSymbolicLink()).toBe(kind === 'symlink');
});
test('explicit intent precedes config writes and daemon can finish it without init', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  expect(readLocalClientIntent(paths)?.state).toBe('pending');
  expect(fs.existsSync(path.join(paths.CONFIG_DIR, 'cortex-client.json'))).toBe(false);
  writeConfig('machines.json', { local: { cortexPath: paths.DATA_DIR, gpuCount: 0 } });
  await completeLocalClientInstall(paths, 'local', installRoot);
  expect(readLocalClientIntent(paths)?.state).toBe('ready');
  expect(fs.readFileSync(path.join(paths.DATA_DIR, 'client/current/client.mjs'), 'utf8')).toContain('one');
  expect(JSON.parse(fs.readFileSync(path.join(paths.CONFIG_DIR, 'cortex-client.json'), 'utf8'))).toEqual({ deviceName: 'local', serverHost: '127.0.0.1', serverPort: 3002 });
});
test('fresh enrollment and recovery preserve provably never-attempted launch history', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  expect(readLocalClientIntent(paths)).toMatchObject({ state: 'pending', launchAttempted: false });
  await completeLocalClientInstall(paths, 'local', installRoot);
  expect(readLocalClientIntent(paths)).toMatchObject({ state: 'ready', launchAttempted: false });
});
test.each([undefined, false, true])('recovery preserves launch history %s', async launchAttempted => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  const file = path.join(paths.DATA_DIR, 'client/local-install.json');
  fs.writeFileSync(file, JSON.stringify({ ...readLocalClientIntent(paths), launchAttempted }));
  await completeLocalClientInstall(paths, 'local', installRoot);
  await beginLocalClientInstall(paths, 'local', installRoot);
  expect(readLocalClientIntent(paths)?.launchAttempted).toBe(launchAttempted);
});
test.each([null, 0, 'false', {}])('rejects invalid optional launchAttempted %j', async launchAttempted => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  const file = path.join(paths.DATA_DIR, 'client/local-install.json');
  fs.writeFileSync(file, JSON.stringify({ ...readLocalClientIntent(paths), launchAttempted }));
  expect(() => readLocalClientIntent(paths)).toThrow(/ownership/i);
});
test('attempt marker is committed under the existing lock and survives restart before spawn', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  await completeLocalClientInstall(paths, 'local', installRoot);
  const { renameSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
    expect(fs.statSync(`${to}.mutation-lock`).isDirectory()).toBe(true);
    expect(JSON.parse(fs.readFileSync(from, 'utf8')).launchAttempted).toBe(true);
    renameSync(from, to);
  });
  const gate = new OwnedLocalLaunchGate({
    online: () => false,
    recover: async () => readLocalClientIntent(paths)?.launchAttempted,
    markLaunchAttempted: (device, signal) => markLocalClientLaunchAttempted(paths, device, signal),
    launch: () => {
      expect(readLocalClientIntent(paths)?.launchAttempted).toBe(true);
      throw new Error('interrupted before child spawn');
    },
  });
  try { await expect(gate.start('local')).rejects.toThrow('interrupted before child spawn'); }
  finally { gate.stop(); }
  await completeLocalClientInstall(paths, 'local', installRoot);
  expect(readLocalClientIntent(paths)?.launchAttempted).toBe(true);
  vi.useFakeTimers();
  const launch = vi.fn();
  const restarted = new OwnedLocalLaunchGate({ online: () => false,
    recover: async () => readLocalClientIntent(paths)?.launchAttempted,
    markLaunchAttempted: async () => {}, launch });
  try {
    const pending = restarted.start('local');
    await vi.advanceTimersByTimeAsync(34_750);
    expect(launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(launch).toHaveBeenCalledOnce();
  } finally { restarted.stop(); vi.useRealTimers(); }
});
test('cancelled attempt persistence leaves fresh history unchanged', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  const controller = new AbortController();
  const pending = markLocalClientLaunchAttempted(paths, 'local', controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
  expect(readLocalClientIntent(paths)?.launchAttempted).toBe(false);
});
test('attempt marker cannot claim a different device', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  await expect(markLocalClientLaunchAttempted(paths, 'other', new AbortController().signal)).rejects.toThrow(/different device/);
  expect(readLocalClientIntent(paths)?.launchAttempted).toBe(false);
});
test('concurrent explicit preparation is idempotent', async () => {
  await Promise.all([beginLocalClientInstall(paths, 'local', installRoot), beginLocalClientInstall(paths, 'local', installRoot)]);
  await Promise.all([completeLocalClientInstall(paths, 'local', installRoot), completeLocalClientInstall(paths, 'local', installRoot)]);
  expect(fs.readdirSync(path.join(paths.DATA_DIR, 'client')).sort()).toEqual(['current', 'local-install.json']);
});
test.each(['cortex-client.json', 'current'])('refuses unowned %s without adoption', async (kind) => {
  if (kind === 'current') fs.mkdirSync(path.join(paths.DATA_DIR, 'client/current'), { recursive: true });
  else writeConfig(kind, { deviceName: 'local' });
  await expect(beginLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow(/unowned/i);
  expect(readLocalClientIntent(paths)).toBeNull();
});
test.each([{ ssh: 'host' }, { clientCommand: 'custom' }, { clientConnection: 'ssh-reverse' }])('rejects custom/remote registration %j', async (extra) => {
  writeConfig('machines.json', { local: { cortexPath: paths.DATA_DIR, gpuCount: 0, ...extra } });
  await expect(beginLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow(/machine/i);
});
test('user config modifications fail closed and stay untouched', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  await completeLocalClientInstall(paths, 'local', installRoot);
  writeConfig('cortex-client.json', { deviceName: 'user' });
  await expect(completeLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow(/config/i);
  expect(JSON.parse(fs.readFileSync(path.join(paths.CONFIG_DIR, 'cortex-client.json'), 'utf8')).deviceName).toBe('user');
});
test('ordinary recovery without ownership does not enroll', async () => {
  await expect(completeLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow(/intent|ownership/i);
  expect(readLocalClientIntent(paths)).toBeNull();
});
test('recovery after atomic publication verifies pending hash, then commits ready', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  await completeLocalClientInstall(paths, 'local', installRoot);
  const file = path.join(paths.DATA_DIR, 'client/local-install.json');
  const intent = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...intent, state: 'pending' }));
  await completeLocalClientInstall(paths, 'local', installRoot);
  expect(readLocalClientIntent(paths)?.state).toBe('ready');
});
test('stop aborts recovery waiting for the install lock before any config or files are written', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  const controller = new AbortController();
  const pending = completeLocalClientInstall(paths, 'local', installRoot, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
  expect(fs.existsSync(path.join(paths.CONFIG_DIR, 'cortex-client.json'))).toBe(false);
  expect(fs.existsSync(path.join(paths.DATA_DIR, 'client/current'))).toBe(false);
});
test('partial owned stage after config write is recoverable and republished atomically', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  const config = JSON.stringify({ deviceName: 'local', serverHost: '127.0.0.1', serverPort: 3002 }, null, 2) + '\n';
  fs.mkdirSync(paths.CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(paths.CONFIG_DIR, 'cortex-client.json'), config);
  const stage = path.join(paths.DATA_DIR, 'client/.local-install-stage');
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'client.mjs'), 'interrupted');
  await completeLocalClientInstall(paths, 'local', installRoot);
  expect(readLocalClientIntent(paths)?.state).toBe('ready');
  expect(fs.readFileSync(path.join(paths.CONFIG_DIR, 'cortex-client.json'), 'utf8')).toBe(config);
  expect(fs.existsSync(stage)).toBe(false);
});
test('pending current with wrong hash is not adopted or overwritten', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  const current = path.join(paths.DATA_DIR, 'client/current');
  fs.mkdirSync(current);
  for (const name of names) fs.writeFileSync(path.join(current, name), 'unrecognized');
  await expect(completeLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow(/hash/);
  expect(readLocalClientIntent(paths)?.state).toBe('pending');
  expect(fs.readFileSync(path.join(current, 'client.mjs'), 'utf8')).toBe('unrecognized');
});
test('corrupt ownership marker is not treated as ordinary enrollment', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  fs.writeFileSync(path.join(paths.DATA_DIR, 'client/local-install.json'), '{}');
  await expect(beginLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow(/ownership/);
  await expect(completeLocalClientInstall(paths, 'local', installRoot)).rejects.toThrow(/ownership/);
});
test('ready install never replaces live files when package changes (hot reload owns upgrades)', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  await completeLocalClientInstall(paths, 'local', installRoot);
  payload('two');
  await beginLocalClientInstall(paths, 'local', installRoot);
  await completeLocalClientInstall(paths, 'local', installRoot);
  expect(fs.readFileSync(path.join(paths.DATA_DIR, 'client/current/client.mjs'), 'utf8')).toContain('one');
});
