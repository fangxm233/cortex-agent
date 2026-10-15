import { test, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ModelsRepo, startModelsWatcher, setAdminNotifier, getModelsConfigRevision } from '../../src/store/models-repo.js';
import type { ModelsFile } from '../../src/domain/agents/engine-selection.js';

async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!cond() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  expect(cond()).toBe(true);
}
let tmpDir: string;
beforeAll(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-models-repo-')); });
afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });
let index = 0;
function config(model = 'opus'): ModelsFile {
  return { default: { backend: 'claude', model, provider: null, thinking: null, mode: 'plan' }, favorites: [] };
}
async function createRepo() {
  const filePath = path.join(tmpDir, `models-${index++}.json`);
  await fs.writeFile(filePath, JSON.stringify(config()));
  return { repo: new ModelsRepo(filePath), filePath };
}

test('sync reads are cached until invalidation; invalidation installs a new identity', async () => {
  const { repo, filePath } = await createRepo();
  const original = repo.readSync();
  await fs.writeFile(filePath, JSON.stringify(config('changed')));
  expect(repo.readSync()).toBe(original);
  repo.invalidate();
  expect(repo.readSync()).not.toBe(original);
  expect(repo.readSync().default.model).toBe('changed');
});

test('readIfPresent tolerates missing configuration, not corrupt JSON', async () => {
  const filePath = path.join(tmpDir, 'missing.json');
  const repo = new ModelsRepo(filePath);
  expect(repo.readIfPresent()).toBeNull();
  await fs.writeFile(filePath, '{ invalid');
  expect(() => repo.readIfPresent()).toThrow();
});

test('watcher reloads edits, increments revision, and notifies consumers', async (t) => {
  const { repo, filePath } = await createRepo();
  const initial = repo.readSync();
  const revision = getModelsConfigRevision();
  let reloads = 0;
  const stop = startModelsWatcher(repo, filePath, () => { reloads++; });
  t.onTestFinished(stop);
  await fs.writeFile(filePath, JSON.stringify(config('updated')));
  await waitFor(() => reloads > 0);
  expect(repo.readSync().default.model).toBe('updated');
  expect(repo.readSync()).not.toBe(initial);
  expect(getModelsConfigRevision()).toBeGreaterThan(revision);
});

test('stopping watcher prevents subsequent reloads', async (t) => {
  const { repo, filePath } = await createRepo();
  const initial = repo.readSync();
  startModelsWatcher(repo, filePath)();
  let sentinelReloads = 0;
  const sentinel = new ModelsRepo(filePath);
  t.onTestFinished(startModelsWatcher(sentinel, filePath, () => { sentinelReloads++; }));
  await fs.writeFile(filePath, JSON.stringify(config('updated')));
  await waitFor(() => sentinelReloads > 0);
  expect(repo.readSync()).toBe(initial);
});

test('invalid JSON retains cache and revision, reports failure, and recovers on next edit', async (t) => {
  const { repo, filePath } = await createRepo();
  const initial = repo.readSync();
  const revision = getModelsConfigRevision();
  let reloads = 0;
  const notices: string[] = [];
  setAdminNotifier(text => { notices.push(text); });
  t.onTestFinished(() => setAdminNotifier(() => {}));
  t.onTestFinished(startModelsWatcher(repo, filePath, () => { reloads++; }));
  await fs.writeFile(filePath, '{ invalid');
  await waitFor(() => notices.some(n => n.includes('FAILED')));
  expect(repo.readSync()).toBe(initial);
  expect(getModelsConfigRevision()).toBe(revision);
  expect(reloads).toBe(0);
  await fs.writeFile(filePath, JSON.stringify(config('recovered')));
  await waitFor(() => reloads > 0);
  expect(repo.readSync().default.model).toBe('recovered');
});

test('atomic file replacement is picked up by the resilient watcher', async (t) => {
  const { repo, filePath } = await createRepo();
  repo.readSync();
  let reloads = 0;
  t.onTestFinished(startModelsWatcher(repo, filePath, () => { reloads++; }));
  await fs.writeFile(`${filePath}.tmp`, JSON.stringify(config('replacement')));
  await fs.rename(`${filePath}.tmp`, filePath);
  await waitFor(() => reloads > 0);
  expect(repo.readSync().default.model).toBe('replacement');
});

test('explicit write invalidation advances revision before the watcher debounce', async () => {
  const { repo, filePath } = await createRepo();
  repo.readSync();
  const revision = getModelsConfigRevision();
  await fs.writeFile(filePath, JSON.stringify(config('new-default')));
  repo.invalidate();
  expect(getModelsConfigRevision()).toBeGreaterThan(revision);
  expect(repo.readSync().default.model).toBe('new-default');
});
