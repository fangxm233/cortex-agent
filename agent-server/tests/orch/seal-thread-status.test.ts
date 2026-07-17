// input:  sealThreadStatus (orch/status-helpers) + MockAdapter
// output: one terminal-seal function for the interactive `!thread` and background/resume paths:
//         text is buildThreadSummary; interactive attaches SEALED action blocks (Cancel removed),
//         background attaches none.
// pos:    Unification regression — thread-executor (3 sites) + thread-callback.sealSuspendedStatusMsg
//         previously each inlined buildThreadSummary + updateMessage; the missing call is what froze
//         rate-limit-resume status messages. Funnelling them through one function makes the seal
//         hard to forget. The dispatch seal (finalizeThreadSuccess) stays separate by layer/design.
// >>> If I am updated, update my require first <<<
import '../_test-home.js'; // MUST be first — isolates store singletons pulled in by status-helpers
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { sealThreadStatus } from '../../src/orchestration/status-helpers.js';
import { buildThreadSummary } from '../../src/domain/threads/runner.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { RichBlock, ActionElement } from '../../src/platform/index.js';
import type { ThreadRecord } from '../../src/core/types/thread-types.js';

function makeCompletedResult(): { thread: ThreadRecord; totalCostUsd: number; totalNumTurns: number; finalOutput: null; lastAgentResult: null; executionId: null } {
  const created = '2026-06-29T00:00:00.000Z';
  const ended = '2026-06-29T00:02:17.000Z';
  const thread = {
    id: 'thr_seal', templateName: 'coder-reviewer', status: 'completed',
    channel: 'C-seal', projectId: 'general', platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'coder', activeStage: null, currentStepIndex: 1,
    steps: [
      { agentSlotId: 'coder', stage: 'impl', numTurns: 12, costUsd: 0.1, durationS: 60 },
      { agentSlotId: 'reviewer', stage: 'implReview', numTurns: 25, costUsd: 0.2, durationS: 77 },
    ],
    iterationCounts: {}, totalCostUsd: 0.3, createdAt: created, updatedAt: ended,
    endedAt: ended, error: null, abortReason: null, metadata: {},
  } as unknown as ThreadRecord;
  return { thread, totalCostUsd: 0.3, totalNumTurns: 37, finalOutput: null, lastAgentResult: null, executionId: null };
}

function actionsBlock(blocks: RichBlock[] | undefined): ActionElement[] {
  const actions = (blocks ?? []).find((b: any) => b.type === 'actions') as any;
  return (actions?.elements as ActionElement[] | undefined) ?? [];
}

test('background style: text is buildThreadSummary, no action blocks attached', async () => {
  const adapter = new MockAdapter();
  const ref = { conduit: 'C-seal', messageId: 'M1' };
  const result = makeCompletedResult();

  await sealThreadStatus(adapter as any, ref, result as any);

  assert.equal(adapter.updated.length, 1);
  const update = adapter.updated[0];
  assert.deepEqual(update.ref, ref);
  assert.equal(update.content.text, buildThreadSummary(result as any), 'text is exactly buildThreadSummary');
  assert.equal((update.content as any).richBlocks, undefined, 'no richBlocks without a blocksTemplate');
});

test('interactive style: same summary text, SEALED action blocks (Cancel button removed)', async () => {
  const adapter = new MockAdapter();
  const ref = { conduit: 'C-seal', messageId: 'M2' };
  const result = makeCompletedResult();

  await sealThreadStatus(adapter as any, ref, result as any, {
    blocksTemplate: { channel: 'C-seal', sessionName: null, isDm: false, threadId: 'thr_seal' },
  });

  const update = adapter.updated[0];
  assert.equal(update.content.text, buildThreadSummary(result as any), 'text identical to background style');
  const blocks = (update.content as any).richBlocks as RichBlock[] | undefined;
  assert.ok(blocks && blocks.length > 0, 'richBlocks present for interactive style');
  const cancel = actionsBlock(blocks).find((e: any) => e.actionId === 'status_cancel');
  assert.equal(cancel, undefined, 'Cancel button removed in the sealed (terminal) message');
  const section = (blocks ?? []).find((b: any) => b.type === 'section') as any;
  assert.equal(section.text, update.content.text, 'section text matches the message text');
});

test('seal propagates a delivery failure to the caller (no internal swallow)', async () => {
  const adapter = new MockAdapter();
  adapter.failUpdateMessageCount = 1;
  const ref = { conduit: 'C-seal', messageId: 'M3' };

  await assert.rejects(
    () => sealThreadStatus(adapter as any, ref, makeCompletedResult() as any),
    'failure surfaces so each caller keeps its own error posture (background swallows, interactive/dispatch propagate)',
  );
});
