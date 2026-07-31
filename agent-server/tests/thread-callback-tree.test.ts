// input:  Vitest, thread callback state, child contracts
// output: Parent re-entry and safe replacement-task regressions
// pos:    Verifies child-to-parent result delivery and recovery
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { threadStore } from '../src/store/thread-repo.js';
import {
  fireThreadCallback,
  notifyThreadParent,
  recoverWaitingThreads,
  buildChildResultNotice,
  _testResetCallbackState,
} from '../src/orchestration/thread-callback.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

function makeThread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = over.id ?? `thr_cb${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id,
    templateName: null,
    status: 'running' as ThreadStatus,
    channel: 'C-cb-test',
    projectId: 'general',
    platformThreadId: null,
    userMessage: 'x',
    userMessageTs: 'ts',
    workspacePath: '',
    artifactPath: '',
    agents: {},
    activeAgent: 'main',
    activeStage: null,
    currentStepIndex: 0,
    steps: [],
    iterationCounts: {},
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    error: null,
    abortReason: null,
    metadata: null,
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

function makeParentChild(opts: {
  childStatus?: ThreadStatus;
  parentStatus?: ThreadStatus;
  waiting?: boolean;            // child listed in parent's waitingOn (default true)
  extraWaiting?: string[];      // additional ids in waitingOn
} = {}): { parent: ThreadRecord; child: ThreadRecord } {
  const parent = makeThread({ status: opts.parentStatus ?? 'waiting' });
  const child = makeThread({
    status: opts.childStatus ?? 'completed',
    totalCostUsd: 0.42,
    metadata: {
      trigger: 'mcp-thread',
      parentSessionId: 'sess-parent',
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      contract: { goal: 'investigate flaky test', doneWhen: 'root cause documented', deliverablePath: '/tmp/report.md' },
    },
  });
  const waiting = opts.waiting !== false;
  parent.metadata = {
    trigger: 'mcp-thread',
    childThreadIds: [child.id],
    waitingOn: [...(waiting ? [child.id] : []), ...(opts.extraWaiting ?? [])],
  };
  threadStore.set(parent);
  return { parent, child };
}

// --- buildChildResultNotice ---

test('buildChildResultNotice includes status, cost, contract fields, and verification instructions', () => {
  const { child } = makeParentChild();
  const notice = buildChildResultNotice(child);
  assert.match(notice, new RegExp(child.id));
  assert.match(notice, /completed/);
  assert.match(notice, /investigate flaky test/);
  assert.match(notice, /root cause documented/);
  assert.match(notice, /\/tmp\/report\.md/);
  assert.match(notice, /thread_result/);
  // Acceptance discipline: verify deliverable, do not trust the child's self-report.
  assert.match(notice, /done.?when/i);
  assert.match(notice, /Write tool/);
  assert.match(notice, /cortex-task spawn --task-file/);
  assert.match(notice, /per-task unique path/);
  assert.match(notice, /thread_wait/);
  assert.match(notice, /thread_abort/);
  assert.doesNotMatch(notice, /thread_start/);
});

// --- fireThreadCallback terminal guard ---

test('fireThreadCallback is a no-op for non-terminal threads (waiting return must not fire)', async () => {
  const { parent, child } = makeParentChild({ childStatus: 'running' });
  await fireThreadCallback(child.id);
  const p = threadStore.get(parent.id)!;
  assert.deepEqual(p.metadata!.waitingOn, [child.id], 'waitingOn untouched');
  assert.equal(p.metadata!.pendingMessages?.length ?? 0, 0, 'no result delivered');
});

// --- notifyThreadParent ---

test('notifyThreadParent removes child from waitingOn and queues result into pendingMessages', async () => {
  const { parent, child } = makeParentChild({ extraWaiting: ['thr_other_live'] });
  const resumed: string[] = [];
  await notifyThreadParent(child.id, { resume: (id) => resumed.push(id) });

  const p = threadStore.get(parent.id)!;
  assert.deepEqual(p.metadata!.waitingOn, ['thr_other_live']);
  assert.equal(p.metadata!.pendingMessages!.length, 1);
  assert.match(p.metadata!.pendingMessages![0], new RegExp(child.id));
  assert.equal(resumed.length, 0, 'must not resume while siblings still pending');
  assert.equal(p.status, 'waiting');
});

test('notifyThreadParent resumes the parent when the last awaited child turns terminal', async () => {
  const { parent, child } = makeParentChild();
  const resumed: string[] = [];
  await notifyThreadParent(child.id, { resume: (id) => resumed.push(id) });

  const p = threadStore.get(parent.id)!;
  assert.deepEqual(p.metadata!.waitingOn, []);
  assert.equal(p.metadata!.pendingMessages!.length, 1);
  assert.match(p.metadata!.pendingMessages![0], /Write tool/);
  assert.match(p.metadata!.pendingMessages![0], /cortex-task spawn --task-file/);
  assert.deepEqual(resumed, [parent.id]);
});

test('notifyThreadParent is idempotent — repeated callbacks deliver the result only once', async () => {
  const { parent, child } = makeParentChild();
  const resumed: string[] = [];
  await notifyThreadParent(child.id, { resume: (id) => resumed.push(id) });
  _testResetCallbackState();  // simulate restart: in-memory dedup gone, persisted state must carry idempotency
  await notifyThreadParent(child.id, { resume: (id) => resumed.push(id) });

  const p = threadStore.get(parent.id)!;
  assert.equal(p.metadata!.pendingMessages!.length, 1, 'result delivered exactly once');
  assert.equal(resumed.length, 1, 'resume fired exactly once');
});

test('notifyThreadParent delivers results of fire-and-forget (wait=false) children without resuming', async () => {
  const { parent, child } = makeParentChild({ waiting: false, parentStatus: 'running' });
  const resumed: string[] = [];
  await notifyThreadParent(child.id, { resume: (id) => resumed.push(id) });

  const p = threadStore.get(parent.id)!;
  assert.equal(p.metadata!.pendingMessages!.length, 1);
  assert.equal(resumed.length, 0);
});

test('notifyThreadParent handles a still-running parent (race): result queued, no resume, no suspend', async () => {
  const { parent, child } = makeParentChild({ parentStatus: 'running' });
  const resumed: string[] = [];
  await notifyThreadParent(child.id, { resume: (id) => resumed.push(id) });

  const p = threadStore.get(parent.id)!;
  assert.equal(p.status, 'running');
  assert.deepEqual(p.metadata!.waitingOn, []);
  assert.equal(p.metadata!.pendingMessages!.length, 1);
  assert.equal(resumed.length, 0, 'running parent consumes results in-loop, not via resume');
});

test('notifyThreadParent does not throw when the parent record is gone (orphan child)', async () => {
  const child = makeThread({
    status: 'completed',
    metadata: { parentSessionId: 'sess-x', parentThreadId: 'thr_gone_' + Date.now() },
  });
  await notifyThreadParent(child.id);  // no adapter in tests — must degrade silently
});

// --- recoverWaitingThreads (startup recovery) ---

/** recoverWaitingThreads scans the whole store — purge this file's residue first. */
async function purgeCreated(): Promise<void> {
  for (const id of createdThreadIds) await threadStore.delete(id);
  createdThreadIds.clear();
  await threadStore.flush();
}

test('recoverWaitingThreads delivers terminal children, drops missing children, and resumes', async () => {
  await purgeCreated();
  const parent = makeThread({ status: 'waiting' });
  const doneChild = makeThread({
    status: 'completed',
    metadata: { parentSessionId: 's', parentThreadId: parent.id, rootThreadId: parent.id },
  });
  const missingId = 'thr_purged_' + Date.now();
  parent.metadata = { childThreadIds: [doneChild.id, missingId], waitingOn: [doneChild.id, missingId] };
  threadStore.set(parent);

  const resumed: string[] = [];
  const n = await recoverWaitingThreads({ resume: (id) => resumed.push(id) });

  assert.equal(n, 1);
  const p = threadStore.get(parent.id)!;
  assert.deepEqual(p.metadata!.waitingOn, []);
  assert.equal(p.metadata!.pendingMessages!.length, 2, 'one child result + one missing-child note');
  assert.ok(p.metadata!.pendingMessages!.some(m => m.includes(missingId)), 'missing child reported');
  assert.deepEqual(resumed, [parent.id]);
});

test('recoverWaitingThreads ignores healthy running threads and terminal threads', async () => {
  await purgeCreated();
  makeThread({ status: 'running' });
  makeThread({ status: 'completed' });
  const n = await recoverWaitingThreads({ resume: () => { throw new Error('must not resume'); } });
  assert.equal(n, 0);
});
