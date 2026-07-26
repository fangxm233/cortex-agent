// input:  task files, thread repo, thread state machine
// output: task-child wait-set and recovery regression tests
// pos:    Verifies manager suspension on child tasks
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { threadStore } from '../src/store/thread-repo.js';
import { tryEnterWaiting } from '../src/domain/threads/index.js';
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
  if (over.dependsOn) lines.push(`    depends-on:\n${over.dependsOn.split(',').map((d) => `      - "${d}"`).join('\n')}`);
  return lines.join('\n') + '\n';
}

function makeThread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = over.id ?? `thr_wt${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: null, status: 'running' as ThreadStatus,
    channel: 'C-wt-test', projectId: 'general', platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'main', activeStage: null, currentStepIndex: 0, steps: [],
    iterationCounts: {}, totalCostUsd: 0, createdAt: now, updatedAt: now,
    endedAt: null, error: null, abortReason: null, metadata: null,
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

// --- tryEnterWaiting: task-children extension ---

test('tryEnterWaiting snapshots open child tasks into waitingOnTasks and suspends', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa01') + taskYaml('bb01', { parent: 'aa01' }) + taskYaml('cc01', { parent: 'aa01' }));
  const manager = makeThread({ metadata: { taskId: 'aa01', taskProject: proj } });

  assert.equal(await tryEnterWaiting(manager.id), true);
  const t = threadStore.get(manager.id)!;
  assert.equal(t.status, 'waiting');
  assert.deepEqual(new Set(t.metadata!.waitingOnTasks), new Set(['bb01', 'cc01']));
});

test('explicit onTasks replaces the inferred task wait set', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa11') + taskYaml('bb11', { parent: 'aa11' }) + taskYaml('cc11', { parent: 'aa11' }));
  const manager = makeThread({ metadata: { taskId: 'aa11', taskProject: proj } });

  assert.equal(await tryEnterWaiting(manager.id, { onTasks: ['cc11'] }), true);
  assert.deepEqual(threadStore.get(manager.id)!.metadata!.waitingOnTasks, ['cc11']);
});

test('explicit empty onTasks suppresses inferred task children', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa12') + taskYaml('bb12', { parent: 'aa12' }));
  const manager = makeThread({ metadata: { taskId: 'aa12', taskProject: proj } });

  assert.equal(await tryEnterWaiting(manager.id, { onTasks: [] }), false);
  assert.deepEqual(threadStore.get(manager.id)!.metadata!.waitingOnTasks, []);
});

test('explicit onTasks keeps only unique live linked children', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n'
    + taskYaml('aa13')
    + taskYaml('bb13', { parent: 'aa13' })
    + taskYaml('cc13', { parent: 'aa13', status: 'done' })
    + taskYaml('dd13'));
  const manager = makeThread({ metadata: { taskId: 'aa13', taskProject: proj } });

  assert.equal(await tryEnterWaiting(manager.id, {
    onTasks: ['bb13', 'bb13', 'cc13', 'dd13', 'ee13'],
  }), true);
  assert.deepEqual(threadStore.get(manager.id)!.metadata!.waitingOnTasks, ['bb13']);
});

test('supplying onTasks also suppresses inferred thread children', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa14') + taskYaml('bb14', { parent: 'aa14' }));
  const threadChild = makeThread({ status: 'running' });
  const manager = makeThread({ metadata: {
    taskId: 'aa14', taskProject: proj,
    waitingOn: [threadChild.id], childThreadIds: [threadChild.id],
  } });

  assert.equal(await tryEnterWaiting(manager.id, { onTasks: ['bb14'] }), true);
  const updated = threadStore.get(manager.id)!;
  assert.deepEqual(updated.metadata!.waitingOnTasks, ['bb14']);
  assert.deepEqual(updated.metadata!.waitingOn, []);
});

test('supplying onThreads also suppresses inferred task children', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa15') + taskYaml('bb15', { parent: 'aa15' }));
  const manager = makeThread({ metadata: { taskId: 'aa15', taskProject: proj, waitingOn: [] } });
  const threadChild = makeThread({ status: 'running', metadata: { parentThreadId: manager.id } });
  await threadStore.mutate(manager.id, (t) => { t.metadata!.childThreadIds = [threadChild.id]; });

  assert.equal(await tryEnterWaiting(manager.id, { onThreads: [threadChild.id] }), true);
  const updated = threadStore.get(manager.id)!;
  assert.deepEqual(updated.metadata!.waitingOn, [threadChild.id]);
  assert.deepEqual(updated.metadata!.waitingOnTasks, []);
});

test('tryEnterWaiting excludes done and blocked children from the snapshot', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n'
    + taskYaml('aa02')
    + taskYaml('bb02', { parent: 'aa02', status: 'done' })
    + taskYaml('cc02', { parent: 'aa02', blocked: 'stuck' })
    + taskYaml('dd02', { parent: 'aa02' }));
  const manager = makeThread({ metadata: { taskId: 'aa02', taskProject: proj } });

  assert.equal(await tryEnterWaiting(manager.id), true);
  assert.deepEqual(threadStore.get(manager.id)!.metadata!.waitingOnTasks, ['dd02']);
});

test('tryEnterWaiting does not suspend when all child tasks are done', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa03') + taskYaml('bb03', { parent: 'aa03', status: 'done' }));
  const manager = makeThread({ metadata: { taskId: 'aa03', taskProject: proj } });

  assert.equal(await tryEnterWaiting(manager.id), false);
  assert.equal(threadStore.get(manager.id)!.status, 'running');
});

test('tryEnterWaiting without taskId metadata keeps thread-children-only behavior', async () => {
  const liveChild = makeThread({ status: 'running' });
  const parent = makeThread({ metadata: { waitingOn: [liveChild.id] } });
  assert.equal(await tryEnterWaiting(parent.id), true);
  const t = threadStore.get(parent.id)!;
  assert.deepEqual(t.metadata!.waitingOn, [liveChild.id]);
  assert.equal(t.metadata!.waitingOnTasks?.length ?? 0, 0);
});

test('tryEnterWaiting also waits on own-task depends_on entries lacking a parent field (regression: thr_6faa13a1)', async () => {
  // 2026-06-11 production incident: the manager fumbled `decompose --keep-parent` and fell
  // back to bulk-add (children got no `parent`) + edit --add-depends-on on its own task.
  // [WAIT_CHILDREN] was emitted but suspension found no children → thread completed and
  // the children's results had no one to return to. The wait set must be the UNION of
  // parent-linked children and the manager task's own unmet depends_on (any not-done dep
  // at manager runtime was added by the manager itself — pre-existing deps were cleared
  // before dispatch by the actionability filter).
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n'
    + taskYaml('aa07', { dependsOn: 'bb07,cc07' })
    + taskYaml('bb07')              // no parent field — bulk-add fallback path
    + taskYaml('cc07', { status: 'done' }));
  const manager = makeThread({ metadata: { taskId: 'aa07', taskProject: proj } });

  assert.equal(await tryEnterWaiting(manager.id), true);
  const t = threadStore.get(manager.id)!;
  assert.equal(t.status, 'waiting');
  assert.deepEqual(t.metadata!.waitingOnTasks, ['bb07'], 'open dep awaited; done dep excluded');
});

test('tryEnterWaiting unions parent-linked children with depends_on entries (no duplicates)', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n'
    + taskYaml('aa08', { dependsOn: 'bb08' })
    + taskYaml('bb08', { parent: 'aa08' })   // linked both ways
    + taskYaml('cc08', { parent: 'aa08' })); // parent-only
  const manager = makeThread({ metadata: { taskId: 'aa08', taskProject: proj } });

  assert.equal(await tryEnterWaiting(manager.id), true);
  assert.deepEqual(new Set(threadStore.get(manager.id)!.metadata!.waitingOnTasks), new Set(['bb08', 'cc08']));
});

test('tryEnterWaiting suspends on task children even with zero thread children', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa04') + taskYaml('bb04', { parent: 'aa04' }));
  const manager = makeThread({ metadata: { taskId: 'aa04', taskProject: proj, waitingOn: [] } });
  assert.equal(await tryEnterWaiting(manager.id), true);
});

// --- restart semantics ---

test('markRunningAsFailedOnStartup preserves parents suspended on task children only', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa05') + taskYaml('bb05', { parent: 'aa05' }));
  const manager = makeThread({ status: 'waiting', metadata: { taskId: 'aa05', taskProject: proj, waitingOnTasks: ['bb05'] } });
  const plain = makeThread({ status: 'waiting', metadata: null });

  await threadStore.markRunningAsFailedOnStartup();

  assert.equal(threadStore.get(manager.id)!.status, 'waiting', 'task-waiting manager survives restart');
  assert.equal(threadStore.get(plain.id)!.status, 'failed');
});

// --- cleanup: orphan detection, not age limit ---

test('cleanup spares an over-age waiting manager whose child tasks are still open', async () => {
  const proj = `_wt_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa06') + taskYaml('bb06', { parent: 'aa06' }));
  const manager = makeThread({ status: 'waiting', metadata: { taskId: 'aa06', taskProject: proj, waitingOnTasks: ['bb06'] } });
  threadStore.get(manager.id)!.updatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  await threadStore.cleanup();

  assert.equal(threadStore.get(manager.id)!.status, 'waiting', 'multi-day training waits must not be reaped');
});

test('cleanup still fails an over-age waiting parent with no live children anywhere', async () => {
  const orphan = makeThread({ status: 'waiting', metadata: { waitingOn: ['thr_gone_x'], waitingOnTasks: [] } });
  threadStore.get(orphan.id)!.updatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  await threadStore.cleanup();

  assert.equal(threadStore.get(orphan.id)!.status, 'failed');
});
