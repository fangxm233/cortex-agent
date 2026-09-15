// input:  render-summary.renderSummaryOutcome against a thread's PERSISTED statusMsgRef
// output: stale "suspended — waiting on children" Slack message gets refreshed on terminal/re-suspend
// pos:    Regression for the 2026-06-11 verification finding: thr_1cfda9a9 completed but its
//         dispatch status message still read "suspended — waiting on N child task(s)".
//         T2.1: the function under test used to be thread-callback's suspended-status refresh,
//         called from the two resume paths' onSettled. It is now ThreadRun's render, reached
//         with the same input (a record + the ref persisted at suspension) — a terminal verdict
//         SEALS the summary, `waiting` only WRITES the new suspension count (never seals: the
//         thread will be resumed and the resumed run keeps updating this very message).

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { threadStore } from '../src/store/thread-repo.js';
import { renderSummaryOutcome } from '../src/orchestration/thread-run/index.js';
import type { ThreadVerdict } from '../src/orchestration/thread-run/index.js';
import { MockAdapter } from '../src/platform/testing.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

/** What ThreadRun does when it renders a thread it re-entered: the persisted ref is the status
 *  message, there are no action blocks (no live user), and the result is rebuilt from the record. */
function renderPersisted(t: ThreadRecord, adapter: MockAdapter, verdict: ThreadVerdict): Promise<void> {
  return renderSummaryOutcome(
    {
      adapter: adapter as any,
      statusMsg: threadStore.get(t.id)?.metadata?.statusMsgRef ?? null,
      blocks: null,
      destination: { type: 'project-report', projectId: 'general', trigger: 'task-dispatch', sessionId: '' },
      threadAnchorId: null,
      startTime: Date.now(),
    },
    { threadId: t.id, verdict, thread: threadStore.get(t.id), result: null, error: null },
  );
}

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
    metadata: { trigger: 'task-dispatch', statusMsgRef: { conduit: 'C-sm-test', messageId: `msg-${id}` } },
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

test('a terminal verdict updates the persisted status message with the summary', async () => {
  const adapter = new MockAdapter();
  const t = makeThread({ status: 'completed' });
  await renderPersisted(t, adapter, 'completed');
  assert.equal(adapter.updated.length, 1);
  assert.deepEqual(adapter.updated[0].ref, t.metadata!.statusMsgRef);
  assert.match(adapter.updated[0].content.text || '', /complete/i);
});

test('a waiting verdict shows re-suspension when the thread is waiting again', async () => {
  const adapter = new MockAdapter();
  const t = makeThread({ status: 'waiting' });
  await threadStore.mutate(t.id, (r) => { r.metadata!.waitingOnTasks = ['ab12', 'cd34']; });
  await renderPersisted(t, adapter, 'waiting');
  assert.equal(adapter.updated.length, 1);
  assert.match(adapter.updated[0].content.text || '', /waiting on 2/);
});

test('rendering is a no-op without a persisted statusMsgRef', async () => {
  const adapter = new MockAdapter();
  const t = makeThread({ metadata: { trigger: 'task-dispatch' } });
  await renderPersisted(t, adapter, 'completed');
  assert.equal(adapter.updated.length, 0);
});
