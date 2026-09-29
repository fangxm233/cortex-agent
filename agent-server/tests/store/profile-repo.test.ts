import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProfileRepo, startProfileWatcher, setAdminNotifier } from '../../src/store/profile-repo.js';
import type { ProfilesFile } from '../../src/domain/agents/profile-manager.js';

// The watcher rides on real fs.watch events plus a module-internal 300ms debounce
// (not injectable), so fake timers cannot fast-forward it. Poll for the observable
// signal instead of sleeping fixed padding. Returns quietly on timeout — the
// caller's assertions then fail with their own messages.
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
}

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

// ── Read: sync cache ──────────────────────────────────────────

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

  // Wait for fs.watch event + 300ms debounce, observed via the reload callback.
  await waitFor(() => successfulReloads >= 1);

  const fresh = repo.readSync();
  assert.equal(fresh.defaultProfile, 'hot-loaded', 'cache should be refreshed after file change');
  assert.ok(successfulReloads >= 1, 'a successful reload should be reported');
});

test('startProfileWatcher - stop function prevents further reloads', async (t) => {
  const { repo, filePath } = await createRepo();
  repo.readSync(); // warm cache

  const stop = startProfileWatcher(repo, filePath);
  stop(); // stop immediately before any change

  // Sentinel: a second, live watcher (own repo instance so it can't touch `repo`'s
  // cache) proves the fs event + debounce pipeline for this write has fully fired —
  // a deterministic replacement for a blind sleep. A buggy un-stopped watcher was
  // registered earlier, so its debounce would fire no later than the sentinel's.
  const sentinelRepo = new ProfileRepo(filePath);
  let sentinelReloads = 0;
  const stopSentinel = startProfileWatcher(sentinelRepo, filePath, () => { sentinelReloads++; });
  t.onTestFinished(() => stopSentinel());

  const updated: ProfilesFile = {
    defaultProfile: 'should-not-appear',
    profiles: { 'should-not-appear': { model: 'x' } },
  };
  await fs.writeFile(filePath, JSON.stringify(updated, null, 2));

  await waitFor(() => sentinelReloads >= 1);
  // Small buffer so a (hypothetical) leaked debounce on the stopped watcher, armed
  // by the same fs event, would have fired too.
  await new Promise(r => setTimeout(r, 50));

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

  // The failed-reload path's observable signal is the admin FAILED notice, emitted
  // synchronously after the reload attempt gives up — poll for it instead of sleeping.
  const notices: string[] = [];
  setAdminNotifier((text) => { notices.push(text); });
  t.onTestFinished(() => setAdminNotifier(() => {}));

  // Write invalid JSON to the file.
  await fs.writeFile(filePath, '{ not valid json !!!');

  await waitFor(() => notices.some(n => /FAILED/.test(n)));

  // Cache must still hold the original valid data.
  const current = repo.readSync();
  assert.equal(current.defaultProfile, initial.defaultProfile, 'invalid JSON should not wipe cache');
  assert.equal(successfulReloads, 0, 'a failed reload must not be reported as successful');
});
