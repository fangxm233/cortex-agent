import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
/**
 * render-task (T2.2) — every TASK-style status line, in both flavours, plus the two contracts
 * `ThreadRun` owes the dispatch / scheduled jobs:
 *   1. `decide` runs BEFORE anything is rendered (a line must never claim an effect that has not
 *      happened — plan §4), and
 *   2. a `decide` that throws is contained: the error line is still drawn, `outcome.error` carries
 *      the failure, and `openThreadRun` resolves.
 *
 * Seam: the `domain/threads/runner` entrypoints are mocked, as in tests/orch/thread-run.test.ts.
 * The same strings are locked against the REAL jobs by goldens 7–10.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const runner = vi.hoisted(() => ({ runThread: vi.fn() }));
vi.mock('@domain/threads/runner.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runThread: (...args: unknown[]) => runner.runThread(...args),
}));

import {
  openThreadRun, type TaskRender, type TaskVerdict, type ThreadRunInput,
} from '../../src/orchestration/thread-run/index.js';
import { ctx as jobCtx, requireJobCtx } from '../../src/domain/scheduling/job-registry.js';
import { threadStore } from '../../src/store/thread-repo.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { ThreadRecord, ThreadStatus } from '../../src/core/types/thread-types.js';

let adapter: MockAdapter;
let seq = 0;
const createdThreadIds = new Set<string>();

beforeEach(() => {
  adapter = new MockAdapter();
  runner.runThread.mockReset();
});

afterEach(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  createdThreadIds.clear();
  await threadStore.flush();
  jobCtx.runThreadOnSurface = null;
  jobCtx.notify = null;
});

function makeThread(status: ThreadStatus, over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = `thr_rt${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec = {
    id, templateName: 'golden', status, channel: 'C-rt', projectId: 'atlas',
    platformThreadId: null, userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'main', activeStage: null, currentStepIndex: 1,
    steps: [{ agentSlotId: 'main', stage: null, numTurns: 2, costUsd: 0.01, durationS: 1 }],
    iterationCounts: {}, totalCostUsd: 0.25, createdAt: now, updatedAt: now,
    endedAt: now, error: null, abortReason: null, metadata: {}, ...over,
  } as unknown as ThreadRecord;
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

function result(thread: ThreadRecord, lastAgentResult: unknown = { sessionId: 'be-1' }) {
  return {
    thread, totalCostUsd: thread.totalCostUsd, totalNumTurns: 7,
    finalOutput: null, lastAgentResult, executionId: null, stopReason: null,
  };
}

const DISPATCH: TaskRender = {
  kind: 'task', flavour: 'dispatch', project: 'atlas',
  taskText: 'Run the queued implementation', sessionName: 'cortex-aa11', profileName: 'execute',
};
const SCHEDULED: TaskRender = {
  kind: 'task', flavour: 'scheduled', project: 'general',
  taskText: null, sessionName: 'cortex-bb22', profileName: 'plan',
};

/** One conduit per run: `sealStatus` remembers a sealed ref for 60s, keyed conduit:messageId,
 *  and MockAdapter restarts its id counter for every adapter (same reason as thread-run.test.ts). */
function input(threadId: string, render: TaskRender, decide: ThreadRunInput['decide'], over: Partial<ThreadRunInput> = {}): ThreadRunInput {
  const channel = `C-${threadId}`;
  return {
    threadId, mode: { kind: 'start' }, channel, adapter: adapter as any,
    destination: { type: 'project-report', projectId: channel, trigger: 'task-dispatch', sessionId: '' },
    threadAnchorId: null, claimPlatformThread: false, statusMessage: null,
    render, decide, interactive: false, settle: null, ...over,
  };
}

/** Run one thread that ends in `status` and have `decide` report `verdict`; return every line.
 *  A fresh adapter per call so `posted[0]` is always THIS run's opening line. */
async function render(render: TaskRender, status: ThreadStatus, verdict: TaskVerdict, lastAgentResult: unknown = { sessionId: 'be-1' }) {
  adapter = new MockAdapter();
  const thread = makeThread(status);
  runner.runThread.mockResolvedValue(result(thread, lastAgentResult));
  const outcome = await openThreadRun(input(thread.id, render, async () => verdict));
  return {
    thread,
    outcome,
    opening: String(adapter.posted[0]?.content.text ?? ''),
    posted: adapter.posted.map((p) => String(p.content.text)),
    updated: adapter.updated.map((u) => String(u.content.text)),
  };
}

test('suspended — not sealed, so the resumed run can keep writing', async () => {
  const d = await render(DISPATCH, 'waiting', { kind: 'suspended', childThreads: 2, childTasks: 1 });
  expect(d.updated.length).toBeGreaterThan(0);

  // Non-terminal ⇒ ThreadRun persisted the live ref for whoever resumes.
  expect(threadStore.get(d.thread.id)?.metadata?.statusMsgRef).toEqual(d.outcome.statusMsg);
});

test('error — scheduled seals the line and posts a notice; dispatch leaves its line alone', async () => {
  const s = await render(SCHEDULED, 'failed', { kind: 'error', message: 'boom' });
  expect(s.updated.at(-1)).toMatch(/^❌ cortex-bb22 \| Error \(\d+s\)$/);
  expect(s.posted.at(-1)).toBe('Scheduled task error: boom');

  // A failed dispatch has never touched its status message — the job posts the project notice
  // itself (identical text whether the failure was before or during the run).
  const d = await render(DISPATCH, 'failed', { kind: 'error', message: 'boom' });
  expect(d.updated).toEqual([]);
  expect(d.posted).toEqual([d.opening]);
});

// --- the two ThreadRun contracts ---------------------------------------------------------------

test('decide runs before the render, and sees the run outcome', async () => {
  const order: string[] = [];
  const thread = makeThread('completed');
  runner.runThread.mockImplementation(async () => { order.push('run'); return result(thread); });
  const spy = vi.spyOn(adapter, 'updateMessage');
  spy.mockImplementation(async () => { order.push('render'); });

  let seen: unknown = null;
  await openThreadRun(input(thread.id, DISPATCH, async (outcome) => {
    order.push('decide');
    seen = { verdict: outcome.verdict, sameThread: outcome.result?.thread === thread };
    return { kind: 'done' };
  }));

  expect(order).toEqual(['run', 'decide', 'render']);
  expect(seen).toEqual({ verdict: 'completed', sameThread: true });
  spy.mockRestore();
});

test('a decide that throws is rendered as the error line, reported, and does not reject', async () => {
  const thread = makeThread('completed');
  runner.runThread.mockResolvedValue(result(thread));

  const outcome = await openThreadRun(input(thread.id, SCHEDULED, async () => {
    throw new Error('bookkeeping failed');
  }));

  expect(outcome.error?.message).toBe('bookkeeping failed');
  expect(outcome.verdict).toBe('completed'); // the RUN succeeded; the job's decision did not
  expect(adapter.updated.map((u) => String(u.content.text)).at(-1)).toMatch(/^❌ cortex-bb22 \| Error \(\d+s\)$/);
  expect(adapter.posted.map((p) => String(p.content.text)).at(-1)).toBe('Scheduled task error: bookkeeping failed');
});

test('a task render without a decide is refused outright', async () => {
  const thread = makeThread('completed');
  runner.runThread.mockResolvedValue(result(thread));
  await expect(openThreadRun(input(thread.id, DISPATCH, undefined))).rejects.toThrow(
    'ThreadRun: a task-style render requires `decide`',
  );
});

// --- the injected job seams ---------------------------------------------------------------------

test('an un-injected job seam names itself instead of silently not rendering', () => {
  jobCtx.runThreadOnSurface = null;
  jobCtx.notify = null;
  expect(() => requireJobCtx('runThreadOnSurface')).toThrow('job ctx: runThreadOnSurface not injected');
  expect(() => requireJobCtx('notify')).toThrow('job ctx: notify not injected');

  jobCtx.notify = async () => {};
  expect(requireJobCtx('notify')).toBeTypeOf('function');
});
