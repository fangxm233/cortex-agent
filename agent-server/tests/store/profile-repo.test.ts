// input:  Node test runner, assert, tmp filesystem
// output: regression tests for ProfileRepo (concurrent mutate, flush ordering, readSync)
// pos:    verifies store/profile-repo.ts Pattern A guarantees
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProfileRepo, startProfileWatcher } from '../../src/store/profile-repo.js';
import type { ProfilesFile } from '../../src/domain/agents/profile-manager.js';

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-profile-repo-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helper: fresh repo + seeded file per test ──────────────────

let _testIdx = 0;
async function createRepo(initial?: ProfilesFile): Promise<{ repo: ProfileRepo; filePath: string }> {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `profiles-${idx}.json`);
  const seed: ProfilesFile = initial ?? {
    defaultProfile: 'a',
    profiles: {
      a: { model: 'claude-opus-4-6' },
      b: { model: 'claude-sonnet-4-6', mode: 'plan' },
    },
  };
  await fs.writeFile(filePath, JSON.stringify(seed, null, 2));
  return { repo: new ProfileRepo(filePath), filePath };
}

// ── Read: async + sync ────────────────────────────────────────

test('ProfileRepo - read() returns seeded profile data', async () => {
  const { repo } = await createRepo();
  const data = await repo.read();
  assert.equal(data.defaultProfile, 'a');
  assert.equal(data.profiles.a.model, 'claude-opus-4-6');
  assert.equal(data.profiles.b.mode, 'plan');
});

test('ProfileRepo - readSync() returns the same data as read()', async () => {
  const { repo } = await createRepo();
  const asyncData = await repo.read();
  const syncData = repo.readSync();
  assert.deepEqual(syncData, asyncData);
});

test('ProfileRepo - readSync() caches after first call', async () => {
  const { repo, filePath } = await createRepo();
  const first = repo.readSync();
  // Rewrite the file outside the repo.
  await fs.writeFile(filePath, JSON.stringify({ defaultProfile: 'changed', profiles: { changed: { model: 'x' } } }));
  const second = repo.readSync();
  // Cache should still return the original data.
  assert.equal(second.defaultProfile, first.defaultProfile);

  // invalidate + readSync should pick up the new file.
  repo.invalidate();
  const third = repo.readSync();
  assert.equal(third.defaultProfile, 'changed');
});

test('ProfileRepo - read() throws if profiles.json is missing', async () => {
  const filePath = path.join(tmpDir, `profiles-missing-${_testIdx++}.json`);
  const repo = new ProfileRepo(filePath);
  await assert.rejects(
    () => repo.read(),
    /profiles\.json not found/,
  );
});

// ── Concurrent mutate: no lost profiles ────────────────────────

test('ProfileRepo - 10 concurrent mutate() add 10 profiles without loss', async () => {
  const { repo } = await createRepo({ defaultProfile: 'base', profiles: { base: { model: 'claude-opus-4-6' } } });

  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      repo.mutate((cur) => {
        const next: ProfilesFile = {
          defaultProfile: cur.defaultProfile,
          profiles: { ...cur.profiles, [`p${i}`]: { model: `model-${i}` } },
        };
        return { next, result: undefined };
      })
    )
  );

  const data = await repo.read();
  assert.equal(Object.keys(data.profiles).length, 11, '1 seed + 10 added profiles');
  for (let i = 0; i < 10; i++) {
    assert.equal(data.profiles[`p${i}`]?.model, `model-${i}`);
  }
});

// ── Flush: mid-mutate flush resolves only after pending work ──

test('ProfileRepo - flush() resolves only after all pending mutations (FIFO on mutex)', async () => {
  const { repo } = await createRepo();

  const resolutionOrder: string[] = [];
  const N = 10;

  const mutations = Array.from({ length: N }, (_, i) =>
    repo.mutate((cur) => {
      const next: ProfilesFile = {
        defaultProfile: cur.defaultProfile,
        profiles: { ...cur.profiles, [`m${i}`]: { model: `model-${i}` } },
      };
      return { next, result: undefined };
    }).then(() => { resolutionOrder.push(`mut-${i}`); })
  );

  const flushDone = repo.flush().then(() => { resolutionOrder.push('flush'); });

  await Promise.all([...mutations, flushDone]);

  assert.equal(
    resolutionOrder[N],
    'flush',
    `flush must be last; got ${resolutionOrder.join(', ')}`,
  );
});

// ── Save: roundtrip + sync cache stays fresh ──────────────────

test('ProfileRepo - save() updates both async read() and readSync() cache', async () => {
  const { repo } = await createRepo();
  // Warm both caches.
  await repo.read();
  repo.readSync();

  const next: ProfilesFile = {
    defaultProfile: 'solo',
    profiles: { solo: { model: 'claude-haiku-4-5' } },
  };
  await repo.save(next);

  assert.deepEqual(await repo.read(), next);
  assert.deepEqual(repo.readSync(), next);
});

// ── Hot-reload watcher ────────────────────────────────────────

test('startProfileWatcher - invalidates cache, reloads, and reports a valid file change', async (t) => {
  const { repo, filePath } = await createRepo();
  // Warm the sync cache.
  const initial = repo.readSync();
  assert.equal(initial.defaultProfile, 'a');
  let successfulReloads = 0;

  const stop = startProfileWatcher(repo, filePath, () => { successfulReloads++; });
  t.onTestFinished(() => stop());

  const updated: ProfilesFile = {
    defaultProfile: 'hot-loaded',
    profiles: { 'hot-loaded': { model: 'claude-haiku-4-5' } },
  };
  await fs.writeFile(filePath, JSON.stringify(updated, null, 2));

  // Wait for debounce (300 ms) + buffer.
  await new Promise(r => setTimeout(r, 600));

  const fresh = repo.readSync();
  assert.equal(fresh.defaultProfile, 'hot-loaded', 'cache should be refreshed after file change');
  assert.ok(successfulReloads >= 1, 'a successful reload should be reported');
});

test('startProfileWatcher - stop function prevents further reloads', async () => {
  const { repo, filePath } = await createRepo();
  repo.readSync(); // warm cache

  const stop = startProfileWatcher(repo, filePath);
  stop(); // stop immediately before any change

  const updated: ProfilesFile = {
    defaultProfile: 'should-not-appear',
    profiles: { 'should-not-appear': { model: 'x' } },
  };
  await fs.writeFile(filePath, JSON.stringify(updated, null, 2));

  await new Promise(r => setTimeout(r, 600));

  // Cache must NOT have been refreshed (watcher was stopped before the write).
  const current = repo.readSync();
  assert.equal(current.defaultProfile, 'a', 'cache should not be updated after watcher is stopped');
});

test('startProfileWatcher - logs, keeps old cache, and reports no success for invalid JSON', async (t) => {
  const { repo, filePath } = await createRepo();
  const initial = repo.readSync();
  let successfulReloads = 0;

  const stop = startProfileWatcher(repo, filePath, () => { successfulReloads++; });
  t.onTestFinished(() => stop());

  // Write invalid JSON to the file.
  await fs.writeFile(filePath, '{ not valid json !!!');

  await new Promise(r => setTimeout(r, 600));

  // Cache must still hold the original valid data.
  const current = repo.readSync();
  assert.equal(current.defaultProfile, initial.defaultProfile, 'invalid JSON should not wipe cache');
  assert.equal(successfulReloads, 0, 'a failed reload must not be reported as successful');
});

// ── On-disk schema unchanged (byte-level check) ───────────────

test('ProfileRepo - save() writes JSON with 2-space indent matching historical schema', async () => {
  const { repo, filePath } = await createRepo();
  const target: ProfilesFile = {
    defaultProfile: 'a',
    profiles: { a: { model: 'claude-opus-4-6' } },
  };
  await repo.save(target);
  await repo.flush();

  const raw = await fs.readFile(filePath, 'utf8');
  assert.equal(raw, JSON.stringify(target, null, 2), 'on-disk bytes should match JSON.stringify(·, null, 2)');
});
