// input:  Node test runner + session.ts + sessions.json
// output: set/get/delete + backend:channel key tests (async API via SessionRepo)
// pos:    Verify session CRUD and legacy migration, all tests use async API
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '../src/core/paths.js';
import { sessionRepo } from '../src/store/session-repo.js';

const SESSIONS_FILE = path.join(STORE_DIR, 'sessions.json');
let backup: string | null = null;
let backupExisted = false;

beforeAll(async () => {
  try {
    backup = await fs.readFile(SESSIONS_FILE, 'utf8');
    backupExisted = true;
  } catch {
    backup = null;
    backupExisted = false;
  }
  // Start from a known empty state so tests are deterministic.
  await fs.writeFile(SESSIONS_FILE, '{}');
  sessionRepo.invalidate();
});

afterAll(async () => {
  // Clean up any .corrupt.<ts> backups the corruption-recovery test left behind.
  try {
    const dir = path.dirname(SESSIONS_FILE);
    const base = path.basename(SESSIONS_FILE);
    const siblings = await fs.readdir(dir);
    for (const f of siblings) {
      if (f.startsWith(`${base}.corrupt.`)) {
        await fs.unlink(path.join(dir, f));
      }
    }
  } catch {}

  if (backupExisted && backup != null) {
    await fs.writeFile(SESSIONS_FILE, backup);
  } else {
    try { await fs.unlink(SESSIONS_FILE); } catch {}
  }
});

process.on('exit', () => {
  // Best-effort restore on abnormal exit.
  if (backupExisted && backup != null) {
    try { fsSync.writeFileSync(SESSIONS_FILE, backup); } catch {}
  }
});

test('setSessionAsync then getSessionAsync round-trips with backend:channel key', async () => {
  await sessionRepo.setSessionAsync('C-session-1', 'sess-uuid-1', 'claude');
  assert.equal(await sessionRepo.getSessionAsync('C-session-1', 'claude'), 'sess-uuid-1');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal(raw['claude:C-session-1'], 'sess-uuid-1');
});

test('getSessionAsync returns undefined for an unknown channel without throwing', async () => {
  assert.equal(await sessionRepo.getSessionAsync('C-session-does-not-exist', 'claude'), undefined);
});

test('setSessionAsync migrates legacy bare-channel key: after set, only backend:channel remains', async () => {
  // Seed sessions.json with a legacy entry under the bare channel name.
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({ 'C-session-legacy': 'old-sid' }));
  sessionRepo.invalidate();

  // After a set() for the same channel with a backend, the legacy key should be removed.
  await sessionRepo.setSessionAsync('C-session-legacy', 'new-sid', 'claude');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal(raw['claude:C-session-legacy'], 'new-sid');
  assert.equal('C-session-legacy' in raw, false);
  assert.equal(await sessionRepo.getSessionAsync('C-session-legacy', 'claude'), 'new-sid');
});

test('getSessionAsync falls back to legacy bare-channel key when no backend-prefixed entry exists', async () => {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({ 'C-session-fallback': 'legacy-sid' }));
  sessionRepo.invalidate();
  // No backend-prefixed entry yet → getSession should return the legacy value.
  assert.equal(await sessionRepo.getSessionAsync('C-session-fallback', 'pi'), 'legacy-sid');
});

test('deleteSessionAsync removes only the backend:channel key, leaving unrelated channels untouched', async () => {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({
    'claude:C-del-1': 'sid-A',
    'claude:C-del-2': 'sid-B',
    'pi:C-del-1': 'sid-C',
  }));
  sessionRepo.invalidate();

  await sessionRepo.deleteSessionAsync('C-del-1', 'claude');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal('claude:C-del-1' in raw, false);
  assert.equal(raw['claude:C-del-2'], 'sid-B');
  assert.equal(raw['pi:C-del-1'], 'sid-C');
});

test('deleteSessionAsync also removes the legacy bare-channel key for the same channel', async () => {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({
    'C-del-legacy': 'legacy-sid',
    'claude:C-del-legacy': 'backend-sid',
  }));
  sessionRepo.invalidate();

  await sessionRepo.deleteSessionAsync('C-del-legacy', 'claude');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal('C-del-legacy' in raw, false);
  assert.equal('claude:C-del-legacy' in raw, false);
});

test('deleteSessionAsync on missing key is a no-op (no throw, other entries unchanged)', async () => {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({ 'claude:C-keep': 'keep-sid' }));
  sessionRepo.invalidate();

  await assert.doesNotReject(async () => {
    await sessionRepo.deleteSessionAsync('C-nope', 'claude');
  });
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal(raw['claude:C-keep'], 'keep-sid');
});

test('setSessionAsync does not touch a key that happens to contain a colon (treated as already backend-scoped)', async () => {
  // The legacy-key cleanup only fires when `channel.includes(':')` is false — a channel
  // whose name itself contains ':' should not be stripped.
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({ 'odd:channel': 'pre-existing' }));
  sessionRepo.invalidate();

  await sessionRepo.setSessionAsync('odd:channel', 'new-sid', 'claude');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal(raw['claude:odd:channel'], 'new-sid');
  assert.equal(raw['odd:channel'], 'pre-existing', 'colon-containing key should be preserved');
});

test('different backends keep independent session ids for the same channel', async () => {
  await sessionRepo.setSessionAsync('C-multi', 'claude-sid', 'claude');
  await sessionRepo.setSessionAsync('C-multi', 'pi-sid', 'pi');
  assert.equal(await sessionRepo.getSessionAsync('C-multi', 'claude'), 'claude-sid');
  assert.equal(await sessionRepo.getSessionAsync('C-multi', 'pi'), 'pi-sid');

  await sessionRepo.deleteSessionAsync('C-multi', 'claude');
  assert.equal(await sessionRepo.getSessionAsync('C-multi', 'claude'), undefined);
  assert.equal(await sessionRepo.getSessionAsync('C-multi', 'pi'), 'pi-sid', 'PI session should survive Claude deletion');
});

test('getSessionAsync recovers from corrupt sessions.json by backing up the bad bytes to a .corrupt.<ts> sibling', async () => {
  const dir = path.dirname(SESSIONS_FILE);
  const base = path.basename(SESSIONS_FILE);
  const CORRUPT_BYTES = 'not-json';
  await fs.writeFile(SESSIONS_FILE, CORRUPT_BYTES);
  sessionRepo.invalidate();

  // Read should recover without throwing, returning the default (empty) state.
  assert.equal(await sessionRepo.getSessionAsync('anything', 'claude'), undefined);

  // A .corrupt.<ts> sibling must exist and preserve the original bad bytes.
  const siblings = await fs.readdir(dir);
  const corruptBackup = siblings.find((f) => f.startsWith(`${base}.corrupt.`));
  assert.ok(corruptBackup, 'expected a .corrupt.<ts> backup sibling to be created');
  const preserved = await fs.readFile(path.join(dir, corruptBackup), 'utf8');
  assert.equal(preserved, CORRUPT_BYTES, 'backup should contain the original corrupt bytes');

  // Subsequent writes overwrite the corrupt sessions.json with valid JSON.
  await sessionRepo.setSessionAsync('C-recover', 'sid', 'claude');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal(raw['claude:C-recover'], 'sid');
});

test('concurrent setSessionAsync operations do not lose updates (AsyncMutex)', async () => {
  await fs.writeFile(SESSIONS_FILE, '{}');
  sessionRepo.invalidate();

  const channels = Array.from({ length: 10 }, (_, i) => `C-concurrent-${i}`);
  await Promise.all(
    channels.map((ch, i) => sessionRepo.setSessionAsync(ch, `sid-${i}`, 'claude'))
  );

  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  for (const [i, ch] of channels.entries()) {
    assert.equal(raw[`claude:${ch}`], `sid-${i}`, `channel ${ch} should have sid-${i}`);
  }
});
