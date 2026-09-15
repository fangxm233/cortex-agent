import './../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
/**
 * Thread-run GOLDEN (characterization) tests — Phase 0 of the thread-run refactor.
 *
 * These 10 tests lock the side-effect SEQUENCE of the four thread entrypoints as the code
 * behaves TODAY. They are deliberately over-specified: every `expectOps` call asserts the
 * whole interleaved post/update op array (and, derived from it, the whole `adapter.posted`
 * and `adapter.updated` arrays) with `toEqual`, so both the ORDER and the CALL COUNT are
 * exact. Volatile substrings (thread ids, session names, elapsed seconds) are matched with
 * `stringMatching`/`stringContaining`; everything else is byte-exact.
 *
 * If a refactor changes one of these arrays, that is a real behavior change: either it is
 * listed as an intended change in the plan (§3) and the golden gets updated deliberately,
 * or it is a regression.
 *
 * Seams (only these are faked — every layer under the entrypoint is the real code):
 *   - `@domain/runs/service#startRun`  the single backend seam (same seam as turn-golden.test.ts)
 *   - `session-gateway#deliverToSession`  so `wakeSession` does not run a whole extra turn
 *   - `domain/tasks/dispatcher#selectAndClaimTask`  so no real TASKS.yaml claim is needed
 *   - `job-registry.ctx` (adapter/bus) injection, as in tests/task-dispatch-hooks.test.ts
 * The thread runner, state machine, status helpers, output stream, thread-callback,
 * scheduled-task job and task-dispatch job all run for real.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { mockStartRun, mockDeliverToSession, mockSelectAndClaimTask } = vi.hoisted(() => ({
  mockStartRun: vi.fn(),
  mockDeliverToSession: vi.fn(),
  mockSelectAndClaimTask: vi.fn(),
}));

vi.mock('@domain/runs/service.js', () => ({
  startRun: (...args: unknown[]) => mockStartRun(...args),
}));
vi.mock('../../src/orchestration/session-gateway.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deliverToSession: (...args: unknown[]) => mockDeliverToSession(...args),
}));
vi.mock('../../src/domain/tasks/dispatcher.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  selectAndClaimTask: (...args: unknown[]) => mockSelectAndClaimTask(...args),
}));

import {
  agentResult, cancelledError, expectOps, fakeRun, installGoldenTemplates, makeLiveThread,
  post, settleTails, TracingAdapter, update, waitFor,
} from './_thread-golden-fixture.js';
import { ThreadExecutor } from '../../src/orchestration/thread-executor.js';
import { createWebhookHandler } from '../../src/orchestration/routing/webhook.js';
import { setOrchestrationRuntime } from '../../src/orchestration/runtime.js';
import { _testResetCallbackState } from '../../src/orchestration/thread-callback.js';
import { registerChildSpawn } from '../../src/domain/threads/tree.js';
import { threadStore } from '../../src/store/thread-repo.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { ctx as jobCtx } from '../../src/domain/scheduling/job-registry.js';
import { _testResetDispatchCycles, taskDispatchRunner } from '../../src/domain/scheduling/jobs/task-dispatch.js';
import { runScheduledTask } from '../../src/domain/scheduling/jobs/scheduled-task.js';
import * as throttle from '../../src/domain/costs/rate-limit-throttle.js';
import * as resumeRegistry from '../../src/domain/costs/resume-registry.js';
import { MockAdapter } from '../../src/platform/testing.js';

const WEBHOOK_TOKEN = 'thread-golden-token';
process.env.CORTEX_WEBHOOK_TOKEN = WEBHOOK_TOKEN;

let webhookHandler: ReturnType<typeof createWebhookHandler>;
let adapter: TracingAdapter;
let bus: { publish: ReturnType<typeof vi.fn> };

beforeAll(() => {
  installGoldenTemplates();
  webhookHandler = createWebhookHandler();
});

beforeEach(() => {
  delete process.env.DEBUG;
  mockStartRun.mockReset();
  mockDeliverToSession.mockReset();
  mockDeliverToSession.mockResolvedValue(undefined);
  mockSelectAndClaimTask.mockReset();
  adapter = new TracingAdapter();
  bus = { publish: vi.fn() };
  setOrchestrationRuntime({ adapter: adapter as any });
  jobCtx.adapter = adapter as any;
  jobCtx.bus = bus as any;
  jobCtx.schedulerRef = null;
  jobCtx.buildInteractiveCallbacks = null;
  jobCtx.onThreadSuspended = null;
  _testResetCallbackState();
});

afterEach(() => {
  setOrchestrationRuntime({ adapter: null });
  jobCtx.adapter = null;
  jobCtx.bus = null;
  _testResetDispatchCycles();
  throttle._testReset();
  resumeRegistry._testReset();
});

// --- drivers (real entrypoints) ---------------------------------------------------------------

/** Drive the REAL `threadExecutor.route` for `!thread <name> <msg>`. `execute` is NOT injected,
 *  so `_executeReal` → `handleThreadStart` → `runThread` all run. `enqueue` is captured so the
 *  test can await the queued work (the daemon's serial queue is not under test here). */
async function routeThreadStart(channel: string, name: string, message: string): Promise<void> {
  const text = `!thread ${name} ${message}`;
  let queued: Promise<void> | null = null;
  const executor = new ThreadExecutor({
    enqueue: (_channel, fn) => { queued = fn(); return true; },
    track: () => {},
  });
  await executor.route({
    message: { ref: { conduit: channel, messageId: 'M1', threadId: null }, text, isBot: false, files: [] },
    channel, adapter: adapter as any, threadAnchorId: null, hasFiles: false,
    agentMessage: message, threadAddMatch: null,
    threadStartMatch: [text, name, message] as any,
    existingThread: null, isActiveThread: false,
  } as any);
  await queued;
  await settleTails();
}

/** POST /webhook/thread-op through the REAL exported `createWebhookHandler()`; only the
 *  node:http socket is faked (driver lifted verbatim from tests/webhook-thread-control.test.ts). */
function postThreadOp(body: unknown): Promise<{ statusCode: number; json: any }> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as any;
    req.method = 'POST';
    req.url = '/webhook/thread-op';
    req.headers = { 'x-cortex-token': WEBHOOK_TOKEN };
    let statusCode = 200;
    let payload = '';
    const res: any = {
      writeHead: (code: number) => { statusCode = code; },
      end: (chunk?: string) => {
        if (chunk) payload += chunk;
        let json: any = null;
        try { json = JSON.parse(payload); } catch { /* non-JSON body */ }
        resolve({ statusCode, json });
      },
    };
    webhookHandler(req, res);
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
}

function activeCountDeltas(delta: number): number {
  return bus.publish.mock.calls.filter(
    ([event]: [{ type: string; delta?: number }]) => event.type === 'llm.active-count-delta' && event.delta === delta,
  ).length;
}
const busTypes = (): string[] => bus.publish.mock.calls.map(([event]: [{ type: string }]) => event.type);
const busEvent = (type: string): any => bus.publish.mock.calls.map(([e]: any[]) => e).find((e: any) => e.type === type);

/** startRun assertions shared by all 10 goldens: call count + per-call trigger/threadId. */
function expectStartRun(expected: Array<{ trigger: string; threadId: string }>): void {
  expect(mockStartRun).toHaveBeenCalledTimes(expected.length);
  expect(mockStartRun.mock.calls.map(([request]: any[]) => ({
    trigger: request.context.trigger, threadId: request.context.threadId,
  }))).toEqual(expected);
}
const startRunThreadId = (): string => (mockStartRun.mock.calls[0][0] as any).context.threadId;

const THREAD_ID = /^thr_[0-9a-f]{8}$/;
const SESSION_NAME = /^cortex-[0-9a-f]{6}$/;

const DISPATCH_SELECTION = {
  task: {
    id: 'gtask-1', project: 'atlas',
    text: 'Run the golden dispatch task', template: 'golden-solo-tpl',
  },
  template: 'golden-solo-tpl',
  prompt: 'do the dispatch work',
  dispatchGeneration: 'gen-a',
};

// --- 1. `!thread <agent> msg`, single agent, success ------------------------------------------

test('golden 1: !thread single-agent success — start post, blocks update, streamed output, sealed summary', async () => {
  mockStartRun.mockImplementation(() => fakeRun(Promise.resolve(agentResult({ finalOutput: 'solo done' }))));

  await routeThreadStart('golden-c1', 'golden-solo', 'hi');

  expectOps(adapter, [
    post('interactive-reply', '⏳ Starting thread (agent:golden-solo)...'),
    update('⏳ Starting thread (agent:golden-solo)...', true),
    post('interactive-reply', 'solo done'),
    update(expect.stringMatching(/^✅ Thread complete \| 1 steps \| \$0\.0100 \| \d+s$/), true),
  ]);
  expectStartRun([{ trigger: 'thread-step', threadId: expect.stringMatching(THREAD_ID) as any }]);
  expect(threadStore.get(startRunThreadId())?.status).toBe('completed');
  expect(busTypes()).toEqual([
    'thread.created', 'thread.step.started', 'session.message',
    'thread.step.finished', 'thread.completed',
  ]);
});

// --- 2. `!thread <template> msg`, two agents ---------------------------------------------------

test('golden 2: !thread two-agent template — per-step status updates + streamed step boundary', async () => {
  let step = 0;
  mockStartRun.mockImplementation(() => {
    step += 1;
    return fakeRun(Promise.resolve(agentResult({ finalOutput: `step${step} out` })));
  });

  await routeThreadStart('golden-c2', 'golden-pair', 'go');

  const threadId = startRunThreadId();
  expectOps(adapter, [
    post('interactive-reply', '⏳ Starting thread (golden-pair)...'),
    update('⏳ Starting thread (golden-pair)...', true),
    // T2.1 (plan §3-2): step status lines go through status-helpers.writeStatus now, which
    // regenerates richBlocks from the template stored by initStatusBlocks — so blocks flipped
    // false → true here. That IS the fix: the bare adapter.updateMessage these lines used to make
    // carried no blocks, which is why the Cancel button vanished as soon as a multi-agent thread
    // reached its second step. (writeStatus is also serialized, so a late progress write can no
    // longer overwrite the seal below.)
    update(expect.stringMatching(new RegExp(`^⏳ Thread ${threadId} \\| Step 1: \\*golden-a1\\* \\| ⏱️ \\d+s$`)), true),
    post('interactive-reply', '➡️ Step 2: *golden-a2* starting (prev: golden-a1)'),
    update(expect.stringMatching(new RegExp(`^⏳ Thread ${threadId} \\| Step 2: \\*golden-a2\\* \\| ⏱️ \\d+s$`)), true),
    post('interactive-reply', 'step2 out'),
    update(expect.stringContaining('✅ Thread complete | 2 steps | $0.0200 |'), true),
  ]);
  // Per-step lines are only rendered when steps.length > 1.
  expect(adapter.updated[3].content.text).toContain('golden-a1: 2 turns · $0.0100');
  expect(adapter.updated[3].content.text).toContain('golden-a2: 2 turns · $0.0100');
  expectStartRun([
    { trigger: 'thread-step', threadId },
    { trigger: 'thread-step', threadId },
  ]);
  expect(busTypes()).toEqual([
    'thread.created', 'thread.step.started', 'session.message',
    'thread.step.finished', 'thread.transitioned',
    'thread.step.started', 'session.message',
    'thread.step.finished', 'thread.completed',
  ]);
});

// --- 3. `!thread <template> msg`, second step throws -------------------------------------------

test('golden 3: !thread second step throws — failure SEALS the live status message', async () => {
  let step = 0;
  mockStartRun.mockImplementation(() => {
    step += 1;
    return step === 2
      ? fakeRun(Promise.reject(new Error('boom step 2')))
      : fakeRun(Promise.resolve(agentResult({ finalOutput: 'step1 out' })));
  });

  await routeThreadStart('golden-c3', 'golden-pair', 'go');

  const threadId = startRunThreadId();
  // The QUIRK this golden recorded is FIXED in T2.1 (plan §1.2 steps 6-7): thread-executor's catch
  // only ever learned `statusMsg` from the handler's RETURN value, so a throw inside
  // handleThreadStart left it undefined — the error landed as a fresh post WITHOUT the elapsed
  // suffix and the live status message stayed stuck on "Step 2 …", never sealed. ThreadRun owns
  // the status message across the run, so the `Thread failed (<elapsed>): …` text that was
  // unreachable from this entrypoint now seals it (sealed blocks: Cancel removed). The two step
  // lines carry blocks for the same reason as golden 2 (§3-2).
  expectOps(adapter, [
    post('interactive-reply', '⏳ Starting thread (golden-pair)...'),
    update('⏳ Starting thread (golden-pair)...', true),
    update(expect.stringMatching(new RegExp(`^⏳ Thread ${threadId} \\| Step 1: \\*golden-a1\\* \\| ⏱️ \\d+s$`)), true),
    post('interactive-reply', '➡️ Step 2: *golden-a2* starting (prev: golden-a1)'),
    update(expect.stringMatching(new RegExp(`^⏳ Thread ${threadId} \\| Step 2: \\*golden-a2\\* \\| ⏱️ \\d+s$`)), true),
    update(expect.stringMatching(/^❌ Thread failed \(\d+s\): boom step 2$/), true),
  ]);
  expectStartRun([
    { trigger: 'thread-step', threadId },
    { trigger: 'thread-step', threadId },
  ]);
  expect(threadStore.get(threadId)?.status).toBe('failed');
  expect(threadStore.get(threadId)?.error).toContain('boom step 2');
  expect(busTypes()).toEqual([
    'thread.created', 'thread.step.started', 'session.message',
    'thread.step.finished', 'thread.transitioned',
    'thread.step.started', 'session.message', 'thread.failed',
  ]);
});

// --- 4. `!thread <agent> msg` cancelled (error.cancelled) --------------------------------------

test('golden 4: !thread cancelled — "🛑 Cancelled (<elapsed>)" SEALS the status message', async () => {
  mockStartRun.mockImplementation(() => fakeRun(Promise.reject(cancelledError())));

  await routeThreadStart('golden-c4', 'golden-solo', 'hi');

  // Same fix as golden 3 (plan §1.2 steps 6-7): the `Cancelled (<elapsed>)` variant was
  // unreachable from this entrypoint because the catch never saw a statusMsg. ThreadRun holds it,
  // so cancellation seals the live message instead of posting a second, elapsed-less one. The
  // no-status-message fallback (`🛑 Cancelled`, posted) survives for a channel-less run.
  expectOps(adapter, [
    post('interactive-reply', '⏳ Starting thread (agent:golden-solo)...'),
    update('⏳ Starting thread (agent:golden-solo)...', true),
    update(expect.stringMatching(/^🛑 Cancelled \(\d+s\)$/), true),
  ]);
  expectStartRun([{ trigger: 'thread-step', threadId: expect.stringMatching(THREAD_ID) as any }]);
  expect(threadStore.get(startRunThreadId())?.status).toBe('failed');
  expect(busTypes()).toEqual([
    'thread.created', 'thread.step.started', 'session.message',
    'thread.failed',
  ]);
});

// --- 5. webhook thread_start (with channel) → completion → inline seal → fireThreadCallback ----

test('golden 5: webhook thread_start with channel — inline seal then exactly one wakeSession', async () => {
  mockStartRun.mockImplementation(() => fakeRun(Promise.resolve(
    agentResult({ finalOutput: 'child done', total_cost_usd: 0.02, num_turns: 3 }),
  )));

  const reply = await postThreadOp({
    action: 'start', agent: 'golden-solo', message: 'do it',
    channel: 'golden-w5', projectId: 'general',
    parentSessionId: 'sess-parent', parentChannel: 'golden-parent',
  });

  expect(reply.statusCode).toBe(200);
  expect(reply.json).toEqual({ success: true, data: { threadId: expect.stringMatching(THREAD_ID), status: 'running' } });
  const threadId = reply.json.data.threadId;
  // The thread runs detached: the HTTP reply races the run, so wait on the effect.
  await waitFor(() => mockDeliverToSession.mock.calls.length > 0, 'thread callback fired');
  await settleTails();

  expectOps(adapter, [
    post('interactive-reply', '⏳ Starting thread (agent:golden-solo)...'),
    update('⏳ Starting thread (agent:golden-solo)...', true),
    post('interactive-reply', 'child done'),
    // Sealed by ThreadRun's terminal render (T2.1). This used to be an inline buildThreadSummary +
    // buildSealedStatusActionBlocks inside webhook.onSettled — one of the 4 seal sites now unified.
    update(expect.stringMatching(/^✅ Thread complete \| 1 steps \| \$0\.0200 \| \d+s$/), true),
  ]);
  expectStartRun([{ trigger: 'mcp-thread', threadId }]);
  expect(threadStore.get(threadId)?.status).toBe('completed');

  // parentSessionId present + no parentThreadId → single-fire wakeSession on the parent channel.
  expect(mockDeliverToSession).toHaveBeenCalledTimes(1);
  expect(mockDeliverToSession.mock.calls[0][0]).toEqual({
    channel: 'golden-parent',
    origin: 'thread-callback',
    tag: `thr_${threadId}`,
    text: expect.stringContaining(`[Background thread done] Your thread ${threadId} (golden-solo) status=completed`),
  });
  expect(mockDeliverToSession.mock.calls[0][0].text).toContain('Summary: child done');
  expect(busTypes()).toEqual([
    'thread.created', 'thread.step.started', 'session.message',
    'thread.step.finished', 'thread.completed',
  ]);
});

// --- 6. webhook thread_start → waiting → statusMsgRef persisted + suspended text ---------------

test('golden 6: webhook thread_start suspends on a child — statusMsgRef persisted, no seal, no callback', async () => {
  const childId = 'thr_goldenc6';
  threadStore.set(makeLiveThread(childId, 'golden-w6') as any);
  // The agent's thread_wait tool writes metadata.pendingControl mid-run; the fake run does the
  // same two writes the real tool chain performs (registerChildSpawn + pendingControl).
  mockStartRun.mockImplementation((request: any) => fakeRun((async () => {
    await registerChildSpawn(request.context.threadId, childId, true);
    await threadStore.mutate(request.context.threadId, (record: any) => {
      (record.metadata ??= {}).pendingControl = {
        action: 'wait', kind: null, diagnosis: null, subtasks: null,
        onTasks: null, onThreads: [childId], requestedAtStep: record.currentStepIndex,
      };
    });
    return agentResult({ finalOutput: 'waiting now' });
  })()));

  const reply = await postThreadOp({
    action: 'start', agent: 'golden-solo', message: 'spawn kids',
    channel: 'golden-w6', projectId: 'general',
    parentSessionId: 'sess-parent', parentChannel: 'golden-parent',
  });
  const threadId = reply.json.data.threadId;
  await waitFor(() => threadStore.get(threadId)?.status === 'waiting', 'thread suspended');
  await settleTails();

  expectOps(adapter, [
    post('interactive-reply', '⏳ Starting thread (agent:golden-solo)...'),
    update('⏳ Starting thread (agent:golden-solo)...', true),
    // runner (OutputStream) — "child thread(s)", counted from metadata.waitingOn
    post('interactive-reply', '⏳ Thread suspended — waiting on 1 child thread(s)'),
    // finalizeThread still streams the step's finalOutput even though the thread suspended.
    post('interactive-reply', 'waiting now'),
    // ThreadRun's non-terminal render (was webhook.onSettled) — "child(ren)", counted from
    // waitingOn + waitingOnTasks, NO rich blocks, and NOT sealed: the thread will be resumed and
    // the resumed run keeps writing to this message (plan §1.2 step 7).
    update('⏳ Thread suspended — waiting on 1 child(ren)'),
  ]);
  expectStartRun([{ trigger: 'mcp-thread', threadId }]);

  const suspended = threadStore.get(threadId)!;
  expect(suspended.status).toBe('waiting');
  expect(suspended.metadata?.waitingOn).toEqual([childId]);
  expect(suspended.metadata?.statusMsgRef).toEqual({ conduit: 'golden-w6', messageId: '1000' });
  // Not terminal → fireThreadCallback returns early, so the parent session is NOT woken.
  expect(mockDeliverToSession).not.toHaveBeenCalled();
  expect(busTypes()).toEqual([
    'thread.created', 'thread.step.started', 'session.message',
    'thread.step.finished',
  ]);
});

// --- 7. task-dispatch success ------------------------------------------------------------------

test('golden 7: task-dispatch success — Dispatching post, durableUpdate Done, task.completed', async () => {
  mockSelectAndClaimTask.mockResolvedValue(DISPATCH_SELECTION);
  mockStartRun.mockImplementation(() => fakeRun(Promise.resolve(
    agentResult({ finalOutput: 'dispatch out', total_cost_usd: 0.03, num_turns: 4 }),
  )));

  taskDispatchRunner({ channel: 'atlas', profileName: 'execute' } as any);
  await waitFor(() => activeCountDeltas(-1) === 1, 'dispatch cycle complete');
  await settleTails();

  expectOps(adapter, [
    post('project-report', expect.stringMatching(
      /^🛰️ Dispatching: \[atlas\] Run the golden dispatch task\.\.\. \| cortex-[0-9a-f]{6} \| execute$/,
    )),
    post('project-report', 'dispatch out'),
    // _shared.finalizeThreadSuccess — no outbound queue in tests, so plain adapter.updateMessage.
    update(expect.stringMatching(
      /^✅ Done: \[atlas\] Run the golden dispatch task \| cortex-[0-9a-f]{6} · `golden-backend` \| \(\d+s · 4 turns · \$0\.0300\)$/,
    )),
  ]);
  expectStartRun([{ trigger: 'task-dispatch', threadId: expect.stringMatching(THREAD_ID) as any }]);
  const threadId = startRunThreadId();
  expect(threadStore.get(threadId)?.status).toBe('completed');
  expect(threadStore.get(threadId)?.metadata?.taskId).toBe('gtask-1');
  expect(busTypes()).toEqual([
    'llm.active-count-delta', 'task.claimed', 'task.dispatched',
    'thread.created', 'thread.step.started', 'session.message',
    'thread.step.finished', 'thread.completed',
    'task.completed', 'llm.active-count-delta',
  ]);
  expect(busEvent('task.completed')).toEqual({
    type: 'task.completed', taskId: 'gtask-1', dispatchGeneration: 'gen-a',
  });
});

// --- 8. task-dispatch → rate_limited ----------------------------------------------------------

test('golden 8: task-dispatch rate-limited — paused text + statusMsgRef, no task.completed', async () => {
  await throttle.initRateLimitThrottle(
    new MockAdapter({ adminChannel: 'admin' }) as any,
    { save: async () => {}, load: async () => null } as any,
  );
  await throttle.handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.99, resetsAt: Math.floor(Date.now() / 1000) + 3000 },
    { provider: 'provider-a', displayName: 'Provider A', mode: 'plan' } as any,
  );
  mockSelectAndClaimTask.mockResolvedValue(DISPATCH_SELECTION);
  mockStartRun.mockImplementation(() => fakeRun(Promise.resolve(agentResult({
    finalOutput: '', total_cost_usd: 0, num_turns: 1,
    rateLimited: true, rateLimitProvider: 'provider-a',
  }))));

  taskDispatchRunner({ channel: 'atlas', profileName: 'execute' } as any);
  await waitFor(() => activeCountDeltas(-1) === 1, 'dispatch cycle complete');
  await settleTails();

  // The paused thread streams nothing: handleRateLimitInterruption returns before
  // finalizeThread, so there is no finalOutput post and no seal — one update only.
  expectOps(adapter, [
    post('project-report', expect.stringMatching(
      /^🛰️ Dispatching: \[atlas\] Run the golden dispatch task\.\.\. \| cortex-[0-9a-f]{6} \| execute$/,
    )),
    update('⚠️ [atlas] Run the golden dispatch task | paused — rate limited, will auto-resume'),
  ]);
  expectStartRun([{ trigger: 'task-dispatch', threadId: expect.stringMatching(THREAD_ID) as any }]);

  const paused = threadStore.get(startRunThreadId())!;
  expect(paused.status).toBe('rate_limited');
  expect(paused.metadata?.statusMsgRef).toEqual({ conduit: 'atlas', messageId: '1000' });
  expect(busTypes()).toEqual([
    'system.notice', // throttle activation from this test's own setup
    'llm.active-count-delta', 'task.claimed', 'task.dispatched',
    'thread.created', 'thread.step.started', 'session.message',
    'llm.active-count-delta',
  ]);
  expect(busEvent('task.completed')).toBeUndefined();
});

// --- 9. scheduled fresh success ---------------------------------------------------------------

test('golden 9: scheduled fresh success — processing post, onProgress update, Done + registerSession', async () => {
  mockStartRun.mockImplementation((_request: any, observers: any[]) => {
    // A real run emits turn_progress; that is what drives the scheduler's onProgress updater.
    for (const observer of observers ?? []) observer.onEvent?.({ type: 'turn_progress', numTurns: 3 });
    return fakeRun(Promise.resolve(agentResult({ finalOutput: 'sched out', total_cost_usd: 0.05, num_turns: 6 })));
  });

  runScheduledTask({
    message: 'golden scheduled message', projectId: 'general',
    scheduleTaskId: 'sch-1', profileName: 'plan',
  } as any);
  await waitFor(() => activeCountDeltas(-1) === 1, 'scheduled task complete');
  await settleTails();

  expectOps(adapter, [
    post('project-report', expect.stringMatching(/^⏳ Processing \| cortex-[0-9a-f]{6} \| plan \| ⏱️ \d+s$/)),
    update(expect.stringMatching(/^⏳ Processing \| cortex-[0-9a-f]{6} \| plan \| ⏱️ \d+s \| 🔁 3 turns$/)),
    post('project-report', 'sched out'),
    update(expect.stringMatching(
      /^✅ Done \| cortex-[0-9a-f]{6} · `golden-backend` \| \(\d+s · 6 turns · \$0\.0500\)$/,
    )),
  ]);
  expectStartRun([{ trigger: 'scheduled', threadId: expect.stringMatching(THREAD_ID) as any }]);
  expect(threadStore.get(startRunThreadId())?.templateName).toBe('scheduler');
  expect(busTypes()).toEqual([
    'llm.active-count-delta',
    'thread.created', 'thread.step.started', 'session.message',
    'thread.step.finished', 'thread.completed',
    'llm.active-count-delta',
  ]);

  // finalizeThreadSuccess registers the run under the last real step's TRACK id.
  const sessionName = String(adapter.posted[0].content.text).split(' | ')[1];
  expect(sessionName).toMatch(SESSION_NAME);
  const registered = await sessionStore.lookupSession(sessionName);
  expect(registered).toMatchObject({
    channel: 'general', kind: 'scheduled', origin: 'scheduled',
    projectId: 'general', backendSessionId: 'golden-backend', scheduleId: 'sch-1',
  });
  expect(registered!.sessionId).toBe(threadStore.get(startRunThreadId())!.steps[0].sessionId);
});

// --- 10. scheduled throws ---------------------------------------------------------------------

test('golden 10: scheduled failure — Error update then a separate "Scheduled task error" post', async () => {
  mockStartRun.mockImplementation(() => fakeRun(Promise.reject(new Error('golden sched boom'))));

  runScheduledTask({
    message: 'golden scheduled message', projectId: 'general',
    scheduleTaskId: 'sch-2', profileName: 'plan',
  } as any);
  await waitFor(() => activeCountDeltas(-1) === 1, 'scheduled task complete');
  await settleTails();

  expectOps(adapter, [
    post('project-report', expect.stringMatching(/^⏳ Processing \| cortex-[0-9a-f]{6} \| plan \| ⏱️ \d+s$/)),
    update(expect.stringMatching(/^❌ cortex-[0-9a-f]{6} \| Error \(\d+s\)$/)),
    post('project-report', 'Scheduled task error: golden sched boom'),
  ]);
  expectStartRun([{ trigger: 'scheduled', threadId: expect.stringMatching(THREAD_ID) as any }]);
  expect(threadStore.get(startRunThreadId())?.status).toBe('failed');
  expect(busTypes()).toEqual([
    'llm.active-count-delta',
    'thread.created', 'thread.step.started', 'session.message',
    'thread.failed',
    'llm.active-count-delta',
  ]);
});
