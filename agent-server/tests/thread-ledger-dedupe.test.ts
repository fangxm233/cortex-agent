// input:  thread callback, wait state machine, acceptance ledger
// output: task-result dedupe and same-task reissue regressions
// pos:    Verifies manager child-result delivery epochs
// >>> If I am updated, update my header comment and parent CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { threadStore } from '../src/store/thread-repo.js';
import { tryEnterWaiting } from '../src/domain/threads/index.js';
import {
  _testResetCallbackState, notifyTaskParentThreads,
} from '../src/orchestration/thread-callback.js';
import { readLedger, recordVerdict } from '../src/domain/tasks/acceptance-ledger.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
const projectDirs: string[] = [];
let seq = 0;

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
    '    done-when: d',
    '    priority: medium',
    `    status: ${over.status ?? 'open'}`,
    '    template: coder-review',
    '    plan: p',
  ];
  if (over.parent) lines.push(`    parent: "${over.parent}"`);
  if (over.blocked) lines.push(`    blocked-by: ${over.blocked}`);
  return lines.join('\n') + '\n';
}

function makeManager(proj: string, taskId: string, waitingOnTasks: string[]): ThreadRecord {
  const id = `thr_ld${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: 'manager', status: 'waiting' as ThreadStatus,
    channel: 'C-ld-test', projectId: proj, platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'manager', activeStage: null, currentStepIndex: 1,
    steps: [], iterationCounts: {}, totalCostUsd: 0, createdAt: now, updatedAt: now,
    endedAt: null, error: null, abortReason: null,
    metadata: { trigger: 'task-dispatch', taskId, taskProject: proj, waitingOnTasks: [...waitingOnTasks] },
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

test('delivery records a pending ledger entry keyed by the parent TASK', async () => {
  const proj = `_ld_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa01') + taskYaml('bb01', { parent: 'aa01', status: 'done' }));
  const mgr = makeManager(proj, 'aa01', ['bb01']);

  const resumed: string[] = [];
  await notifyTaskParentThreads('bb01', 'completed', { resume: (id) => resumed.push(id) });

  const t = threadStore.get(mgr.id)!;
  assert.equal(t.metadata!.pendingMessages!.length, 1, 'result notice queued');
  const entry = readLedger(proj, 'aa01').children['bb01'];
  assert.ok(entry, 'ledger entry written');
  assert.equal(entry.verdict, 'pending');
  assert.deepEqual(resumed, [mgr.id], 'manager resumed');
});

test('accepted child is NOT re-delivered to a new manager incarnation, but is still un-waited', async () => {
  const proj = `_ld_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa02') + taskYaml('bb02', { parent: 'aa02', status: 'done' }));

  // incarnation 1 receives + accepts
  const mgr1 = makeManager(proj, 'aa02', ['bb02']);
  await notifyTaskParentThreads('bb02', 'completed', { resume: () => {} });
  assert.equal(threadStore.get(mgr1.id)!.metadata!.pendingMessages!.length, 1);
  await recordVerdict(proj, 'aa02', 'bb02', 'accepted', 'verified');

  // incarnation 2 (fresh thread, fresh deliveredChildResults) waits on the same child
  const mgr2 = makeManager(proj, 'aa02', ['bb02']);
  const resumed: string[] = [];
  await notifyTaskParentThreads('bb02', 'completed', { resume: (id) => resumed.push(id) });

  const t2 = threadStore.get(mgr2.id)!;
  assert.equal(t2.metadata!.pendingMessages?.length ?? 0, 0, 'accepted child must not re-deliver');
  assert.equal(t2.metadata!.waitingOnTasks!.length, 0, 'child removed from the wait set anyway');
  assert.deepEqual(resumed, [mgr2.id], 'manager resumes once nothing is left to wait on');
});

test('pending (un-verdicted) child re-delivers to a new incarnation', async () => {
  const proj = `_ld_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa03') + taskYaml('bb03', { parent: 'aa03', status: 'done' }));

  const mgr1 = makeManager(proj, 'aa03', ['bb03']);
  await notifyTaskParentThreads('bb03', 'completed', { resume: () => {} });
  assert.equal(threadStore.get(mgr1.id)!.metadata!.pendingMessages!.length, 1);
  // no verdict recorded — incarnation 1 died before acceptance

  const mgr2 = makeManager(proj, 'aa03', ['bb03']);
  await notifyTaskParentThreads('bb03', 'completed', { resume: () => {} });
  assert.equal(threadStore.get(mgr2.id)!.metadata!.pendingMessages!.length, 1,
    'un-verdicted result must be re-delivered to the next incarnation (never lost)');
});

test('same-incarnation duplicate events still dedupe via deliveredChildResults', async () => {
  const proj = `_ld_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa04') + taskYaml('bb04', { parent: 'aa04', status: 'done' }));
  const mgr = makeManager(proj, 'aa04', ['bb04']);

  await notifyTaskParentThreads('bb04', 'completed', { resume: () => {} });
  // second (duplicate/loose) event for the same child in the same incarnation
  await threadStore.mutate(mgr.id, (t) => { t.status = 'waiting'; t.metadata!.waitingOnTasks = ['bb04']; });
  await notifyTaskParentThreads('bb04', 'completed', { resume: () => {} });

  assert.equal(threadStore.get(mgr.id)!.metadata!.pendingMessages!.length, 1,
    'duplicate event within one incarnation queues exactly one notice');
});

test('re-waiting on a reissued child re-delivers its next blocked result and resumes', async () => {
  const proj = `_ld_p${seq++}`;
  const taskFile = path.join(PROJECTS_DIR, proj, 'TASKS.yaml');
  makeProject(proj, 'tasks:\n' + taskYaml('aa06')
    + taskYaml('bb06', { parent: 'aa06', blocked: 'first-stop' }));
  const mgr = makeManager(proj, 'aa06', ['bb06']);
  const resumed: string[] = [];

  await notifyTaskParentThreads('bb06', 'blocked', { resume: (id) => resumed.push(id) });
  await threadStore.mutate(mgr.id, (t) => {
    t.status = 'running';
    t.metadata!.pendingMessages = [];
  });
  _testResetCallbackState();
  fs.writeFileSync(taskFile, 'tasks:\n' + taskYaml('aa06') + taskYaml('bb06', { parent: 'aa06' }));

  assert.equal(await tryEnterWaiting(mgr.id, { onTasks: ['bb06'] }), true);
  fs.writeFileSync(taskFile, 'tasks:\n' + taskYaml('aa06')
    + taskYaml('bb06', { parent: 'aa06', blocked: 'second-stop' }));
  await notifyTaskParentThreads('bb06', 'blocked', { resume: (id) => resumed.push(id) });

  const current = threadStore.get(mgr.id)!;
  assert.equal(current.metadata!.pendingMessages!.length, 1);
  assert.match(current.metadata!.pendingMessages![0], /second-stop/);
  assert.deepEqual(resumed, [mgr.id, mgr.id]);
});

test('threads without task metadata keep the legacy per-thread dedupe path (no ledger writes)', async () => {
  const proj = `_ld_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('bb05', { status: 'done' }));
  // a waiting thread with waitingOnTasks but NO taskId (thread_start-style parent)
  const id = `thr_ld${(seq++).toString(36)}nolt`;
  const now = new Date().toISOString();
  threadStore.set({
    id, templateName: null, status: 'waiting' as ThreadStatus,
    channel: 'C-ld-test', projectId: proj, platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'main', activeStage: null, currentStepIndex: 1,
    steps: [], iterationCounts: {}, totalCostUsd: 0, createdAt: now, updatedAt: now,
    endedAt: null, error: null, abortReason: null,
    metadata: { taskProject: proj, waitingOnTasks: ['bb05'] },
  } as ThreadRecord);
  createdThreadIds.add(id);

  await notifyTaskParentThreads('bb05', 'completed', { resume: () => {} });
  const t = threadStore.get(id)!;
  assert.equal(t.metadata!.pendingMessages!.length, 1, 'delivery still works');
  assert.ok(t.metadata!.deliveredChildResults!.includes('bb05'), 'legacy dedupe recorded');
});
