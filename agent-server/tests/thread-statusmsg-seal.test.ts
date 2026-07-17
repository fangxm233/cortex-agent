// input:  Node test runner + thread-callback sealSuspendedStatusMsg
// output: stale "suspended — waiting on children" Slack message gets refreshed on terminal/re-suspend
// pos:    Regression for the 2026-06-11 verification finding: thr_1cfda9a9 completed but its
//         dispatch status message still read "suspended — waiting on N child task(s)"
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { threadStore } from '../src/store/thread-repo.js';
import { sealSuspendedStatusMsg } from '../src/orchestration/thread-callback.js';
import { MockAdapter } from '../src/platform/testing.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

function makeThread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = over.id ?? `thr_sm${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: 'manager', status: 'completed' as ThreadStatus,
    channel: 'C-sm-test', projectId: 'general', platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'manager', activeStage: null, currentStepIndex: 1,
    steps: [{ stepIndex: 0, agentSlotId: 'manager', stage: null, executionId: null, sessionId: null, sessionName: null, input: '', output: 'done', costUsd: 0.1, numTurns: 5, durationS: 10, startedAt: now, endedAt: now }],
    iterationCounts: {}, totalCostUsd: 0.1, createdAt: now, updatedAt: now,
    endedAt: now, error: null, abortReason: null,
    metadata: { trigger: 'task-dispatch', statusMsgRef: { conduit: 'C-sm-test', messageId: 'msg-1' } },
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

test('sealSuspendedStatusMsg updates the persisted status message on a terminal thread', async () => {
  const adapter = new MockAdapter();
  const t = makeThread({ status: 'completed' });
  await sealSuspendedStatusMsg(t.id, adapter);
  assert.equal(adapter.updated.length, 1);
  assert.equal(adapter.updated[0].ref.messageId, 'msg-1');
  assert.match(adapter.updated[0].content.text || '', /complete/i);
});

test('sealSuspendedStatusMsg shows re-suspension when the thread is waiting again', async () => {
  const adapter = new MockAdapter();
  const t = makeThread({ status: 'waiting' });
  await threadStore.mutate(t.id, (r) => { r.metadata!.waitingOnTasks = ['ab12', 'cd34']; });
  await sealSuspendedStatusMsg(t.id, adapter);
  assert.equal(adapter.updated.length, 1);
  assert.match(adapter.updated[0].content.text || '', /waiting on 2/);
});

test('sealSuspendedStatusMsg is a no-op without a persisted statusMsgRef', async () => {
  const adapter = new MockAdapter();
  const t = makeThread({ metadata: { trigger: 'task-dispatch' } });
  await sealSuspendedStatusMsg(t.id, adapter);
  assert.equal(adapter.updated.length, 0);
});
