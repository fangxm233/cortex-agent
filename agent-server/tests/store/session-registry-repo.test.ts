// input:  Node test runner, assert, tmp filesystem
// output: SessionRegistryRepo concurrency, cache, context snapshot, and API regressions
// pos:    verifies store/session-registry-repo.ts Pattern A guarantees
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionRegistryRepo, deriveSessionOrigin } from '../../src/store/session-registry-repo.js';

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-registry-repo-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helper: fresh repo + file per test ─────────────────────────

let _testIdx = 0;
function createRepoWithPath(): { repo: SessionRegistryRepo; filePath: string } {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);
  return { repo: new SessionRegistryRepo(filePath), filePath };
}

function makeOpts(sessionId: string, overrides: Record<string, any> = {}) {
  return { sessionId, channel: 'C001', backend: 'claude', kind: 'local' as const, label: null, projectId: 'test-project', ...overrides };
}

// ── (a) Concurrent mutate: no lost entries ─────────────────────

test('SessionRegistryRepo - 10 concurrent registerSession produce all 10 entries', async () => {
  const { repo } = createRepoWithPath();
  const names = Array.from({ length: 10 }, (_, i) => `cortex-${String(i).padStart(6, '0')}`);

  await Promise.all(
    names.map((name, i) => repo.registerSession(name, makeOpts(`sess-${i}`)))
  );

  const all = await repo.listRecentSessions(20);
  assert.equal(all.length, 10, 'all 10 sessions should be registered');
  const registeredNames = new Set(all.map((s) => s.name));
  for (const name of names) {
    assert.ok(registeredNames.has(name), `missing: ${name}`);
  }
});

test('SessionRegistryRepo - updateSession persists the latest context usage snapshot', async () => {
  const { repo } = createRepoWithPath();
  await repo.registerSession('cortex-context', makeOpts('sess-context', { backend: 'pi' }));
  const contextUsage = {
    usedTokens: 60000,
    contextWindow: 200000,
    percent: 30,
    accuracy: 'estimate' as const,
    updatedAt: '2026-07-27T12:00:00.000Z',
  };

  await repo.updateSession('cortex-context', { contextUsage });
  repo.invalidate();

  assert.deepEqual((await repo.getById('sess-context'))?.contextUsage, contextUsage);
});

// ── Context snapshot update by stable id ───────────────────────

test('SessionRegistryRepo - updateContextUsage sets and clears a snapshot by stable session id', async () => {
  const { repo } = createRepoWithPath();
  await repo.registerSession('cortex-context-id', makeOpts('sess-context-id', { backend: 'pi' }));
  const usage = {
    usedTokens: 12000, contextWindow: 200000, percent: 6,
    accuracy: 'estimate' as const, updatedAt: '2026-07-28T01:00:00.000Z',
  };
  await repo.updateContextUsage('sess-context-id', usage);
  assert.deepEqual((await repo.getById('sess-context-id'))?.contextUsage, usage);
  await repo.updateContextUsage('sess-context-id', null);
  assert.equal((await repo.getById('sess-context-id'))?.contextUsage, undefined);
});

// ── (b) Mid-mutate flush resolves after all pending mutations ──

test('SessionRegistryRepo - flush() resolves only after all pending mutations (FIFO on mutex)', async () => {
  const { repo } = createRepoWithPath();
  const resolutionOrder: string[] = [];
  const N = 10;

  const mutations = Array.from({ length: N }, (_, i) =>
    repo.registerSession(`cortex-${String(i).padStart(6, '0')}`, makeOpts(`sess-${i}`))
      .then(() => { resolutionOrder.push(`mut-${i}`); })
  );

  const flushDone = repo.flush().then(() => { resolutionOrder.push('flush'); });

  await Promise.all([...mutations, flushDone]);

  assert.equal(resolutionOrder[N], 'flush',
    `flush must be last; got: ${resolutionOrder.join(', ')}`);
});

// ── (c) Cache consistency: write → cached; disk bypass → still cached; invalidate → fresh ──

test('SessionRegistryRepo - cache serves write value; invalidate() picks up disk changes', async () => {
  const { repo, filePath } = createRepoWithPath();

  // Write through the repo so the cache is populated.
  await repo.registerSession('cortex-aabbcc', makeOpts('sess-abc'));

  // Cache hit: record is returned without a disk read.
  const record = await repo.lookupSession('cortex-aabbcc');
  assert.ok(record !== null, 'record should be present in cache');
  assert.equal(record!.sessionId, 'sess-abc');

  // Overwrite the file on disk directly, bypassing the repo cache.
  // The cache should still serve the original value — disk changes are invisible until invalidate().
  await fs.writeFile(filePath, JSON.stringify({ 'sess-abc': { ...record, sessionId: 'STALE-FROM-DISK' } }, null, 2));
  const cachedRecord = await repo.lookupSession('cortex-aabbcc');
  assert.equal(cachedRecord!.sessionId, 'sess-abc',
    'cache should serve original value; disk bypass must not be visible');

  // After invalidate(), the repo reads from disk and returns the updated value.
  repo.invalidate();
  const freshRecord = await repo.lookupSession('cortex-aabbcc');
  assert.equal(freshRecord!.sessionId, 'STALE-FROM-DISK',
    'after invalidate(), repo must return the disk value');
});

// ── (d) Migration: old-format → new-format re-keying ────────────

test('SessionRegistryRepo - migrate converts name-keyed old format to sessionId-keyed new format', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);

  // Write old-format JSON: name-keyed, values without name/projectId fields.
  const oldFormat = {
    'cortex-abc': { sessionId: 'sess-abc', channel: 'C001', backend: 'claude', kind: 'local', createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-06-01T00:00:00.000Z', label: 'first', profileName: null },
    'cortex-def': { sessionId: 'sess-def', channel: 'C002', backend: 'pi', kind: 'scheduled', createdAt: '2025-02-01T00:00:00.000Z', lastUsedAt: '2025-06-02T00:00:00.000Z', label: null, profileName: 'dev' },
  };
  await fs.writeFile(filePath, JSON.stringify(oldFormat, null, 2));

  const repo = new SessionRegistryRepo(filePath);

  // Trigger read + migration.
  const sessions = await repo.listRecentSessions(10);
  assert.equal(sessions.length, 2, 'both sessions should be migrated');

  const abc = await repo.getById('sess-abc');
  assert.ok(abc !== null);
  assert.equal(abc!.name, 'cortex-abc', 'name should equal old key');
  assert.equal(abc!.sessionId, 'sess-abc');
  assert.equal(abc!.projectId, 'general', 'projectId defaults to general without channel-registry');
  assert.equal(abc!.channel, 'C001');
  assert.equal(abc!.kind, 'local');
  assert.equal(abc!.label, 'first');

  const def = await repo.getById('sess-def');
  assert.ok(def !== null);
  assert.equal(def!.name, 'cortex-def');
  assert.equal(def!.sessionId, 'sess-def');
  assert.equal(def!.projectId, 'general');
  assert.equal(def!.profileName, 'dev');
});

test('SessionRegistryRepo - migrate deduplicates by lastUsedAt keeping newest', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);

  // Two entries with same sessionId but different names and lastUsedAt.
  const oldFormat = {
    'cortex-old':  { sessionId: 'sess-dup', channel: 'C001', backend: 'claude', kind: 'local', createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-01-01T00:00:00.000Z', label: null, profileName: null },
    'cortex-newer': { sessionId: 'sess-dup', channel: 'C001', backend: 'claude', kind: 'local', createdAt: '2025-06-01T00:00:00.000Z', lastUsedAt: '2025-06-01T00:00:00.000Z', label: 'newer', profileName: null },
  };
  await fs.writeFile(filePath, JSON.stringify(oldFormat, null, 2));

  const repo = new SessionRegistryRepo(filePath);

  const sessions = await repo.listRecentSessions(10);
  assert.equal(sessions.length, 1, 'duplicate sessionId should be deduplicated to 1');

  const dup = await repo.getById('sess-dup');
  assert.ok(dup !== null);
  assert.equal(dup!.name, 'cortex-newer', 'should keep newer entry name');
  assert.equal(dup!.label, 'newer', 'should keep newer entry fields');
});

test('SessionRegistryRepo - migrate empty file produces empty registry', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);

  await fs.writeFile(filePath, JSON.stringify({}, null, 2));
  const repo = new SessionRegistryRepo(filePath);

  const sessions = await repo.listRecentSessions(10);
  assert.equal(sessions.length, 0);
});

test('SessionRegistryRepo - migrate new format passes through unchanged', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);

  // Write new-format JSON (already has name field) — should skip migration.
  const newFormat = {
    'sess-abc': { name: 'cortex-abc', sessionId: 'sess-abc', projectId: 'my-project', channel: 'C001', backend: 'claude', kind: 'local', createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-06-01T00:00:00.000Z', label: null, profileName: null },
  };
  await fs.writeFile(filePath, JSON.stringify(newFormat, null, 2));

  const repo = new SessionRegistryRepo(filePath);
  const record = await repo.getById('sess-abc');
  assert.ok(record !== null);
  assert.equal(record!.name, 'cortex-abc');
  assert.equal(record!.projectId, 'my-project', 'should preserve existing projectId');
});

// ── (e) getById: O(1) direct lookup ─────────────────────────────

test('SessionRegistryRepo - getById returns session by sessionId, null for missing', async () => {
  const { repo } = createRepoWithPath();
  await repo.registerSession('cortex-001', makeOpts('sess-001'));

  const found = await repo.getById('sess-001');
  assert.ok(found !== null);
  assert.equal(found!.name, 'cortex-001');
  assert.equal(found!.sessionId, 'sess-001');

  const missing = await repo.getById('nonexistent');
  assert.equal(missing, null);
});

// ── (e) listByProject filtering ─────────────────────────────────

test('SessionRegistryRepo - listByProject filters by projectId', async () => {
  const { repo } = createRepoWithPath();

  await repo.registerSession('cortex-proj-a-1', makeOpts('sess-a1', { projectId: 'project-alpha' }));
  await repo.registerSession('cortex-proj-a-2', makeOpts('sess-a2', { projectId: 'project-alpha' }));
  await repo.registerSession('cortex-proj-b-1', makeOpts('sess-b1', { projectId: 'project-beta' }));

  const alpha = await repo.listByProject('project-alpha');
  assert.equal(alpha.length, 2);
  assert.ok(alpha.every((s) => s.projectId === 'project-alpha'));

  const beta = await repo.listByProject('project-beta');
  assert.equal(beta.length, 1);
  assert.equal(beta[0].name, 'cortex-proj-b-1');

  const empty = await repo.listByProject('nonexistent');
  assert.equal(empty.length, 0);
});

// ── (f) listResumable filtering ─────────────────────────────────

test('SessionRegistryRepo - listResumable excludes scheduled sessions', async () => {
  const { repo } = createRepoWithPath();

  await repo.registerSession('cortex-local-1', makeOpts('sess-l1', { kind: 'local' }));
  await repo.registerSession('cortex-scheduled-1', makeOpts('sess-s1', { kind: 'scheduled' }));
  await repo.registerSession('cortex-local-2', makeOpts('sess-l2', { kind: 'local', projectId: 'other-project' }));

  const all = await repo.listResumable();
  assert.equal(all.length, 2, 'should exclude scheduled sessions');
  assert.ok(all.every((s) => s.kind !== 'scheduled'));

  const filtered = await repo.listResumable('other-project');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, 'cortex-local-2');
});

// ── (g) markUsed updates lastUsedAt ─────────────────────────────

test('SessionRegistryRepo - markUsed updates lastUsedAt', async () => {
  const { repo } = createRepoWithPath();

  await repo.registerSession('cortex-marktest', makeOpts('sess-mark'));

  // Read the original lastUsedAt
  const before = await repo.getById('sess-mark');
  assert.ok(before);
  const originalTs = before!.lastUsedAt;

  // Small delay so the timestamp changes
  await new Promise((r) => setTimeout(r, 10));

  await repo.markUsed('sess-mark');
  const after = await repo.getById('sess-mark');
  assert.ok(after);
  assert.ok(new Date(after!.lastUsedAt).getTime() > new Date(originalTs).getTime(),
    'markUsed should advance lastUsedAt');

  // markUsed on nonexistent session should not throw
  await repo.markUsed('nonexistent');
});

// ── (h) pruneStale removes expired sessions ─────────────────────

test('SessionRegistryRepo - pruneStale removes old sessions, keeps recent', async () => {
  const { repo } = createRepoWithPath();

  // Register sessions with explicit past dates via markUsed manipulation
  await repo.registerSession('cortex-fresh', makeOpts('sess-fresh'));
  await repo.registerSession('cortex-stale', makeOpts('sess-stale'));

  // Manually backdate the stale session by directly writing to the file
  const registry = await (repo as any)._repo.read() as any;
  registry['sess-stale'].lastUsedAt = new Date(Date.now() - 86_400_000 * 30).toISOString(); // 30 days ago
  await (repo as any)._repo.write(registry);

  // Also backdate name index would be stale, so invalidate to rebuild
  repo.invalidate();

  const removed = await repo.pruneStale(86_400_000 * 7); // 7 day max age
  assert.equal(removed, 1, 'should remove 1 stale session');

  const fresh = await repo.getById('sess-fresh');
  assert.ok(fresh !== null, 'fresh session should survive');

  const stale = await repo.getById('sess-stale');
  assert.equal(stale, null, 'stale session should be removed');
});

test('SessionRegistryRepo - pruneStale returns 0 when no sessions', async () => {
  const { repo } = createRepoWithPath();
  const removed = await repo.pruneStale(86_400_000);
  assert.equal(removed, 0);
});

// ── (j) origin classification ───────────────────────────────────

test('deriveSessionOrigin - scheduled kind → scheduled, thread label → thread, else direct', () => {
  assert.equal(deriveSessionOrigin('scheduled', null), 'scheduled');
  assert.equal(deriveSessionOrigin('scheduled', '[thr_abc:coder]'), 'scheduled', 'scheduled kind wins over label');
  assert.equal(deriveSessionOrigin('local', '[thr_abc:coder]'), 'thread');
  assert.equal(deriveSessionOrigin('local', '[thr_x123:main]'), 'thread');
  assert.equal(deriveSessionOrigin('local', 'hello world question'), 'direct');
  assert.equal(deriveSessionOrigin('local', null), 'direct');
  assert.equal(deriveSessionOrigin('local', '[not a thread label'), 'direct', 'unbalanced bracket is not a thread label');
});

test('SessionRegistryRepo - registerSession persists an explicit origin', async () => {
  const { repo } = createRepoWithPath();
  await repo.registerSession('cortex-origin-1', makeOpts('sess-o1', { origin: 'thread' }));
  const rec = await repo.getById('sess-o1');
  assert.ok(rec);
  assert.equal(rec!.origin, 'thread');
});

test('SessionRegistryRepo - registerSession derives origin from thread label when omitted', async () => {
  const { repo } = createRepoWithPath();
  await repo.registerSession('cortex-origin-2', makeOpts('sess-o2', { label: '[thr_zzz:reviewer]' }));
  const rec = await repo.getById('sess-o2');
  assert.ok(rec);
  assert.equal(rec!.origin, 'thread', 'thread-labelled local session defaults to thread origin');
});

test('SessionRegistryRepo - registerSession defaults origin to direct for a plain local session', async () => {
  const { repo } = createRepoWithPath();
  await repo.registerSession('cortex-origin-3', makeOpts('sess-o3', { label: 'a normal user message' }));
  const rec = await repo.getById('sess-o3');
  assert.ok(rec);
  assert.equal(rec!.origin, 'direct');
});

test('SessionRegistryRepo - registerSession derives origin=scheduled from scheduled kind', async () => {
  const { repo } = createRepoWithPath();
  await repo.registerSession('cortex-origin-4', makeOpts('sess-o4', { kind: 'scheduled', label: null }));
  const rec = await repo.getById('sess-o4');
  assert.ok(rec);
  assert.equal(rec!.origin, 'scheduled');
});

test('SessionRegistryRepo - migrate backfills origin for old-format records', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);
  const oldFormat = {
    'cortex-direct': { sessionId: 'sess-d', channel: 'C001', backend: 'claude', kind: 'local', createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-06-01T00:00:00.000Z', label: 'plain chat', profileName: null },
    'cortex-thread': { sessionId: 'sess-t', channel: 'C002', backend: 'claude', kind: 'local', createdAt: '2025-02-01T00:00:00.000Z', lastUsedAt: '2025-06-02T00:00:00.000Z', label: '[thr_abc:coder]', profileName: null },
    'cortex-sched': { sessionId: 'sess-s', channel: 'C003', backend: 'claude', kind: 'scheduled', createdAt: '2025-03-01T00:00:00.000Z', lastUsedAt: '2025-06-03T00:00:00.000Z', label: null, profileName: null },
  };
  await fs.writeFile(filePath, JSON.stringify(oldFormat, null, 2));

  const repo = new SessionRegistryRepo(filePath);
  const direct = await repo.getById('sess-d');
  const thread = await repo.getById('sess-t');
  const sched = await repo.getById('sess-s');
  assert.equal(direct!.origin, 'direct');
  assert.equal(thread!.origin, 'thread');
  assert.equal(sched!.origin, 'scheduled');
});

test('SessionRegistryRepo - migrate backfills origin for new-format records missing it', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);
  const newFormat = {
    'sess-nt': { name: 'cortex-nt', sessionId: 'sess-nt', projectId: 'p', channel: 'C1', backend: 'claude', kind: 'local', createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-06-01T00:00:00.000Z', label: '[thr_q:main]', profileName: null },
  };
  await fs.writeFile(filePath, JSON.stringify(newFormat, null, 2));

  const repo = new SessionRegistryRepo(filePath);
  const rec = await repo.getById('sess-nt');
  assert.ok(rec);
  assert.equal(rec!.origin, 'thread', 'new-format record without origin gets it derived');
});

test('SessionRegistryRepo - migrate preserves an existing origin', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);
  const newFormat = {
    'sess-keep': { name: 'cortex-keep', sessionId: 'sess-keep', projectId: 'p', channel: 'C1', backend: 'claude', kind: 'local', origin: 'direct', createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-06-01T00:00:00.000Z', label: '[thr_q:main]', profileName: null },
  };
  await fs.writeFile(filePath, JSON.stringify(newFormat, null, 2));

  const repo = new SessionRegistryRepo(filePath);
  const rec = await repo.getById('sess-keep');
  assert.ok(rec);
  assert.equal(rec!.origin, 'direct', 'explicit origin must not be overwritten by derivation');
});

// ── (k) listByOrigin filtering ──────────────────────────────────

test('SessionRegistryRepo - listByOrigin filters by origin (optionally scoped to project)', async () => {
  const { repo } = createRepoWithPath();
  await repo.registerSession('cortex-d1', makeOpts('sess-d1', { origin: 'direct', projectId: 'pa' }));
  await repo.registerSession('cortex-d2', makeOpts('sess-d2', { origin: 'direct', projectId: 'pb' }));
  await repo.registerSession('cortex-th1', makeOpts('sess-th1', { origin: 'thread', label: '[thr:main]', projectId: 'pa' }));

  const directs = await repo.listByOrigin('direct');
  assert.equal(directs.length, 2);
  assert.ok(directs.every((s) => s.origin === 'direct'));

  const directsPa = await repo.listByOrigin('direct', 'pa');
  assert.equal(directsPa.length, 1);
  assert.equal(directsPa[0].name, 'cortex-d1');
});

// ── (i) name index: lookupSession O(1) after mutations ──────────

test('SessionRegistryRepo - lookupSession uses name index, consistent after register and update', async () => {
  const { repo } = createRepoWithPath();

  // Register and verify lookupSession works
  await repo.registerSession('cortex-index-1', makeOpts('sess-idx1'));
  const r1 = await repo.lookupSession('cortex-index-1');
  assert.ok(r1);
  assert.equal(r1!.sessionId, 'sess-idx1');

  // Register another and verify both are findable
  await repo.registerSession('cortex-index-2', makeOpts('sess-idx2'));
  const r2 = await repo.lookupSession('cortex-index-2');
  assert.ok(r2);

  // lookupSession for nonexistent name returns null
  const missing = await repo.lookupSession('cortex-nonexistent');
  assert.equal(missing, null);
});

test('SessionRegistryRepo - name index survives invalidate', async () => {
  const { repo } = createRepoWithPath();

  await repo.registerSession('cortex-persist', makeOpts('sess-persist'));
  repo.invalidate();

  // After invalidate, lookupSession should rebuild the index and still find the session
  const r = await repo.lookupSession('cortex-persist');
  assert.ok(r);
  assert.equal(r!.sessionId, 'sess-persist');
});

// ── markRead (unread tracking) ─────────────────────────────────

test('SessionRegistryRepo - markRead stamps lastReadAt on the target session only', async () => {
  const { repo } = createRepoWithPath();
  await repo.registerSession('cortex-read01', makeOpts('sess-read-1'));
  await repo.registerSession('cortex-read02', makeOpts('sess-read-2'));

  const before = new Date().toISOString();
  await repo.markRead('sess-read-1');

  const s1 = await repo.getById('sess-read-1');
  const s2 = await repo.getById('sess-read-2');
  assert.ok(s1?.lastReadAt, 'target session has lastReadAt');
  assert.ok(s1!.lastReadAt! >= before, 'lastReadAt is stamped now');
  assert.equal(s2?.lastReadAt ?? null, null, 'other session untouched');
});

test('SessionRegistryRepo - markRead is a no-op for an unknown sessionId', async () => {
  const { repo } = createRepoWithPath();
  await repo.registerSession('cortex-read03', makeOpts('sess-read-3'));
  await repo.markRead('sess-missing');
  const s = await repo.getById('sess-read-3');
  assert.equal(s?.lastReadAt ?? null, null);
});
