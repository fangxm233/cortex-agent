import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { threadStore } from '../src/store/thread-repo.js';
import { buildResumeOptions } from '../src/orchestration/thread-callback.js';
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

// The persisted statusMsgRef is no longer a RunThreadOptions field (T1.1): it is captured by the
// surface the resume path builds. These two tests assert the same property one level out — a
// step-boundary report from the runner does / does not land on the persisted message.
const stepInfo = { stepNumber: 1, label: 'manager', prevLabel: null, multiAgent: true, isFirstStep: true };

test('buildResumeOptions restores statusMsg without rebuilding dispatch hooks', async () => {
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
  const opts = buildResumeOptions(t);
  assert.ok(opts, 'expected options to be built');
  await opts!.surface.onStepStarted(stepInfo);
  assert.deepEqual(adapter.updated.map((u) => u.ref), [{ conduit: 'C-rs-test', messageId: 'msg-42' }]);
  assert.equal(opts!.extraHooks, undefined);
});

test('buildResumeOptions leaves statusMsg null when no statusMsgRef was persisted', async () => {
  const adapter = new MockAdapter();
  setOrchestrationRuntime({ adapter });
  const t = makeThread({ metadata: { trigger: 'task-dispatch' } });
  const opts = buildResumeOptions(t);
  assert.ok(opts, 'expected options to be built');
  await opts!.surface.onStepStarted(stepInfo);
  assert.deepEqual(adapter.updated, []);
});

test('buildResumeOptions returns null without an adapter', () => {
  setOrchestrationRuntime({ adapter: null });
  const t = makeThread();
  assert.equal(buildResumeOptions(t), null);
});
