// input:  Node test runner + thread-callback rotation + acceptance-ledger + task bridge
// output: manager session-rotation tests — step-count trigger / slot session clearing /
//         rehydration notice content / resume-path integration
// pos:    Verify DR-0017 W3: a manager thread exceeding CORTEX_MANAGER_ROTATE_STEPS steps
//         since its last rotation is re-entered on a FRESH session (kill test == rotation ==
//         crash recovery), rehydrated from the task-keyed artifact + acceptance ledger.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { threadStore } from '../src/store/thread-repo.js';
import { maybeRotateManager, notifyTaskParentThreads } from '../src/orchestration/thread-callback.js';
import { recordDelivered, recordVerdict } from '../src/domain/tasks/acceptance-ledger.js';
import type { ThreadRecord, ThreadStatus, AgentStep } from '../src/core/types/thread-types.js';

process.env.CORTEX_MANAGER_ROTATE_STEPS = '5';

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
  return lines.join('\n') + '\n';
}

function dummySteps(n: number): AgentStep[] {
  return Array.from({ length: n }, (_, i) => ({
    stepIndex: i, agentSlotId: 'manager', stage: null, executionId: null,
    sessionId: 'sess-old', sessionName: null, input: '', output: 'ok',
    costUsd: 0.01, numTurns: 3, durationS: 5, startedAt: null, endedAt: new Date().toISOString(),
  }));
}

function makeManager(proj: string, taskId: string, over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = `thr_rot${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: 'manager', status: 'waiting' as ThreadStatus,
    channel: 'C-rot-test', projectId: proj, platformThreadId: null,
    userMessage: 'contract text', userMessageTs: 'ts', workspacePath: '',
    artifactPath: `/tmp/rot-artifact-${id}.md`,
    agents: {
      manager: { slotId: 'manager', profile: 'p', sessionId: 'sess-old', sessionName: null, status: 'idle', lastOutput: null, persistSession: true },
    },
    activeAgent: 'manager', activeStage: null, currentStepIndex: 6,
    steps: dummySteps(6), iterationCounts: {}, totalCostUsd: 0,
    createdAt: now, updatedAt: now, endedAt: null, error: null, abortReason: null,
    metadata: { trigger: 'task-dispatch', taskId, taskProject: proj },
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

test('below threshold → no rotation, session kept', async () => {
  const proj = `_rot_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa01'));
  const mgr = makeManager(proj, 'aa01', { steps: dummySteps(3), currentStepIndex: 3 });

  assert.equal(await maybeRotateManager(mgr.id), false);
  const t = threadStore.get(mgr.id)!;
  assert.equal(t.agents.manager.sessionId, 'sess-old');
  assert.equal(t.metadata?.pendingMessages?.length ?? 0, 0);
});

test('over threshold → session cleared, base reset, rehydration notice queued with ledger pendings', async () => {
  const proj = `_rot_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa02'));
  await recordDelivered(proj, 'aa02', 'bb02', 'completed');   // pending acceptance
  await recordDelivered(proj, 'aa02', 'cc02', 'completed');
  await recordVerdict(proj, 'aa02', 'cc02', 'accepted');      // already accepted → not listed
  const mgr = makeManager(proj, 'aa02');

  assert.equal(await maybeRotateManager(mgr.id), true);
  const t = threadStore.get(mgr.id)!;
  assert.equal(t.agents.manager.sessionId, null, 'persisted session retired');
  assert.equal(t.metadata?.rotationBaseStepIndex, 6, 'base reset to current step count');
  const notice = (t.metadata?.pendingMessages ?? []).join('\n');
  assert.match(notice, /fresh incarnation/i);
  assert.ok(notice.includes(t.artifactPath), 'notice points at the durable artifact');
  assert.match(notice, /cortex-task tree/, 'notice tells the new incarnation to reconcile');
  assert.ok(notice.includes('bb02'), 'pending acceptance listed from the ledger');
  assert.ok(!notice.includes('cc02'), 'accepted child not listed');
});

test('non-manager template → never rotates', async () => {
  const proj = `_rot_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa03'));
  const worker = makeManager(proj, 'aa03', { templateName: 'coder-review' });
  assert.equal(await maybeRotateManager(worker.id), false);
  assert.equal(threadStore.get(worker.id)!.agents.manager.sessionId, 'sess-old');
});

test('rotation resets the base — immediate second check does not rotate again', async () => {
  const proj = `_rot_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa04'));
  const mgr = makeManager(proj, 'aa04');
  assert.equal(await maybeRotateManager(mgr.id), true);
  assert.equal(await maybeRotateManager(mgr.id), false, 'base was reset; no steps since');
});

test('resume path integration: child completion on an over-threshold manager rotates then resumes', async () => {
  const proj = `_rot_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa05') + taskYaml('bb05', { parent: 'aa05', status: 'done' }));
  const mgr = makeManager(proj, 'aa05', { metadata: { trigger: 'task-dispatch', taskId: 'aa05', taskProject: proj, waitingOnTasks: ['bb05'] } });

  const resumed: string[] = [];
  await notifyTaskParentThreads('bb05', 'completed', { resume: (id) => resumed.push(id) });

  assert.deepEqual(resumed, [mgr.id], 'manager resumed after last child');
  const t = threadStore.get(mgr.id)!;
  assert.equal(t.agents.manager.sessionId, null, 'rotated before resume');
  const msgs = t.metadata?.pendingMessages ?? [];
  assert.ok(msgs.some((m) => /Subtask done/.test(m)), 'child result delivered');
  assert.ok(msgs.some((m) => /fresh incarnation/i.test(m)), 'rehydration notice delivered');
});

test('below-threshold resume path leaves the session untouched', async () => {
  const proj = `_rot_p${seq++}`;
  makeProject(proj, 'tasks:\n' + taskYaml('aa06') + taskYaml('bb06', { parent: 'aa06', status: 'done' }));
  const mgr = makeManager(proj, 'aa06', {
    steps: dummySteps(2), currentStepIndex: 2,
    metadata: { trigger: 'task-dispatch', taskId: 'aa06', taskProject: proj, waitingOnTasks: ['bb06'] },
  });

  const resumed: string[] = [];
  await notifyTaskParentThreads('bb06', 'completed', { resume: (id) => resumed.push(id) });

  assert.deepEqual(resumed, [mgr.id]);
  assert.equal(threadStore.get(mgr.id)!.agents.manager.sessionId, 'sess-old', 'no rotation below threshold');
});
