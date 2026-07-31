// input:  resumed task loops, waiting sweeps, mutable settings
// output: task event closure and sweep scheduling regressions
// pos:    Resumed dispatch and waiting-manager backstop tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { threadStore } from '../src/store/thread-repo.js';
import { closeResumedTaskLoop, startWaitingManagerSweep, sweepWaitingManagers } from '../src/orchestration/thread-callback.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const liveSettings = vi.hoisted(() => ({ managerRotateSteps: 10, waitingSweepMs: 60_000 }));
vi.mock('@core/settings.js', () => ({ getSettings: () => liveSettings }));

const createdThreadIds = new Set<string>();
const projectDirs: string[] = [];
let seq = 0;

beforeEach(() => {
  liveSettings.managerRotateSteps = 10;
  liveSettings.waitingSweepMs = 60_000;
});

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
  for (const d of projectDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function makeProject(name: string, tasksYaml: string): void {
  const dir = path.join(PROJECTS_DIR, name);
  projectDirs.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TASKS.yaml'), tasksYaml);
}

function taskYaml(id: string, over: Record<string, string> = {}): string {
  const lines = [
    `  - id: "${id}"`,
    `    text: task ${id}`,
    '    why: w',
    `    done-when: criteria for ${id}`,
    '    priority: medium',
    `    status: ${over.status ?? 'open'}`,
    '    template: coder-review',
    '    plan: p',
  ];
  if (over.blocked) lines.push(`    blocked-by: ${over.blocked}`);
  return lines.join('\n') + '\n';
}

function makeWorker(proj: string, taskId: string | null, status: ThreadStatus, over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = `thr_rt${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: 'coder-review', status,
    channel: 'C-rt-test', projectId: proj, platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'coder', activeStage: null, currentStepIndex: 1,
    steps: [], iterationCounts: {}, totalCostUsd: 0, createdAt: now, updatedAt: now,
    endedAt: status === 'completed' ? now : null, error: null, abortReason: null,
    metadata: taskId ? { trigger: 'task-dispatch', taskId, taskProject: proj } : null,
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

function capture() {
  const published: Array<{ type: string; taskId?: string; reason?: string }> = [];
  return { published, publish: (e: any) => published.push(e) };
}

test('closeResumedTaskLoop publishes task.completed for a terminal task-dispatch thread whose task is done', async () => {
  const proj = `_rt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa20', { status: 'done' }));
  const w = makeWorker(proj, 'aa20', 'completed');
  const { published, publish } = capture();
  await closeResumedTaskLoop(w.id, { publish });
  assert.deepEqual(published, [{ type: 'task.completed', taskId: 'aa20' }]);
});

test('closeResumedTaskLoop publishes task.blocked when the task is blocked on disk', async () => {
  const proj = `_rt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa21', { blocked: 'worker-abort:too-big' }));
  // A worker that aborted lands terminal as failed/aborted; the task is blocked on disk.
  const w = makeWorker(proj, 'aa21', 'failed');
  const { published, publish } = capture();
  await closeResumedTaskLoop(w.id, { publish });
  assert.deepEqual(published, [{ type: 'task.blocked', taskId: 'aa21', reason: 'worker-abort:too-big' }]);
});

test('closeResumedTaskLoop is a no-op for a non-terminal (re-suspended) thread', async () => {
  const proj = `_rt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa22', { status: 'done' }));
  const w = makeWorker(proj, 'aa22', 'waiting');
  const { published, publish } = capture();
  await closeResumedTaskLoop(w.id, { publish });
  assert.equal(published.length, 0, 'suspension is not completion — let reconcile/dispatch handle it');
});

test('closeResumedTaskLoop is a no-op for a non-task-dispatch thread', async () => {
  const proj = `_rt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa23', { status: 'done' }));
  const w = makeWorker(proj, null, 'completed'); // metadata null → not a dispatch thread
  const { published, publish } = capture();
  await closeResumedTaskLoop(w.id, { publish });
  assert.equal(published.length, 0);
});

test('closeResumedTaskLoop does not publish while the task is still open on disk (worker did not complete it)', async () => {
  const proj = `_rt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa24', { status: 'open' }));
  const w = makeWorker(proj, 'aa24', 'completed');
  const { published, publish } = capture();
  await closeResumedTaskLoop(w.id, { publish });
  assert.equal(published.length, 0, 'nothing terminal on disk to report');
});

// --- sweepWaitingManagers: periodic disk-driven backstop ---

function makeWaitingManager(proj: string, taskId: string, waitingOnTasks: string[]): ThreadRecord {
  return makeWorker(proj, taskId, 'waiting', {
    templateName: 'manager',
    metadata: { trigger: 'task-dispatch', taskId, taskProject: proj, waitingOnTasks: [...waitingOnTasks] },
  });
}

test('sweepWaitingManagers delivers an already-done child the fast paths missed and resumes when last', async () => {
  const proj = `_rt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('mm30', { status: 'open' }) + taskYaml('cc30', { status: 'done' }));
  const mgr = makeWaitingManager(proj, 'mm30', ['cc30']);
  const resumed: string[] = [];
  const n = await sweepWaitingManagers({ resume: (id) => resumed.push(id) });

  assert.ok(n >= 1, 'swept at least the one waiting manager');
  const t = threadStore.get(mgr.id)!;
  assert.deepEqual(t.metadata!.waitingOnTasks, [], 'done child delivered, list emptied');
  assert.deepEqual(resumed, [mgr.id], 'manager resumed once list empty');
});

test('sweepWaitingManagers keeps a manager waiting on a still-open child (no spurious resume)', async () => {
  const proj = `_rt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('mm31', { status: 'open' }) + taskYaml('cc31', { status: 'open' }));
  const mgr = makeWaitingManager(proj, 'mm31', ['cc31']);
  const resumed: string[] = [];
  await sweepWaitingManagers({ resume: (id) => resumed.push(id) });

  assert.deepEqual(threadStore.get(mgr.id)!.metadata!.waitingOnTasks, ['cc31']);
  assert.equal(resumed.length, 0);
});

test('waiting sweep re-arms with the current interval and runtime zero stops the loop', async () => {
  vi.useFakeTimers();
  const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  try {
    liveSettings.waitingSweepMs = 100;
    startWaitingManagerSweep();
    assert.ok(timeoutSpy.mock.calls.some(([, delay]) => delay === 100));

    liveSettings.waitingSweepMs = 250;
    await vi.advanceTimersByTimeAsync(100);
    assert.ok(timeoutSpy.mock.calls.some(([, delay]) => delay === 250), 'next round uses the updated interval');

    liveSettings.waitingSweepMs = 0;
    await vi.advanceTimersByTimeAsync(250);
    const sweepDelays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay) => delay === 100 || delay === 250);
    assert.deepEqual(sweepDelays, [100, 250], 'zero prevents another re-arm after the pending round');

    const timerCount = vi.getTimerCount();
    startWaitingManagerSweep();
    assert.equal(vi.getTimerCount(), timerCount, 'startup zero does not start a dormant loop');
  } finally {
    timeoutSpy.mockRestore();
    vi.useRealTimers();
  }
});
