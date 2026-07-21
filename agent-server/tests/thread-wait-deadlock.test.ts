// input:  Node test runner + thread-callback deadlock guard
// output: computeStuckWaitSet / buildDeadlockNotice / stuck-wake integration tests
// pos:    Verify a waiting manager whose remaining awaited tasks are ALL stuck behind blocked
//         dependencies is woken (once per distinct stall) instead of hanging forever —
//         DR-0014 §8 wake-on-empty alone deadlocks when siblings depend on a blocked child.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { threadStore } from '../src/store/thread-repo.js';
import {
  computeStuckWaitSet,
  buildDeadlockNotice,
  notifyTaskParentThreads,
  reconcileWaitingTasks,
  sweepWaitingManagers,
  _testResetCallbackState,
} from '../src/orchestration/thread-callback.js';
import { rawToTask } from '../src/core/task-parser.js';
import type { Task } from '../src/core/task-parser.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
const projectDirs: string[] = [];
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
  for (const d of projectDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function t(id: string, over: Record<string, unknown> = {}): Task {
  return rawToTask({ id, text: `task ${id}`, status: 'open', ...over }, '_dl_proj');
}

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
    `    text: task ${id}`,
    '    why: w',
    `    done-when: criteria for ${id}`,
    '    priority: medium',
    `    status: ${over.status ?? 'open'}`,
    '    template: coder-review',
    '    plan: p',
  ];
  if (over.parent) lines.push(`    parent: "${over.parent}"`);
  if (over.blocked) lines.push(`    blocked-by: ${over.blocked}`);
  if (over.claimed) lines.push(`    claimed-by: ${over.claimed}`);
  if (over.dependsOn) lines.push(`    depends-on:\n${over.dependsOn.split(',').map((d) => `      - "${d}"`).join('\n')}`);
  return lines.join('\n') + '\n';
}

function makeManager(proj: string, taskId: string, waitingOnTasks: string[], over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = `thr_dl${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: 'manager', status: 'waiting' as ThreadStatus,
    channel: 'C-dl-test', projectId: proj, platformThreadId: null,
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

// --- computeStuckWaitSet (pure) ---

test('direct dependency on a blocked task → stuck', () => {
  const tasks = [t('aa', { 'blocked-by': 'stuck' }), t('bb', { 'depends-on': ['aa'] })];
  const r = computeStuckWaitSet(tasks, ['bb']);
  assert.ok(r);
  assert.deepEqual(r!.stuck, ['bb']);
  assert.deepEqual(r!.blockers, ['aa']);
  assert.ok(r!.key.length > 0);
});

test('transitive dependency chain on a blocked task → stuck', () => {
  const tasks = [
    t('aa', { 'blocked-by': 'stuck' }),
    t('bb', { 'depends-on': ['aa'] }),
    t('cc', { 'depends-on': ['bb'] }),
  ];
  const r = computeStuckWaitSet(tasks, ['cc']);
  assert.ok(r);
  assert.deepEqual(r!.stuck, ['cc']);
  assert.deepEqual(r!.blockers, ['aa']);
});

test('a runnable sibling in the wait set → not a deadlock', () => {
  const tasks = [
    t('aa', { 'blocked-by': 'stuck' }),
    t('bb', { 'depends-on': ['aa'] }),
    t('dd'), // no deps — dispatchable
  ];
  assert.equal(computeStuckWaitSet(tasks, ['bb', 'dd']), null);
});

test('an in-flight sibling (claimed or pending) → not a deadlock', () => {
  const tasks = [
    t('aa', { 'blocked-by': 'stuck' }),
    t('bb', { 'depends-on': ['aa'] }),
    t('dd', { 'claimed-by': 'task-dispatcher' }),
  ];
  assert.equal(computeStuckWaitSet(tasks, ['bb', 'dd']), null);
  const tasks2 = [
    t('aa', { 'blocked-by': 'stuck' }),
    t('bb', { 'depends-on': ['aa'] }),
    t('ee', { status: 'pending' }),
  ];
  assert.equal(computeStuckWaitSet(tasks2, ['bb', 'ee']), null);
});

test('a done or blocked task still in the wait set → delivery owns it, not a deadlock', () => {
  const tasks = [
    t('aa', { 'blocked-by': 'stuck' }),
    t('bb', { 'depends-on': ['aa'] }),
    t('ee', { status: 'done' }),
  ];
  assert.equal(computeStuckWaitSet(tasks, ['bb', 'ee']), null);
  const tasks2 = [t('aa', { 'blocked-by': 'stuck' }), t('bb', { 'depends-on': ['aa'], 'blocked-by': 'also stuck' })];
  assert.equal(computeStuckWaitSet(tasks2, ['bb']), null);
});

test('a missing awaited task → reconcile owns it, not a deadlock', () => {
  const tasks = [t('aa', { 'blocked-by': 'stuck' }), t('bb', { 'depends-on': ['aa'] })];
  assert.equal(computeStuckWaitSet(tasks, ['bb', 'zz']), null);
});

test('a met (done) dependency is not stuck; dependency cycles terminate', () => {
  const met = [t('aa', { status: 'done' }), t('bb', { 'depends-on': ['aa'] })];
  assert.equal(computeStuckWaitSet(met, ['bb']), null);
  const cyc = [t('bb', { 'depends-on': ['cc'] }), t('cc', { 'depends-on': ['bb'] })];
  assert.equal(computeStuckWaitSet(cyc, ['bb', 'cc']), null); // terminates, no blocked task
});

test('empty wait set → null', () => {
  assert.equal(computeStuckWaitSet([t('aa')], []), null);
});

test('buildDeadlockNotice names the stuck tasks, the blockers, and the escape hatches', () => {
  const notice = buildDeadlockNotice(['cc11', 'dd11'], ['bb11']);
  assert.match(notice, /cc11/);
  assert.match(notice, /dd11/);
  assert.match(notice, /bb11/);
  assert.match(notice, /unblock/);
  assert.match(notice, /thread_abort/);
});

// --- integration: blocked child + stuck sibling wakes the manager ---

test('blocked child among stuck siblings wakes the manager with a deadlock notice', async () => {
  const proj = `_dl_p${seq++}`;
  makeProject(proj, 'tasks:\n'
    + taskYaml('aa10')
    + taskYaml('bb10', { parent: 'aa10', blocked: 'worker-abort:too-big' })
    + taskYaml('cc10', { parent: 'aa10', dependsOn: 'bb10' }));
  const mgr = makeManager(proj, 'aa10', ['bb10', 'cc10']);
  const resumed: string[] = [];
  _testResetCallbackState();

  await notifyTaskParentThreads('bb10', 'blocked', { resume: (id) => resumed.push(id) });

  const rec = threadStore.get(mgr.id)!;
  assert.deepEqual(rec.metadata!.waitingOnTasks, ['cc10'], 'blocked child removed, stuck sibling kept');
  assert.deepEqual(resumed, [mgr.id], 'manager woken despite non-empty wait set');
  const msgs = rec.metadata!.pendingMessages!;
  assert.ok(msgs.some((m) => /bb10/.test(m) && /blocked/i.test(m)), 'blocked escalation notice queued');
  assert.ok(msgs.some((m) => /cc10/.test(m) && /bb10/.test(m) && /never/i.test(m)), 'deadlock notice queued');
  assert.ok(rec.metadata!.stuckWakeKey, 'stall marker persisted');
});

test('same stall does not re-wake (persistent dedup across restart)', async () => {
  const proj = `_dl_p${seq++}`;
  makeProject(proj, 'tasks:\n'
    + taskYaml('aa20')
    + taskYaml('bb20', { parent: 'aa20', blocked: 'stuck' })
    + taskYaml('cc20', { parent: 'aa20', dependsOn: 'bb20' }));
  const mgr = makeManager(proj, 'aa20', ['cc20']);
  const resumed: string[] = [];
  _testResetCallbackState();

  await reconcileWaitingTasks(mgr.id, { resume: (id) => resumed.push(id) });
  assert.equal(resumed.length, 1, 'first sweep wakes');

  _testResetCallbackState(); // simulate restart: in-memory resuming guard gone
  await reconcileWaitingTasks(mgr.id, { resume: (id) => resumed.push(id) });
  assert.equal(resumed.length, 1, 'identical stall does not re-wake');
});

test('a DIFFERENT stall re-wakes after the wait set changes', async () => {
  const proj = `_dl_p${seq++}`;
  const yamlFor = (ddStatus: string) => 'tasks:\n'
    + taskYaml('aa30')
    + taskYaml('bb30', { parent: 'aa30', blocked: 'stuck' })
    + taskYaml('cc30', { parent: 'aa30', dependsOn: 'bb30' })
    + taskYaml('dd30', { parent: 'aa30', dependsOn: 'bb30', status: ddStatus });
  const file = makeProject(proj, yamlFor('open'));
  const mgr = makeManager(proj, 'aa30', ['cc30', 'dd30']);
  const resumed: string[] = [];
  _testResetCallbackState();

  await reconcileWaitingTasks(mgr.id, { resume: (id) => resumed.push(id) });
  assert.equal(resumed.length, 1, 'stall {cc30,dd30} wakes once');

  // dd30 turns done on disk (e.g. the manager re-planned and someone completed it):
  // its delivery shrinks the wait set to {cc30} — a distinct stall, wake again.
  fs.writeFileSync(file, yamlFor('done'));
  _testResetCallbackState();
  await reconcileWaitingTasks(mgr.id, { resume: (id) => resumed.push(id) });
  assert.equal(resumed.length, 2, 'distinct stall re-wakes');
  assert.deepEqual(threadStore.get(mgr.id)!.metadata!.waitingOnTasks, ['cc30']);
});

test('sweepWaitingManagers detects a pre-suspend blocked dependency (no event ever fires)', async () => {
  const proj = `_dl_p${seq++}`;
  makeProject(proj, 'tasks:\n'
    + taskYaml('aa40')
    + taskYaml('bb40', { parent: 'aa40', blocked: 'stuck before suspension' })
    + taskYaml('cc40', { parent: 'aa40', dependsOn: 'bb40' }));
  // bb40 was already blocked at suspension → snapshot excluded it; manager waits only on cc40.
  const mgr = makeManager(proj, 'aa40', ['cc40']);
  const resumed: string[] = [];
  _testResetCallbackState();

  await sweepWaitingManagers({ resume: (id) => resumed.push(id) });
  assert.deepEqual(resumed, [mgr.id], 'periodic sweep wakes the deadlocked manager');
  assert.ok(threadStore.get(mgr.id)!.metadata!.pendingMessages!.some((m) => /cc40/.test(m) && /bb40/.test(m)));
});

test('a normal (empty wait set) resume clears the stall marker', async () => {
  const proj = `_dl_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa50'));
  const mgr = makeManager(proj, 'aa50', []);
  await threadStore.mutate(mgr.id, (rec) => { rec.metadata!.stuckWakeKey = 'stale-key'; });
  const resumed: string[] = [];
  _testResetCallbackState();

  await reconcileWaitingTasks(mgr.id, { resume: (id) => resumed.push(id) });
  assert.deepEqual(resumed, [mgr.id]);
  assert.ok(!threadStore.get(mgr.id)!.metadata!.stuckWakeKey, 'stall marker cleared on normal resume');
});
