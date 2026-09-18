import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { threadStore } from '../src/store/thread-repo.js';
import { resumeThreadRunInput } from '../src/orchestration/thread-callback.js';
import { setOrchestrationRuntime } from '../src/orchestration/runtime.js';
import { MockAdapter } from '../src/platform/testing.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
  setOrchestrationRuntime({ adapter: null });
});

function makeThread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = over.id ?? `thr_rs${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: 'manager', status: 'rate_limited' as ThreadStatus,
    channel: 'C-rs-test', projectId: 'general', platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'manager', activeStage: null, currentStepIndex: 0,
    steps: [], iterationCounts: {}, totalCostUsd: 0, createdAt: now, updatedAt: now,
    endedAt: null, error: null, abortReason: null,
    metadata: { trigger: 'task-dispatch', statusMsgRef: { conduit: 'C-rs-test', messageId: 'msg-42' } },
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

// The persisted statusMsgRef is the status message a resumed run keeps updating and finally
// refreshes. Since T2.1 it is a field of the ThreadRunInput the resume paths hand to ThreadRun
// (it was a RunThreadOptions field before T1.1, then a closure inside the surface), so these
// tests assert it directly.

test('resumeThreadRunInput restores the persisted statusMsg without rebuilding dispatch hooks', () => {
  const adapter = new MockAdapter();
  setOrchestrationRuntime({ adapter });
  const t = makeThread({
    metadata: {
      trigger: 'task-dispatch',
      taskId: 'a1b2',
      taskProject: 'atlas',
      statusMsgRef: { conduit: 'C-rs-test', messageId: 'msg-42' },
    },
  });
  const input = resumeThreadRunInput(t, 'resume-rate-limited');
  assert.ok(input, 'expected an input to be built');
  assert.deepEqual(input!.statusMessage, { conduit: 'C-rs-test', messageId: 'msg-42' });
  assert.deepEqual(input!.mode, { kind: 'resume-rate-limited' });
  assert.equal(input!.extraHooks, undefined);
  // project-report: the thread was dispatched, not started from a conversation.
  assert.equal(input!.destination.type, 'project-report');
  // No buttons and no interactive capture — nobody is watching this message any more.
  assert.equal(input!.render.kind, 'summary');
  assert.equal((input!.render as { blocks: unknown }).blocks, null);
  assert.equal(input!.interactive, false);
});

test('resumeThreadRunInput leaves statusMessage null when no statusMsgRef was persisted', () => {
  const adapter = new MockAdapter();
  setOrchestrationRuntime({ adapter });
  const t = makeThread({ metadata: { trigger: 'task-dispatch' } });
  const input = resumeThreadRunInput(t, 'resume');
  assert.ok(input, 'expected an input to be built');
  assert.equal(input!.statusMessage, null);
  assert.deepEqual(input!.mode, { kind: 'resume' });
});
