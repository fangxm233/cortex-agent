import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
/**
 * ThreadRun unit tests (T2.1) — the six verdicts, the busy-gate bracket, and the one behaviour
 * the pre-refactor pipeline could not have: a progress write that arrives AFTER the seal is
 * dropped instead of overwriting the summary (plan §3-2).
 *
 * Seam: the four `domain/threads/runner` entrypoints are mocked, so what is under test is purely
 * ThreadRun's own sequence — status message → stream → surface → verdict → render → settle.
 * `tests/orch/thread-golden.test.ts` covers the same code against the REAL runner.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const runner = vi.hoisted(() => ({
  runThread: vi.fn(),
  continueThread: vi.fn(),
  resumeThread: vi.fn(),
  resumeRateLimitedThread: vi.fn(),
}));
vi.mock('@domain/threads/runner.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runThread: (...args: unknown[]) => runner.runThread(...args),
  continueThread: (...args: unknown[]) => runner.continueThread(...args),
  resumeThread: (...args: unknown[]) => runner.resumeThread(...args),
  resumeRateLimitedThread: (...args: unknown[]) => runner.resumeRateLimitedThread(...args),
}));

import { openThreadRun, openThreadRunDetached, type ThreadRunInput } from '../../src/orchestration/thread-run/index.js';
import { threadStore } from '../../src/store/thread-repo.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { ThreadRecord, ThreadStatus, ThreadSurface } from '../../src/core/types/thread-types.js';

let adapter: MockAdapter;
let seq = 0;
const createdThreadIds = new Set<string>();

beforeEach(() => {
  adapter = new MockAdapter();
  for (const fn of Object.values(runner)) fn.mockReset();
});

afterEach(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  createdThreadIds.clear();
  await threadStore.flush();
});

/** A persisted thread record in `status`, so ThreadRun's verdict reads real store state. */
function makeThread(status: ThreadStatus, over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = `thr_tr${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec = {
    id, templateName: 'golden', status, channel: 'C-tr', projectId: 'general',
    platformThreadId: null, userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'main', activeStage: null, currentStepIndex: 1,
    steps: [{ agentSlotId: 'main', stage: null, numTurns: 2, costUsd: 0.01, durationS: 1 }],
    iterationCounts: {}, totalCostUsd: 0.01, createdAt: now, updatedAt: now,
    endedAt: now, error: null, abortReason: null, metadata: {}, ...over,
  } as unknown as ThreadRecord;
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

function result(thread: ThreadRecord, lastAgentResult: unknown = null) {
  return {
    thread, totalCostUsd: thread.totalCostUsd, totalNumTurns: 2,
    finalOutput: null, lastAgentResult, executionId: null, stopReason: null,
  };
}

/** One conduit per thread: the status-message serializer keys on conduit:messageId and remembers
 *  a sealed ref for 60s, so a shared conduit would leak "sealed" between tests (MockAdapter
 *  restarts its message-id counter for every adapter). */
function input(threadId: string, over: Partial<ThreadRunInput> = {}): ThreadRunInput {
  const channel = `C-${threadId}`;
  return {
    threadId, mode: { kind: 'start' }, channel, adapter: adapter as any,
    destination: { type: 'interactive-reply', conduit: channel, sessionId: '' },
    threadAnchorId: null, claimPlatformThread: false, statusMessage: null,
    render: { kind: 'summary', blocks: { channel, sessionName: null, isDm: false, threadId }, startText: '⏳ Starting...' },
    interactive: false, settle: null, ...over,
  };
}

const texts = () => adapter.updated.map((u) => u.content.text);
const lastText = (): string => String(texts()[texts().length - 1] ?? '');

// --- the six verdicts -------------------------------------------------------------------------

test('completed: the status message is sealed with the thread summary', async () => {
  const thread = makeThread('completed');
  runner.runThread.mockResolvedValue(result(thread));

  const outcome = await openThreadRun(input(thread.id));

  expect(outcome.verdict).toBe('completed');
  expect(outcome.error).toBeNull();
  expect(outcome.statusMsg).not.toBeNull();
  expect(lastText()).toMatch(/^✅ Thread complete \| 1 steps/);
  // Sealed blocks: the section survives, the Cancel button does not.
  const blocks = adapter.updated[adapter.updated.length - 1].content.richBlocks as any[];
  expect(JSON.stringify(blocks)).not.toContain('status_cancel');
});

test('failed: a thrown error seals "Thread failed (<elapsed>)" and never rejects', async () => {
  const thread = makeThread('failed');
  runner.runThread.mockRejectedValue(new Error('boom'));

  const outcome = await openThreadRun(input(thread.id));

  expect(outcome.verdict).toBe('failed');
  expect(outcome.error?.message).toBe('boom');
  expect(outcome.result).toBeNull();
  expect(lastText()).toMatch(/^❌ Thread failed \(\d+s\): boom$/);
});

test('cancelled: error.cancelled seals "Cancelled (<elapsed>)"', async () => {
  const thread = makeThread('failed');
  const error = Object.assign(new Error('cancelled by user'), { cancelled: true });
  runner.runThread.mockRejectedValue(error);

  const outcome = await openThreadRun(input(thread.id));

  expect(outcome.verdict).toBe('cancelled');
  expect(lastText()).toMatch(/^🛑 Cancelled \(\d+s\)$/);
});

test('waiting: suspension WRITES the child count, does not seal, and persists statusMsgRef', async () => {
  const thread = makeThread('waiting', { metadata: { waitingOn: ['thr_kid'], waitingOnTasks: ['ab12'] } });
  runner.runThread.mockResolvedValue(result(thread));

  const outcome = await openThreadRun(input(thread.id));

  expect(outcome.verdict).toBe('waiting');
  // waitingOn + waitingOnTasks, and no action blocks (the message is not terminal).
  expect(lastText()).toBe('⏳ Thread suspended — waiting on 2 child(ren)');
  expect(adapter.updated[adapter.updated.length - 1].content.richBlocks).toBeUndefined();
  expect(threadStore.get(thread.id)?.metadata?.statusMsgRef).toEqual(outcome.statusMsg);
});

test('rate_limited: a paused thread gets the paused summary and persists statusMsgRef', async () => {
  const thread = makeThread('rate_limited');
  runner.runThread.mockResolvedValue(result(thread));

  const outcome = await openThreadRun(input(thread.id));

  expect(outcome.verdict).toBe('rate_limited');
  expect(lastText()).toContain('Thread paused — rate limited, will auto-resume');
  expect(threadStore.get(thread.id)?.metadata?.statusMsgRef).toEqual(outcome.statusMsg);
});

test('rate_limited_exhausted: rateLimited without a paused thread is terminal (sealed, no ref)', async () => {
  const thread = makeThread('completed');
  runner.runThread.mockResolvedValue(result(thread, { rateLimited: true }));

  const outcome = await openThreadRun(input(thread.id));

  expect(outcome.verdict).toBe('rate_limited_exhausted');
  expect(lastText()).toMatch(/^✅ Thread complete/);
  expect(threadStore.get(thread.id)?.metadata?.statusMsgRef).toBeUndefined();
});

// --- mode / surface / settle ------------------------------------------------------------------

test('mode selects the runner entrypoint and settle fires once with the thread id', async () => {
  const thread = makeThread('completed');
  runner.continueThread.mockResolvedValue(result(thread));
  const settled: string[] = [];

  await openThreadRun(input(thread.id, {
    mode: { kind: 'continue', userMessage: 'more please' },
    settle: async (id) => { settled.push(id); },
  }));

  expect(runner.runThread).not.toHaveBeenCalled();
  expect(runner.continueThread).toHaveBeenCalledTimes(1);
  expect(runner.continueThread.mock.calls[0][1]).toBe('more please');
  expect(settled).toEqual([thread.id]);
});

test('a progress write that arrives AFTER the seal is dropped (plan §3-2)', async () => {
  const thread = makeThread('completed');
  let surface!: ThreadSurface;
  runner.runThread.mockImplementation(async (_id: string, opts: { surface: ThreadSurface }) => {
    surface = opts.surface;
    // Mid-run progress DOES land (multi-agent status line).
    await surface.onStepStarted({ stepNumber: 1, label: 'main', prevLabel: null, multiAgent: true, isFirstStep: true });
    return result(thread);
  });

  await openThreadRun(input(thread.id));
  const sealed = lastText();
  expect(sealed).toMatch(/^✅ Thread complete/);
  expect(texts().some((t) => String(t).includes('Step 1: *main*'))).toBe(true);

  // A straggler from a dying step: before T2.1 this bare updateMessage overwrote the summary.
  surface.onStepProgress({ stepNumber: 1, label: 'main', multiAgent: true, numTurns: 9, durationMs: 1 });
  await new Promise((r) => setTimeout(r, 10));
  expect(lastText()).toBe(sealed);
});

// --- platform thread root ----------------------------------------------------------------------

test('claimPlatformThread: the posted status message becomes platformThreadId only when claimed', async () => {
  const claimed = makeThread('completed');
  runner.runThread.mockResolvedValue(result(claimed));
  const out = await openThreadRun(input(claimed.id, { claimPlatformThread: true }));
  expect(threadStore.get(claimed.id)?.platformThreadId).toBe(out.statusMsg?.messageId);

  // The MCP path: same surface, but the record keeps platformThreadId null (a reply under the
  // status line is still the channel session's, not this thread's).
  const unclaimed = makeThread('completed');
  runner.runThread.mockResolvedValue(result(unclaimed));
  await openThreadRun(input(unclaimed.id, { claimPlatformThread: false }));
  expect(threadStore.get(unclaimed.id)?.platformThreadId).toBeNull();

  // A caller-supplied anchor wins over the status message, claimed or not.
  const anchored = makeThread('completed');
  runner.runThread.mockResolvedValue(result(anchored));
  await openThreadRun(input(anchored.id, { claimPlatformThread: true, threadAnchorId: 'root-ts' }));
  expect(threadStore.get(anchored.id)?.platformThreadId).toBe('root-ts');
});

// --- busy gate ---------------------------------------------------------------------------------

test('detached: track(+1) is synchronous and track(-1) waits for settle AND onSettled', async () => {
  const thread = makeThread('completed');
  const order: string[] = [];
  runner.runThread.mockImplementation(async () => { order.push('run'); return result(thread); });

  openThreadRunDetached(
    input(thread.id, { settle: async () => { order.push('settle'); } }),
    () => { order.push('onSettled'); },
    { track: (d) => order.push(`track:${d}`) },
  );
  expect(order).toEqual(['track:1']); // synchronous, before anything runs

  await new Promise((r) => setTimeout(r, 20));
  expect(order).toEqual(['track:1', 'run', 'settle', 'onSettled', 'track:-1']);
});

test('awaited: openThreadRun does NOT touch the busy gate (the caller already brackets)', async () => {
  const thread = makeThread('completed');
  runner.runThread.mockResolvedValue(result(thread));
  const tracker = await import('../../src/orchestration/busy-tracker.js');
  const spy = vi.spyOn(tracker, 'trackPendingTask');

  await openThreadRun(input(thread.id));

  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
