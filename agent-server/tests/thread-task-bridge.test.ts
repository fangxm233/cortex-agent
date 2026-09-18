import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { threadStore } from '../src/store/thread-repo.js';
import { buildTaskResultNotice } from '../src/orchestration/thread-notices.js';
import {
  notifyTaskParentThreads,
  reconcileWaitingTasks,
  recoverWaitingThreads,
  _testResetCallbackState,
} from '../src/orchestration/thread-callback.js';
import { rawToTask } from '../src/core/task-parser.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
const projectDirs: string[] = [];
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
  for (const d of projectDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function makeProject(name: string, tasksYaml: string): string {
  const dir = path.join(PROJECTS_DIR, name);
  projectDirs.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TASKS.yaml'), tasksYaml);
  return path.join(dir, 'TASKS.yaml');
}

function taskYaml(id: string, over: Record<string, string> = {}): string {
  const lines = [
    `  - id: "${id}"`,
    `    text: ${over.text ?? `task ${id}`}`,
    '    why: w',
    `    done-when: ${over.doneWhen ?? 'criteria for ' + id}`,
    '    priority: medium',
    `    status: ${over.status ?? 'open'}`,
    '    template: coder-review',
    '    plan: p',
  ];
  if (over.parent) lines.push(`    parent: "${over.parent}"`);
  if (over.blocked) lines.push(`    blocked-by: ${over.blocked}`);
  if (over.note) lines.push(`    completed-note: ${over.note}`);
  if (over.generation) lines.push(`    dispatch-generation: ${over.generation}`);
  return lines.join('\n') + '\n';
}

function makeManager(proj: string, taskId: string, waitingOnTasks: string[], over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = `thr_tb${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: 'manager', status: 'waiting' as ThreadStatus,
    channel: 'C-tb-test', projectId: proj, platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'manager', activeStage: null, currentStepIndex: 1,
    steps: [], iterationCounts: {}, totalCostUsd: 0, createdAt: now, updatedAt: now,
    endedAt: null, error: null, abortReason: null,
    metadata: { trigger: 'task-dispatch', taskId, taskProject: proj, waitingOnTasks: [...waitingOnTasks] },
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

// --- buildTaskResultNotice ---

// --- notifyTaskParentThreads ---

test('notifyTaskParentThreads delivers a done child and keeps waiting on siblings', async () => {
  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa10') + taskYaml('bb10', { parent: 'aa10', status: 'done' }) + taskYaml('cc10', { parent: 'aa10' }));
  const mgr = makeManager(proj, 'aa10', ['bb10', 'cc10']);
  const resumed: string[] = [];
  await notifyTaskParentThreads('bb10', 'completed', { resume: (id) => resumed.push(id) });

  const t = threadStore.get(mgr.id)!;
  assert.deepEqual(t.metadata!.waitingOnTasks, ['cc10']);
  assert.equal(t.metadata!.pendingMessages!.length, 1);
  assert.match(t.metadata!.pendingMessages![0], /bb10/);
  assert.equal(resumed.length, 0);
});

test('notifyTaskParentThreads resumes when the last awaited task completes', async () => {
  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa11') + taskYaml('bb11', { parent: 'aa11', status: 'done' }));
  const mgr = makeManager(proj, 'aa11', ['bb11']);
  const resumed: string[] = [];
  await notifyTaskParentThreads('bb11', 'completed', { resume: (id) => resumed.push(id) });
  const updated = threadStore.get(mgr.id)!;
  assert.deepEqual(resumed, [mgr.id]);
  assert.deepEqual(updated.metadata!.waitingOnTasks, []);
  assert.match(updated.metadata!.pendingMessages![0], /cortex-task spawn --task-file/);
});

test('notifyTaskParentThreads rejects a bogus completed event (task not actually done on disk)', async () => {
  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa12') + taskYaml('bb12', { parent: 'aa12', status: 'open' }));
  const mgr = makeManager(proj, 'aa12', ['bb12']);
  const resumed: string[] = [];
  await notifyTaskParentThreads('bb12', 'completed', { resume: (id) => resumed.push(id) });

  const t = threadStore.get(mgr.id)!;
  assert.deepEqual(t.metadata!.waitingOnTasks, ['bb12'], 'still waiting — dispatch publishes task.completed loosely');
  assert.equal(t.metadata!.pendingMessages?.length ?? 0, 0);
  assert.equal(resumed.length, 0);
});

test('notifyTaskParentThreads rejects stale generation and delivers the current completion', async () => {
  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa13', { status: 'open' }) + taskYaml('bb13', {
    parent: 'aa13', status: 'done', generation: 'generation-b', note: 'SHA-bbbbbbb',
  }));
  const mgr = makeManager(proj, 'aa13', ['bb13']);
  const resumed: string[] = [];

  await notifyTaskParentThreads(
    'bb13', 'completed', { resume: (id) => resumed.push(id) },
    { generation: 'generation-a' },
  );
  let current = threadStore.get(mgr.id)!;
  assert.deepEqual(current.metadata!.waitingOnTasks, ['bb13']);
  assert.equal(current.metadata!.pendingMessages?.length ?? 0, 0);
  assert.deepEqual(resumed, []);

  await notifyTaskParentThreads(
    'bb13', 'completed', { resume: (id) => resumed.push(id) },
    { generation: 'generation-b' },
  );
  current = threadStore.get(mgr.id)!;
  assert.deepEqual(current.metadata!.waitingOnTasks, []);
  assert.match(current.metadata!.pendingMessages![0], /bbbbbbb/);
  assert.deepEqual(resumed, [mgr.id]);
});

test('manual completion still wakes through a later dispatch terminal hint', async () => {
  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa14', { status: 'open' }) + taskYaml('bb14', {
    parent: 'aa14', status: 'done', note: 'manual-result',
  }));
  const mgr = makeManager(proj, 'aa14', ['bb14']);
  const resumed: string[] = [];
  await notifyTaskParentThreads(
    'bb14', 'completed', { resume: (id) => resumed.push(id) },
    { generation: 'generation-b' },
  );
  const current = threadStore.get(mgr.id)!;
  assert.deepEqual(current.metadata!.waitingOnTasks, []);
  assert.match(current.metadata!.pendingMessages![0], /manual-result/);
  assert.deepEqual(resumed, [mgr.id]);
});

test('notifyTaskParentThreads is idempotent across in-memory state resets', async () => {
  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa13') + taskYaml('bb13', { parent: 'aa13', status: 'done' }));
  const mgr = makeManager(proj, 'aa13', ['bb13']);
  const resumed: string[] = [];
  await notifyTaskParentThreads('bb13', 'completed', { resume: (id) => resumed.push(id) });
  _testResetCallbackState();
  await notifyTaskParentThreads('bb13', 'completed', { resume: (id) => resumed.push(id) });

  const t = threadStore.get(mgr.id)!;
  assert.equal(t.metadata!.pendingMessages!.length, 1, 'delivered exactly once');
  assert.equal(resumed.length, 1, 'resumed exactly once');
});

test('notifyTaskParentThreads delivers blocked children as escalation and resumes if last', async () => {
  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa14') + taskYaml('bb14', { parent: 'aa14', blocked: 'worker-abort:too-big' }));
  const mgr = makeManager(proj, 'aa14', ['bb14']);
  const resumed: string[] = [];
  await notifyTaskParentThreads('bb14', 'blocked', { resume: (id) => resumed.push(id) });

  const t = threadStore.get(mgr.id)!;
  assert.deepEqual(t.metadata!.waitingOnTasks, []);
  assert.match(t.metadata!.pendingMessages![0], /worker-abort:too-big/);
  assert.deepEqual(resumed, [mgr.id]);
});

test('notifyTaskParentThreads does not resume while thread children are still pending (dual-list)', async () => {
  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa15') + taskYaml('bb15', { parent: 'aa15', status: 'done' }));
  const liveThreadChild = makeManager(proj, 'zz15', [], { status: 'running', metadata: null });
  const mgr = makeManager(proj, 'aa15', ['bb15']);
  await threadStore.mutate(mgr.id, (t) => { t.metadata!.waitingOn = [liveThreadChild.id]; });
  const resumed: string[] = [];
  await notifyTaskParentThreads('bb15', 'completed', { resume: (id) => resumed.push(id) });

  assert.deepEqual(threadStore.get(mgr.id)!.metadata!.waitingOnTasks, []);
  assert.equal(resumed.length, 0, 'thread child still live — no resume');
});

// --- reconcileWaitingTasks (race-window closer) ---

test('reconcileWaitingTasks sweeps done/blocked/missing children and keeps open ones', async () => {
  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n'
    + taskYaml('aa16')
    + taskYaml('bb16', { parent: 'aa16', status: 'done' })
    + taskYaml('cc16', { parent: 'aa16', blocked: 'stuck' })
    + taskYaml('dd16', { parent: 'aa16' }));
  const missing = 'ee16';
  const mgr = makeManager(proj, 'aa16', ['bb16', 'cc16', 'dd16', missing]);
  const resumed: string[] = [];
  await reconcileWaitingTasks(mgr.id, { resume: (id) => resumed.push(id) });

  const t = threadStore.get(mgr.id)!;
  assert.deepEqual(t.metadata!.waitingOnTasks, ['dd16'], 'only the live open child remains');
  assert.equal(t.metadata!.pendingMessages!.length, 3, 'done + blocked + missing all reported');
  assert.ok(t.metadata!.pendingMessages!.some((m) => m.includes(missing)));
  assert.equal(resumed.length, 0);
});

test('reconcileWaitingTasks resumes when the sweep empties the list', async () => {
  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa17') + taskYaml('bb17', { parent: 'aa17', status: 'done' }));
  const mgr = makeManager(proj, 'aa17', ['bb17']);
  const resumed: string[] = [];
  await reconcileWaitingTasks(mgr.id, { resume: (id) => resumed.push(id) });
  assert.deepEqual(resumed, [mgr.id]);
});

// --- recoverWaitingThreads: task children survive restarts ---

test('recoverWaitingThreads keeps a manager waiting on still-open task children', async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  createdThreadIds.clear();
  await threadStore.flush();

  const proj = `_tb_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa18') + taskYaml('bb18', { parent: 'aa18' }) + taskYaml('cc18', { parent: 'aa18', status: 'done' }));
  const mgr = makeManager(proj, 'aa18', ['bb18', 'cc18']);
  const resumed: string[] = [];
  const n = await recoverWaitingThreads({ resume: (id) => resumed.push(id) });

  assert.equal(n, 1);
  const t = threadStore.get(mgr.id)!;
  assert.equal(t.status, 'waiting', 'open task child → keep waiting (tasks survive restarts)');
  assert.deepEqual(t.metadata!.waitingOnTasks, ['bb18']);
  assert.equal(t.metadata!.pendingMessages!.length, 1, 'done child delivered during recovery');
  assert.equal(resumed.length, 0);
});
