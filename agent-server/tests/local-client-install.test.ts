import { afterEach, beforeEach, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadPackageClientBundle } from '../src/domain/remote/package-client-bundle.js';
import { beginLocalClientInstall, completeLocalClientInstall, readLocalClientIntent } from '../src/domain/remote/local-client-install.js';

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
test('ready install never replaces live files when package changes (hot reload owns upgrades)', async () => {
  await beginLocalClientInstall(paths, 'local', installRoot);
  await completeLocalClientInstall(paths, 'local', installRoot);
  payload('two');
  await beginLocalClientInstall(paths, 'local', installRoot);
  await completeLocalClientInstall(paths, 'local', installRoot);
  expect(fs.readFileSync(path.join(paths.DATA_DIR, 'client/current/client.mjs'), 'utf8')).toContain('one');
});
