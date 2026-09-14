import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '../src/core/paths.js';
import { SessionRepo, sessionRepo } from '../src/store/session-repo.js';

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

// P3.2: the key is the channel. A channel has ONE session; which backend it runs is recorded on
// the session, not encoded in the key it is filed under.
test('setSessionAsync then getSessionAsync round-trips on the channel key', async () => {
  await sessionRepo.setSessionAsync('C-session-1', 'sess-uuid-1');
  assert.equal(await sessionRepo.getSessionAsync('C-session-1'), 'sess-uuid-1');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal(raw['C-session-1'], 'sess-uuid-1');
  assert.equal('claude:C-session-1' in raw, false, 'no backend prefix is written any more');
});

test('getSessionAsync returns undefined for an unknown channel without throwing', async () => {
  assert.equal(await sessionRepo.getSessionAsync('C-session-does-not-exist', 'claude'), undefined);
});

test('setSessionAsync drops every legacy backend-prefixed key for the channel it writes', async () => {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({
    'claude:C-session-legacy': 'old-claude',
    'pi:C-session-legacy': 'old-pi',
  }));
  sessionRepo.invalidate();

  await sessionRepo.setSessionAsync('C-session-legacy', 'new-sid');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal(raw['C-session-legacy'], 'new-sid');
  // Both, not just the one matching some backend: a write is a migration of the channel it touches.
  assert.equal('claude:C-session-legacy' in raw, false);
  assert.equal('pi:C-session-legacy' in raw, false);
  assert.equal(await sessionRepo.getSessionAsync('C-session-legacy'), 'new-sid');
});

test('getSessionAsync reads a pre-P3.2 file before the boot migration has run', async () => {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({ 'claude:C-session-fallback': 'legacy-sid' }));
  sessionRepo.invalidate();
  // The read-side shim is what makes the boot migration a cleanup rather than a correctness
  // requirement: a file written by the previous build resolves either way.
  assert.equal(await sessionRepo.getSessionAsync('C-session-fallback'), 'legacy-sid');
});

test('deleteSessionAsync clears the channel in every key form, and only that channel', async () => {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({
    'C-del-1': 'sid-bare',
    'claude:C-del-1': 'sid-A',
    'pi:C-del-1': 'sid-C',
    'claude:C-del-2': 'sid-B',
  }));
  sessionRepo.invalidate();

  await sessionRepo.deleteSessionAsync('C-del-1');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  // One call really does clear the channel. The old signature needed one per backend and silently
  // left the other binding behind — which is how a `!new` could be followed by a resumed session.
  assert.equal('C-del-1' in raw, false);
  assert.equal('claude:C-del-1' in raw, false);
  assert.equal('pi:C-del-1' in raw, false);
  assert.equal(raw['claude:C-del-2'], 'sid-B', 'an unrelated channel is untouched');
});

test('deleteSessionAsync on missing key is a no-op (no throw, other entries unchanged)', async () => {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({ 'claude:C-keep': 'keep-sid' }));
  sessionRepo.invalidate();

  await assert.doesNotReject(async () => {
    await sessionRepo.deleteSessionAsync('C-nope');
  });
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal(raw['claude:C-keep'], 'keep-sid');
});

test('a channel whose own name contains a colon keys on its whole name', async () => {
  // Real channels are `web:<uuid>`, `slack:C…`, so this is the common case, not an edge one:
  // only a leading `claude:`/`pi:` is ever stripped.
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({ 'claude:web:abc': 'pre-existing' }));
  sessionRepo.invalidate();

  await sessionRepo.setSessionAsync('web:abc', 'new-sid');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal(raw['web:abc'], 'new-sid');
  assert.equal('claude:web:abc' in raw, false);
});

test('the second backend to bind a channel replaces the first — one channel, one session', async () => {
  // The inverse of the old behaviour, and the point of P3.2: two bindings were never usable at
  // once (only the channel's current backend was consulted), so the second one is the truth.
  await sessionRepo.setSessionAsync('C-multi', 'claude-sid');
  await sessionRepo.setSessionAsync('C-multi', 'pi-sid');
  assert.equal(await sessionRepo.getSessionAsync('C-multi'), 'pi-sid');

  await sessionRepo.deleteSessionAsync('C-multi');
  assert.equal(await sessionRepo.getSessionAsync('C-multi'), undefined);
});

test('getSessionAsync recovers from corrupt sessions.json by backing up the bad bytes to a .corrupt.<ts> sibling', async () => {
  const dir = path.dirname(SESSIONS_FILE);
  const base = path.basename(SESSIONS_FILE);
  const CORRUPT_BYTES = 'not-json';
  await fs.writeFile(SESSIONS_FILE, CORRUPT_BYTES);
  sessionRepo.invalidate();

  // Read should recover without throwing, returning the default (empty) state.
  assert.equal(await sessionRepo.getSessionAsync('anything'), undefined);

  // A .corrupt.<ts> sibling must exist and preserve the original bad bytes.
  const siblings = await fs.readdir(dir);
  const corruptBackup = siblings.find((f) => f.startsWith(`${base}.corrupt.`));
  assert.ok(corruptBackup, 'expected a .corrupt.<ts> backup sibling to be created');
  const preserved = await fs.readFile(path.join(dir, corruptBackup), 'utf8');
  assert.equal(preserved, CORRUPT_BYTES, 'backup should contain the original corrupt bytes');

  // Subsequent writes overwrite the corrupt sessions.json with valid JSON.
  await sessionRepo.setSessionAsync('C-recover', 'sid');
  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  assert.equal(raw['C-recover'], 'sid');
});

test('concurrent setSessionAsync operations do not lose updates (AsyncMutex)', async () => {
  await fs.writeFile(SESSIONS_FILE, '{}');
  sessionRepo.invalidate();

  const channels = Array.from({ length: 10 }, (_, i) => `C-concurrent-${i}`);
  await Promise.all(
    channels.map((ch, i) => sessionRepo.setSessionAsync(ch, `sid-${i}`))
  );

  const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  for (const [i, ch] of channels.entries()) {
    assert.equal(raw[ch], `sid-${i}`, `channel ${ch} should have sid-${i}`);
  }
});

test('deleteManyBySessionIds removes every binding whose value matches the given track ids', async () => {
  const repo = new SessionRepo(path.join(STORE_DIR, 'sessions-bulk.json'));
  await repo.setSessionAsync('C1', 'track-1');
  await repo.setSessionAsync('C2', 'track-2');
  await repo.setSessionAsync('C3', 'track-1');
  await repo.setSessionAsync('C4', 'track-3');

  const removed = await repo.deleteManyBySessionIds(['track-1', 'track-3']);

  assert.equal(removed, 3);
  assert.equal(await repo.getSessionAsync('C1'), undefined);
  assert.equal(await repo.getSessionAsync('C3'), undefined);
  assert.equal(await repo.getSessionAsync('C4'), undefined);
  assert.equal(await repo.getSessionAsync('C2'), 'track-2');
});

// ── P3.2 key migration ──────────────────────────────────────────────────────

function migrationRepo(name: string): SessionRepo {
  return new SessionRepo(path.join(STORE_DIR, name));
}

test('migrateSessionKeys collapses backend-prefixed keys onto the channel', async () => {
  const file = path.join(STORE_DIR, 'sessions-migrate-1.json');
  await fs.writeFile(file, JSON.stringify({
    'claude:web:a': 'sid-a',
    'pi:slack:C1': 'sid-b',
    'web:c': 'sid-c',            // already migrated — left alone
  }));
  const repo = migrationRepo('sessions-migrate-1.json');

  const result = await repo.migrateSessionKeys();

  assert.deepEqual(result, { migrated: 2, conflicts: 0 });
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(raw, { 'web:a': 'sid-a', 'slack:C1': 'sid-b', 'web:c': 'sid-c' });
});

test('migrateSessionKeys is idempotent — a migrated file is a no-op with no write', async () => {
  const file = path.join(STORE_DIR, 'sessions-migrate-2.json');
  await fs.writeFile(file, JSON.stringify({ 'web:a': 'sid-a' }));
  const repo = migrationRepo('sessions-migrate-2.json');

  assert.deepEqual(await repo.migrateSessionKeys(), { migrated: 0, conflicts: 0 });
  assert.deepEqual(await repo.migrateSessionKeys(), { migrated: 0, conflicts: 0 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { 'web:a': 'sid-a' });
});

test('a channel bound under both backends keeps the more recently used session', async () => {
  const file = path.join(STORE_DIR, 'sessions-migrate-3.json');
  await fs.writeFile(file, JSON.stringify({
    'claude:web:dual': 'sid-old',
    'pi:web:dual': 'sid-new',
  }));
  const repo = migrationRepo('sessions-migrate-3.json');
  const seen: string[] = [];

  const result = await repo.migrateSessionKeys({
    lastUsedAt: async (id) => ({ 'sid-old': '2026-09-01T00:00:00Z', 'sid-new': '2026-09-10T00:00:00Z' }[id] ?? null),
    log: (m) => seen.push(m),
  });

  assert.equal(result.conflicts, 1);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))['web:dual'], 'sid-new');
  // The log line is the only record that the dropped binding ever existed.
  assert.equal(seen.length, 1);
  assert.match(seen[0], /web:dual/);
  assert.match(seen[0], /sid-old/);
  assert.match(seen[0], /sid-new/);
});

test('the winner does not depend on which backend key came first', async () => {
  // Same data, opposite insertion order: the timestamp decides, not the iteration order.
  for (const order of [['pi:web:dual', 'claude:web:dual'], ['claude:web:dual', 'pi:web:dual']]) {
    const name = `sessions-migrate-order-${order[0][0]}.json`;
    const file = path.join(STORE_DIR, name);
    await fs.writeFile(file, JSON.stringify(Object.fromEntries(
      order.map(k => [k, k.startsWith('pi:') ? 'sid-pi' : 'sid-claude']),
    )));
    await migrationRepo(name).migrateSessionKeys({
      lastUsedAt: async (id) => (id === 'sid-claude' ? '2026-09-11T00:00:00Z' : '2026-09-01T00:00:00Z'),
    });
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))['web:dual'], 'sid-claude');
  }
});

test('a session the registry has forgotten loses to a dated one, and ties stay deterministic', async () => {
  const file = path.join(STORE_DIR, 'sessions-migrate-4.json');
  await fs.writeFile(file, JSON.stringify({
    'claude:web:undated': 'sid-unknown',
    'pi:web:undated': 'sid-dated',
    'claude:web:tied': 'sid-t1',
    'pi:web:tied': 'sid-t2',
  }));
  const repo = migrationRepo('sessions-migrate-4.json');

  await repo.migrateSessionKeys({
    lastUsedAt: async (id) => (id === 'sid-dated' ? '2026-09-01T00:00:00Z' : null),
  });

  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw['web:undated'], 'sid-dated', 'a forgotten session is not the live conversation');
  // Neither is dated: the first key processed wins, so repeated runs agree with each other.
  assert.equal(raw['web:tied'], 'sid-t1');
});

test('a lastUsedAt lookup that throws does not take the migration down', async () => {
  const file = path.join(STORE_DIR, 'sessions-migrate-5.json');
  await fs.writeFile(file, JSON.stringify({ 'claude:web:x': 'sid-1', 'pi:web:x': 'sid-2' }));
  const repo = migrationRepo('sessions-migrate-5.json');

  const result = await repo.migrateSessionKeys({
    lastUsedAt: async () => { throw new Error('registry unavailable'); },
  });

  assert.equal(result.conflicts, 1);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))['web:x'], 'sid-1');
});
