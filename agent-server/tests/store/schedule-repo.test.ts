// input:  Vitest, temp schedules and channel mappings
// output: Schedule CRUD, migration, and cache regressions
// pos:    Persistence regressions for schedules.json
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ScheduleRepo, type ScheduleTask } from '../../src/store/schedule-repo.js';

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-schedule-repo-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helper: fresh repo + file per test ─────────────────────────

let _testIdx = 0;
function createRepo(): ScheduleRepo {
  const idx = _testIdx++;
  return new ScheduleRepo(path.join(tmpDir, `schedules-${idx}.json`));
}

function makeTask(overrides = {}): ScheduleTask {
  return {
    id: `task-${Math.random().toString(16).slice(2, 8)}`,
    type: 'interval',
    message: 'test task',
    projectId: 'project-one',
    profile: 'plan',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ── Concurrent mutate: no lost schedules ───────────────────────

test('ScheduleRepo - 10 concurrent addTask produce all 10 entries', async () => {
  const repo = createRepo();

  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      repo.addTask(makeTask({ id: `task-${i}`, message: `task ${i}` }))
    )
  );

  const data = await repo.read();
  assert.equal(data.tasks.length, 10, 'all 10 tasks should be added');
  for (let i = 0; i < 10; i++) {
    assert.equal(data.tasks[i].id, `task-${i}`);
  }
});

// ── Flush: mid-mutate flush resolves after pending mutations ──

test('ScheduleRepo - flush() resolves only after all pending mutations (FIFO on mutex)', async () => {
  const repo = createRepo();

  const resolutionOrder: string[] = [];
  const N = 10;

  const mutations = Array.from({ length: N }, (_, i) =>
    repo.addTask(makeTask({ id: `task-${i}`, message: `task ${i}` }))
      .then(() => { resolutionOrder.push(`mut-${i}`); })
  );

  const flushDone = repo.flush().then(() => { resolutionOrder.push('flush'); });

  await Promise.all([...mutations, flushDone]);

  assert.equal(resolutionOrder[N], 'flush',
    `flush must be last; got ${resolutionOrder.join(', ')}`);
});

// ── CRUD: find / add / remove / update ────────────────────────

test('ScheduleRepo - findTask returns null for unknown id', async () => {
  const repo = createRepo();
  const result = await repo.findTask('nonexistent');
  assert.equal(result, null);
});

test('ScheduleRepo - addTask then findTask returns the task', async () => {
  const repo = createRepo();
  const task = makeTask({ id: 'add-test' });
  await repo.addTask(task);

  const found = await repo.findTask('add-test');
  assert.ok(found);
  assert.equal(found.message, task.message);
  assert.equal(found.projectId, task.projectId);
});

test('ScheduleRepo - removeTask returns true for existing id', async () => {
  const repo = createRepo();
  await repo.addTask(makeTask({ id: 'remove-test' }));

  const removed = await repo.removeTask('remove-test');
  assert.equal(removed, true);
  assert.equal(await repo.findTask('remove-test'), null);
});

test('ScheduleRepo - removeTask returns false for unknown id', async () => {
  const repo = createRepo();
  const removed = await repo.removeTask('does-not-exist');
  assert.equal(removed, false);
});

test('ScheduleRepo - updateTask applies callback and returns updated task', async () => {
  const repo = createRepo();
  await repo.addTask(makeTask({ id: 'update-test', message: 'original' }));

  const updated = await repo.updateTask('update-test', (t) => {
    t.message = 'updated';
    t.isPaused = true;
  });
  assert.ok(updated);
  assert.equal(updated.message, 'updated');
  assert.equal(updated.isPaused, true);

  // Verify persisted
  const found = await repo.findTask('update-test');
  assert.equal(found!.message, 'updated');
  assert.equal(found!.isPaused, true);
});

test('ScheduleRepo - updateTask returns null for unknown id', async () => {
  const repo = createRepo();
  const result = await repo.updateTask('no-such-id', () => {});
  assert.equal(result, null);
});

test('ScheduleRepo - read returns all tasks after mixed operations', async () => {
  const repo = createRepo();
  await repo.addTask(makeTask({ id: 'a', message: 'A' }));
  await repo.addTask(makeTask({ id: 'b', message: 'B' }));
  await repo.removeTask('a');
  await repo.addTask(makeTask({ id: 'c', message: 'C' }));

  const data = await repo.read();
  assert.equal(data.tasks.length, 2);
  const ids = data.tasks.map(t => t.id).sort();
  assert.deepEqual(ids, ['b', 'c']);
});

// ── On-disk schema matches SchedulesData ──────────────────────

test('ScheduleRepo - on-disk schema contains schedule tasks only', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `schedules-${idx}.json`);
  const repo = new ScheduleRepo(filePath);
  await repo.addTask(makeTask({ id: 'schema-1', type: 'interval', intervalMs: 3600000 }));
  await repo.flush();

  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(Object.keys(raw), ['tasks']);
  assert.equal(raw.tasks[0].id, 'schema-1');
});

// ── target / fallback fields round-trip ───────────────────────

test('ScheduleRepo - target field round-trips through addTask/findTask (project kind)', async () => {
  const repo = createRepo();
  const task = makeTask({
    id: 'target-project',
    target: { kind: 'project', projectId: 'cortex-self' },
    fallback: 'fresh',
  } as Partial<ScheduleTask>);
  await repo.addTask(task);
  const found = await repo.findTask('target-project');
  assert.ok(found);
  assert.deepEqual(found.target, { kind: 'project', projectId: 'cortex-self' });
  assert.equal(found.fallback, 'fresh');
});

test('ScheduleRepo - target field round-trips for thread kind', async () => {
  const repo = createRepo();
  await repo.addTask(makeTask({
    id: 'target-thread',
    target: { kind: 'thread', threadId: 'thr_xyz', channel: 'C1' },
  } as Partial<ScheduleTask>));
  const t = await repo.findTask('target-thread');
  assert.ok(t && t.target?.kind === 'thread');
  assert.equal((t.target as { threadId: string }).threadId, 'thr_xyz');
});

test('ScheduleRepo - migrate fills target=fresh for legacy records without target field', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `schedules-${idx}.json`);
  // Write an old-format record (no target/fallback fields) directly to disk
  await fs.writeFile(filePath, JSON.stringify({
    tasks: [{ id: 'legacy-1', type: 'interval', intervalMs: 60000, message: 'old task', channel: 'C1', profile: 'plan', createdAt: Date.now() }],
  }));
  const repo = new ScheduleRepo(filePath);
  const found = await repo.findTask('legacy-1');
  assert.ok(found, 'legacy task should still load');
  assert.deepEqual(found.target, { kind: 'fresh' }, 'migrate should default target to fresh');
});

// ── Invalidate: clears cache so next read fetches from disk ────

test('ScheduleRepo - invalidate() clears in-memory cache', async () => {
  const idx = _testIdx++;
  const filePath = path.join(tmpDir, `schedules-${idx}.json`);
  const repo = new ScheduleRepo(filePath);
  await repo.addTask(makeTask({ id: 'cache-1' }));
  assert.equal((await repo.read()).tasks.length, 1);

  // Write directly to disk, bypassing the repo
  await fs.writeFile(filePath, JSON.stringify({ tasks: [{ id: 'external', type: 'interval', message: 'external', projectId: 'project-one', profile: 'plan', createdAt: Date.now() }] }));

  // Without invalidate, cache would still have the old data
  repo.invalidate();
  const data = await repo.read();
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].id, 'external');
});

// ── Fixture-based migration: channel → projectId ────────────────

test('ScheduleRepo - migrate converts channel to projectId via channel-registry reverse lookup', async () => {
  const idx = _testIdx++;
  const dirPath = path.join(tmpDir, `migrate-${idx}`);
  await fs.mkdir(dirPath, { recursive: true });
  const schedulesFile = path.join(dirPath, 'schedules.json');
  const channelRegistryFile = path.join(dirPath, 'channel-registry.json');

  // Create channel-registry.json with known mappings
  await fs.writeFile(channelRegistryFile, JSON.stringify({
    'cortex-self': 'C12345',
    research: 'C67890',
  }));

  // Write legacy-format schedules.json with mix of old and new format records
  const now = Date.now();
  await fs.writeFile(schedulesFile, JSON.stringify({
    tasks: [
      // Legacy record: channel is mapped in channel-registry
      { id: 'mapped', type: 'interval', intervalMs: 60000, message: 'mapped task', channel: 'C12345', profile: 'plan', createdAt: now },
      // Legacy record: channel is NOT in channel-registry → fallback to 'general'
      { id: 'unmapped', type: 'daily', time: '09:00', message: 'unmapped task', channel: 'C99999', profile: null, createdAt: now },
      // New-format record: already has projectId → pass through unchanged
      { id: 'new-format', type: 'once', runAt: now + 60000, message: 'new format task', projectId: 'research', profile: 'plan', createdAt: now },
      // Mixed: has both channel and projectId → remove channel, keep projectId
      { id: 'mixed', type: 'interval', intervalMs: 30000, message: 'mixed task', channel: 'C67890', projectId: 'research', profile: null, createdAt: now },
    ],
  }));

  const repo = new ScheduleRepo(schedulesFile, channelRegistryFile);

  // Read all tasks through migration
  const data = await repo.read();
  assert.equal(data.tasks.length, 4);

  // mapped: legacy channel → resolved projectId
  const mapped = data.tasks.find(t => t.id === 'mapped')!;
  assert.ok(mapped, 'mapped task should exist');
  assert.equal(mapped.projectId, 'cortex-self', 'mapped channel → correct projectId');
  assert.equal('channel' in (mapped as any), false, 'channel field should be removed');

  // unmapped: legacy channel → fallback to 'general'
  const unmapped = data.tasks.find(t => t.id === 'unmapped')!;
  assert.ok(unmapped, 'unmapped task should exist');
  assert.equal(unmapped.projectId, 'general', 'unmapped channel → general fallback');
  assert.equal('channel' in (unmapped as any), false, 'channel field should be removed');

  // new-format: already has projectId → pass through
  const newFormat = data.tasks.find(t => t.id === 'new-format')!;
  assert.ok(newFormat, 'new-format task should exist');
  assert.equal(newFormat.projectId, 'research', 'new-format projectId preserved');
  assert.equal('channel' in (newFormat as any), false, 'stale channel should be removed if present');

  // mixed: has both → keep projectId, remove channel
  const mixed = data.tasks.find(t => t.id === 'mixed')!;
  assert.ok(mixed, 'mixed task should exist');
  assert.equal(mixed.projectId, 'research', 'mixed task projectId preserved');
  assert.equal('channel' in (mixed as any), false, 'channel field should be removed from mixed task');
});

test('ScheduleRepo - migrate is idempotent on re-read', async () => {
  const idx = _testIdx++;
  const dirPath = path.join(tmpDir, `idempotent-${idx}`);
  await fs.mkdir(dirPath, { recursive: true });
  const schedulesFile = path.join(dirPath, 'schedules.json');
  const channelRegistryFile = path.join(dirPath, 'channel-registry.json');

  await fs.writeFile(channelRegistryFile, JSON.stringify({ 'cortex-self': 'C12345' }));
  const now = Date.now();
  await fs.writeFile(schedulesFile, JSON.stringify({
    tasks: [
      { id: 'legacy', type: 'interval', intervalMs: 60000, message: 'old', channel: 'C12345', profile: null, createdAt: now },
      { id: 'new', type: 'daily', time: '10:00', message: 'new', projectId: 'cortex-self', profile: 'plan', createdAt: now },
    ],
  }));

  const repo = new ScheduleRepo(schedulesFile, channelRegistryFile);

  // First read: migrate
  const data1 = await repo.read();
  assert.equal(data1.tasks.length, 2);
  assert.equal(data1.tasks.find(t => t.id === 'legacy')!.projectId, 'cortex-self');

  // Invalidate cache + re-read: idempotent
  repo.invalidate();
  const data2 = await repo.read();
  assert.equal(data2.tasks.length, 2);
  assert.equal(data2.tasks.find(t => t.id === 'legacy')!.projectId, 'cortex-self');
  assert.equal(data2.tasks.find(t => t.id === 'new')!.projectId, 'cortex-self');

  // No stale fields
  for (const t of data2.tasks) {
    assert.equal('channel' in (t as any), false, `no channel field on ${t.id}`);
  }
});
