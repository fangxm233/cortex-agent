import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';

let dir: string;
let counter = 0;
beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-metadata-')); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function setup() {
  const file = path.join(dir, `${counter++}.jsonl`);
  const repo = new SessionRegistryRepo(file, { shouldCompact: () => false });
  await repo.registerSession('cortex-title', {
    sessionId: 'stable-id', channel: 'web:session', backend: 'pi', kind: 'local',
    backendSessionId: 'backend-id',
  });
  await repo.markRead('stable-id');
  return { repo: new SessionRegistryRepo(file, { shouldCompact: () => false }), file };
}

test('metadata uses stable IDs, preserves activity and identity, and replays patches and full records', async () => {
  const { repo, file } = await setup();
  const before = await repo.getById('stable-id');
  assert.equal(before?.starred, undefined);
  await Promise.all([repo.setStarred('stable-id', true), repo.rename('stable-id', 'Manual title')]);
  const expected = { ...before, starred: true, label: 'Manual title', labelRenamed: true };
  assert.deepEqual(await repo.getById('stable-id'), expected);
  const replay = new SessionRegistryRepo(file);
  assert.deepEqual(await replay.getById('stable-id'), expected);
  await replay.compactNow();
  assert.deepEqual(await new SessionRegistryRepo(file).getById('stable-id'), expected);
});

test('unstar persists false and setting the same metadata is a journal no-op', async () => {
  const { repo, file } = await setup();
  await repo.setStarred('stable-id', true);
  await repo.setStarred('stable-id', false);
  const before = await fs.readFile(file, 'utf8');
  await repo.setStarred('stable-id', false);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await new SessionRegistryRepo(file).getById('stable-id'))?.starred, false);
  await repo.compactNow();
  assert.equal((await new SessionRegistryRepo(file).getById('stable-id'))?.starred, false);
});

test('missing or deleted IDs cannot mutate metadata or recreate records', async () => {
  const { repo } = await setup();
  assert.equal(await repo.setStarred('cortex-title', true), null);
  assert.equal(await repo.rename('missing', 'Title'), null);
  await repo.updateSession('cortex-title', { lastUsedAt: '2000-01-01T00:00:00Z' });
  await repo.beginDeleteExpired(new Date('2001-01-01T00:00:00Z'), []);
  assert.equal(await repo.setStarred('stable-id', true), null);
  assert.equal(await repo.rename('stable-id', 'Title'), null);
  assert.equal(await repo.fillLabelIfAbsent('stable-id', 'Automatic'), null);
});

test('atomic first-message fill never overwrites a rename in either queued order', async () => {
  const { repo } = await setup();
  await Promise.all([repo.rename('stable-id', 'Manual'), repo.fillLabelIfAbsent('stable-id', 'Automatic')]);
  assert.equal((await repo.getById('stable-id'))?.label, 'Manual');
  await repo.updateSession('cortex-title', { label: null });
  await Promise.all([repo.fillLabelIfAbsent('stable-id', 'Automatic'), repo.rename('stable-id', 'Manual')]);
  assert.equal((await repo.getById('stable-id'))?.label, 'Manual');
});

test('first-message fill trims and truncates only an absent label without changing activity', async () => {
  const { repo } = await setup();
  const before = await repo.getById('stable-id');
  await repo.fillLabelIfAbsent('stable-id', '   ');
  assert.deepEqual(await repo.getById('stable-id'), before);
  await repo.fillLabelIfAbsent('stable-id', `  ${'x'.repeat(70)}  `);
  assert.deepEqual(await repo.getById('stable-id'), { ...before, label: 'x'.repeat(60) });
});
