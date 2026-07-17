// input:  Node test runner, assert, tmp filesystem
// output: Gap tests for SessionRegistryRepo: fixture migration + idempotency, registerSession projectId, GC eligibility with executionRepo/threadStore references
// pos:    verifies store/session-registry-repo.ts M2 contract per plan/refactor-m1m2-project-session.md
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';
import { executionRepo } from '../../src/store/execution-repo.js';
import { threadStore } from '../../src/store/thread-repo.js';
import type { ThreadRecord } from '../../src/core/types/thread-types.js';

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-store-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helper ──────────────────────────────────────────────────────

let _testIdx = 0;

// ── Test 1: Migration fixture + idempotency ────────────────────

test('sessionStore - migrate old fixture: re-key, projectId backfill, dedup, idempotent second read', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);

  // Old-format fixture: name-keyed, no name/projectId fields; includes duplicate sessionId
  const oldFormat = {
    'cortex-abc': { sessionId: 'sess-abc', channel: 'C001', backend: 'claude', kind: 'local', createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-06-01T00:00:00.000Z', label: 'first', profileName: null },
    'cortex-def': { sessionId: 'sess-def', channel: 'C002', backend: 'codex', kind: 'scheduled', createdAt: '2025-02-01T00:00:00.000Z', lastUsedAt: '2025-06-02T00:00:00.000Z', label: null, profileName: 'dev' },
    // Duplicate sessionId — should be deduped keeping the newer one
    'cortex-dup-old': { sessionId: 'sess-dup', channel: 'C001', backend: 'claude', kind: 'local', createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-01-01T00:00:00.000Z', label: 'old', profileName: null },
    'cortex-dup-new': { sessionId: 'sess-dup', channel: 'C001', backend: 'claude', kind: 'local', createdAt: '2025-06-01T00:00:00.000Z', lastUsedAt: '2025-06-01T00:00:00.000Z', label: 'new', profileName: null },
  };
  await fs.writeFile(filePath, JSON.stringify(oldFormat, null, 2));

  const repo = new SessionRegistryRepo(filePath);

  // ── First read: triggers migration ──
  const firstRead = await repo.listRecentSessions(10);
  assert.equal(firstRead.length, 3, '4 entries → 3 after dedup (sess-dup deduped)');

  // Verify re-key: getById uses sessionId key
  const abc = await repo.getById('sess-abc');
  assert.ok(abc !== null);
  assert.equal(abc.name, 'cortex-abc', 'name preserved from old key');
  assert.equal(abc.sessionId, 'sess-abc');
  assert.equal(abc.projectId, 'general', 'projectId defaulted to general (no channel-registry)');
  assert.equal(abc.channel, 'C001');

  // Verify dedup: kept the newer entry
  const dup = await repo.getById('sess-dup');
  assert.ok(dup !== null);
  assert.equal(dup.name, 'cortex-dup-new', 'kept newer entry name');
  assert.equal(dup.label, 'new', 'kept newer entry fields');

  // ── Second read: idempotent — no duplicate entries ──
  const secondRead = await repo.listRecentSessions(10);
  assert.equal(secondRead.length, 3, 'second read produces same count (idempotent)');

  // Verify individual records match
  const abc2 = await repo.getById('sess-abc');
  assert.deepEqual(abc2, abc);
});

// ── Test 2: registerSession projectId defaults ────────────────

test('sessionStore - registerSession defaults projectId to general when omitted or undefined', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);
  const repo = new SessionRegistryRepo(filePath);

  // No projectId passed — should default to 'general'
  await repo.registerSession('cortex-noproj', {
    sessionId: 'sess-noproj',
    channel: 'C001',
    backend: 'claude',
    kind: 'local',
  });

  const record = await repo.getById('sess-noproj');
  assert.ok(record !== null);
  assert.equal(record.projectId, 'general', 'projectId should default to general when omitted');

  // Explicit undefined projectId — should also default to 'general'
  await repo.registerSession('cortex-undef', {
    sessionId: 'sess-undef',
    channel: 'C001',
    backend: 'claude',
    kind: 'local',
    projectId: undefined,
  });

  const record2 = await repo.getById('sess-undef');
  assert.ok(record2 !== null);
  assert.equal(record2.projectId, 'general', 'explicit undefined projectId should default to general');
});

// ── Test 3: registerSession persists projectId to disk ─────────

test('sessionStore - registerSession persists projectId to disk', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);
  const repo = new SessionRegistryRepo(filePath);

  await repo.registerSession('cortex-proj', {
    sessionId: 'sess-proj',
    channel: 'C001',
    backend: 'claude',
    kind: 'local',
    projectId: 'my-project',
  });

  // Read the file directly from disk
  const raw = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  assert.ok(data['sess-proj'] !== undefined, 'session should exist in persisted JSON');
  assert.equal(data['sess-proj'].projectId, 'my-project', 'projectId should be persisted to disk');
  assert.equal(data['sess-proj'].name, 'cortex-proj', 'name should be persisted');
});

// ── Test 4: GC eligibility — referenced sessions survive ───────

test('sessionStore - pruneStale keeps expired sessions referenced by executionRepo or threadStore', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `session-registry-${idx}.json`);
  const repo = new SessionRegistryRepo(filePath);

  // Register 4 sessions
  await repo.registerSession('cortex-exec-ref', {
    sessionId: 'sess-exec-ref', channel: 'C001', backend: 'claude', kind: 'local', projectId: 'p1',
  });
  await repo.registerSession('cortex-thread-ref', {
    sessionId: 'sess-thread-ref', channel: 'C001', backend: 'claude', kind: 'local', projectId: 'p1',
  });
  await repo.registerSession('cortex-unref', {
    sessionId: 'sess-unref', channel: 'C001', backend: 'claude', kind: 'local', projectId: 'p1',
  });
  await repo.registerSession('cortex-fresh', {
    sessionId: 'sess-fresh', channel: 'C001', backend: 'claude', kind: 'local', projectId: 'p1',
  });

  // Backdate 3 sessions to be stale (30 days old)
  const registry = await (repo as any)._repo.read();
  registry['sess-exec-ref'].lastUsedAt = new Date(Date.now() - 86_400_000 * 30).toISOString();
  registry['sess-thread-ref'].lastUsedAt = new Date(Date.now() - 86_400_000 * 30).toISOString();
  registry['sess-unref'].lastUsedAt = new Date(Date.now() - 86_400_000 * 30).toISOString();
  await (repo as any)._repo.write(registry);
  repo.invalidate();

  // Seed executionRepo with a reference to sess-exec-ref
  executionRepo.startLocalExecution({ sessionId: 'sess-exec-ref', channel: 'C001', project: 'p1' });

  // Seed threadStore with a reference to sess-thread-ref (via agents[].sessionId)
  const threadRecord: ThreadRecord = {
    id: 'thr_gc_test',
    templateName: null,
    status: 'running',
    channel: 'C001',
    projectId: 'p1',
    platformThreadId: null,
    userMessage: 'test',
    userMessageTs: Date.now().toString(),
    workspacePath: '/tmp/test-workspace',
    artifactPath: '/tmp/test-workspace/artifact.md',
    agents: {
      agent1: {
        slotId: 'agent1',
        profile: 'default',
        sessionId: 'sess-thread-ref',
        sessionName: null,
        status: 'completed',
        lastOutput: null,
        persistSession: false,
      },
    },
    activeAgent: 'agent1',
    activeStage: null,
    currentStepIndex: 0,
    steps: [],
    iterationCounts: {},
    totalCostUsd: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    abortReason: null,
  };
  await threadStore.set(threadRecord);

  // Prune with 7-day TTL — should remove only sess-unref
  const removed = await repo.pruneStale(86_400_000 * 7);
  assert.equal(removed, 1, 'only 1 unreferenced stale session should be removed');

  // Referenced sessions survive pruning
  const execRef = await repo.getById('sess-exec-ref');
  assert.ok(execRef !== null, 'executionRepo-referenced session should survive pruning');

  const threadRef = await repo.getById('sess-thread-ref');
  assert.ok(threadRef !== null, 'threadStore-referenced session should survive pruning');

  // Unreferenced stale session is removed
  const unref = await repo.getById('sess-unref');
  assert.equal(unref, null, 'unreferenced stale session should be removed');

  // Fresh session survives
  const fresh = await repo.getById('sess-fresh');
  assert.ok(fresh !== null, 'fresh session should survive');
});
