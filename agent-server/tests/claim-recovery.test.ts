// input:  Node test runner + domain/tasks/claim-recovery
// output: recoverOrphanedClaims policy tests (crash-orphan claim reconciliation)
// pos:    Verify startup auto-unclaim of dispatcher claims orphaned by a server crash —
//         a claimed task is invisible to the dispatcher, so a dead claim strands the task
//         (and any manager waiting on it) forever without this recovery.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { threadStore } from '../src/store/thread-repo.js';
import { rawToTask } from '../src/core/task-parser.js';
import { recoverOrphanedClaims } from '../src/domain/tasks/claim-recovery.js';
import type { Task } from '../src/core/task-parser.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

function makeTask(id: string, over: Record<string, unknown> = {}): Task {
  return rawToTask({ id, text: `task ${id}`, status: 'open', ...over }, '_cr_proj');
}

function makeThread(taskId: string | null, status: ThreadStatus): ThreadRecord {
  const id = `thr_cr${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: 'manager', status,
    channel: 'C-cr-test', projectId: '_cr_proj', platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'manager', activeStage: null, currentStepIndex: 1,
    steps: [], iterationCounts: {}, totalCostUsd: 0, createdAt: now, updatedAt: now,
    endedAt: null, error: null, abortReason: null,
    metadata: { trigger: 'task-dispatch', taskId, taskProject: '_cr_proj' },
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

function run(tasks: Task[], over: { isTracked?: (id: string) => boolean; failOn?: string[] } = {}) {
  const unclaimed: string[] = [];
  const result = recoverOrphanedClaims({
    scan: () => tasks,
    isTracked: over.isTracked ?? (() => false),
    unclaim: async (id) => {
      if (over.failOn?.includes(id)) throw new Error('boom');
      unclaimed.push(id);
      return { success: true };
    },
  });
  return result.then((ids) => ({ ids, unclaimed }));
}

test('unclaims a dispatcher-claimed open task with no surviving owner', async () => {
  const { ids, unclaimed } = await run([makeTask('aa01', { 'claimed-by': 'task-dispatcher' })]);
  assert.deepEqual(ids, ['aa01']);
  assert.deepEqual(unclaimed, ['aa01']);
});

test('respects manual (non-dispatcher) claims', async () => {
  const { ids } = await run([makeTask('aa02', { 'claimed-by': 'cortex-local' })]);
  assert.deepEqual(ids, []);
});

test('skips unclaimed / done / pending / blocked tasks', async () => {
  const { ids } = await run([
    makeTask('aa03'),
    makeTask('bb03', { 'claimed-by': 'task-dispatcher', status: 'done' }),
    makeTask('cc03', { 'claimed-by': 'task-dispatcher', status: 'pending' }),
    makeTask('dd03', { 'claimed-by': 'task-dispatcher', 'blocked-by': 'stuck' }),
  ]);
  assert.deepEqual(ids, []);
});

test('a waiting (suspended manager) thread protects its task claim', async () => {
  makeThread('aa04', 'waiting');
  const { ids } = await run([makeTask('aa04', { 'claimed-by': 'task-dispatcher' })]);
  assert.deepEqual(ids, []);
});

test('a rate_limited thread protects its task claim', async () => {
  makeThread('aa05', 'rate_limited');
  const { ids } = await run([makeTask('aa05', { 'claimed-by': 'task-dispatcher' })]);
  assert.deepEqual(ids, []);
});

test('a failed thread does NOT protect its task claim (the crash orphan case)', async () => {
  makeThread('aa06', 'failed');
  const { ids } = await run([makeTask('aa06', { 'claimed-by': 'task-dispatcher' })]);
  assert.deepEqual(ids, ['aa06']);
});

test('remote-tracked tasks (pending-tracker) are left alone', async () => {
  const { ids } = await run(
    [makeTask('aa07', { 'claimed-by': 'task-dispatcher' })],
    { isTracked: (id) => id === 'aa07' },
  );
  assert.deepEqual(ids, []);
});

test('one failing unclaim does not abort the sweep', async () => {
  const { ids, unclaimed } = await run(
    [
      makeTask('aa08', { 'claimed-by': 'task-dispatcher' }),
      makeTask('bb08', { 'claimed-by': 'task-dispatcher' }),
    ],
    { failOn: ['aa08'] },
  );
  assert.deepEqual(ids, ['bb08']);
  assert.deepEqual(unclaimed, ['bb08']);
});
