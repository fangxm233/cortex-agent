// input:  resume dispatcher, ready entries, runtime settings
// output: dispatch, requeue, wake, and guard tests
// pos:    Covers provider-ready auto-resume behavior
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import '../_test-home.js'; // MUST be first — isolates store singletons
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  dispatchPendingResumes,
  buildResumeReminder,
  registerResumeWakeOnAgentSettle,
} from '../../src/orchestration/resume-dispatcher.js';
import { EventBus } from '../../src/events/index.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { ResumeEntry } from '../../src/domain/costs/resume-registry.js';

const NOW = 1_000_000_000_000;

async function freshResumeDispatcher() {
  vi.resetModules();
  return import('../../src/orchestration/resume-dispatcher.js');
}

function baseDeps(entries: ResumeEntry[], overrides: any = {}) {
  const calls = {
    route: [] as any[], resume: [] as any[], built: [] as any[], settled: [] as string[],
    requeued: [] as ResumeEntry[], taken: 0, active: [] as string[],
  };
  const deps = {
    takeReady: (active: string[]) => { calls.taken++; calls.active = active; return entries; },
    activeProviders: () => [],
    route: async (ctx: any) => { calls.route.push(ctx); },
    resumeThread: async (threadId: string, opts: any) => { calls.resume.push({ threadId, opts }); },
    settleResumedThread: async (threadId: string) => { calls.settled.push(threadId); },
    requeue: (entry: ResumeEntry) => { calls.requeued.push(entry); },
    buildResumeOptions: (thread: any) => {
      calls.built.push(thread);
      return { adapter: {}, channel: thread.channel, destination: { type: 'project-report', projectId: thread.projectId, trigger: 'rate-limit-resume', sessionId: '' }, threadAnchorId: null, statusMsg: null, startTime: 0 };
    },
    getThread: (_id: string) => ({ id: _id, status: 'rate_limited', channel: 'C1', projectId: 'proj' }) as any,
    channelBusy: (_c: string) => false,
    directSessionBusy: (_c: string) => false,
    now: () => NOW,
    delay: async (_ms: number) => {},
    ...overrides,
  };
  return { deps, calls };
}

test('isAutoResumeEnabled defaults true, false only for 0/false', async () => {
  const prev = process.env.CORTEX_AUTO_RESUME;
  delete process.env.CORTEX_AUTO_RESUME;
  assert.equal((await freshResumeDispatcher()).isAutoResumeEnabled(), true);
  process.env.CORTEX_AUTO_RESUME = '0';
  assert.equal((await freshResumeDispatcher()).isAutoResumeEnabled(), false);
  process.env.CORTEX_AUTO_RESUME = 'false';
  assert.equal((await freshResumeDispatcher()).isAutoResumeEnabled(), false);
  process.env.CORTEX_AUTO_RESUME = '1';
  assert.equal((await freshResumeDispatcher()).isAutoResumeEnabled(), true);
  if (prev === undefined) delete process.env.CORTEX_AUTO_RESUME; else process.env.CORTEX_AUTO_RESUME = prev;
});

test('buildResumeReminder is wrapped in a system-reminder', () => {
  const r = buildResumeReminder();
  assert.ok(r.startsWith('<system-reminder>'));
  assert.ok(r.trimEnd().endsWith('</system-reminder>'));
});

test('agent terminal events wake requeued resume work', async () => {
  const bus = new EventBus();
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  let wakes = 0;
  const stop = registerResumeWakeOnAgentSettle(bus, adapter, async () => { wakes++; });

  bus.publish({ type: 'agent.completed', executionId: 'exec-a', cost: 0, durationMs: 1 });
  bus.publish({ type: 'agent.failed', executionId: 'exec-b', error: 'failed' });
  bus.publish({ type: 'agent.superseded', executionId: 'exec-c', reason: 'cancelled' });
  await Promise.resolve();

  assert.equal(wakes, 3);
  stop();
  bus.publish({ type: 'agent.completed', executionId: 'exec-d', cost: 0, durationMs: 1 });
  assert.equal(wakes, 3);
});

test('direct entry routes a synthetic system-reminder message', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps([
    { kind: 'direct', provider: 'provider-a', channel: 'C1', userMessage: 'orig', recordedAt: NOW },
  ]);
  await dispatchPendingResumes(adapter as any, deps);

  assert.equal(calls.route.length, 1);
  const ctx = calls.route[0];
  assert.equal(ctx.channel, 'C1');
  assert.equal(ctx.threadAnchorId, null);
  assert.equal(ctx.hasFiles, false);
  assert.equal(ctx.message.kind, 'user');
  assert.equal(ctx.message.senderId, 'cortex-rate-limit-resume');
  assert.ok(ctx.message.text.includes('<system-reminder>'));
  assert.equal(ctx.message.ref.conduit, 'C1');
});

test('dispatcher asks the registry for entries ready against the active provider set', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps(
    [{ kind: 'direct', provider: 'provider-a', channel: 'C1', userMessage: 'orig', recordedAt: NOW }],
    { activeProviders: () => ['provider-b'] },
  );

  await dispatchPendingResumes(adapter as any, deps);

  assert.deepEqual(calls.active, ['provider-b']);
  assert.equal(calls.route.length, 1);
});

test('thread entry resumes a rate_limited thread with rebuilt options',  async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps([
    { kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 'go', recordedAt: NOW },
  ]);
  await dispatchPendingResumes(adapter as any, deps);

  assert.equal(calls.resume.length, 1);
  assert.equal(calls.resume[0].threadId, 'thr_a');
  assert.equal(calls.resume[0].opts.destination.type, 'project-report');
  assert.equal(calls.built.length, 1, 'options rebuilt from the thread record');
  // Threads re-run their interrupted step from the original prompt — no reminder injected.
  assert.equal(calls.route.length, 0);
});

test('resumed thread is settled after its run returns (status message sealed)', async () => {
  // Regression: the resumed run keeps updating the live status message mid-flight, but nothing
  // sealed it at the end, so the message froze at the last running step ("Step N … ⏳") even
  // though the thread finished. settleResumedThread must fire once per resumed thread, after resume.
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const order: string[] = [];
  const { deps, calls } = baseDeps(
    [{ kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 'go', recordedAt: NOW }],
    {
      resumeThread: async (threadId: string) => { order.push(`resume:${threadId}`); },
      settleResumedThread: async (threadId: string) => { order.push(`settle:${threadId}`); calls.settled.push(threadId); },
    },
  );
  await dispatchPendingResumes(adapter as any, deps);
  assert.deepEqual(calls.settled, ['thr_a'], 'settle fires exactly once for the resumed thread');
  assert.deepEqual(order, ['resume:thr_a', 'settle:thr_a'], 'settle runs only AFTER the resumed run returns');
});

test('a thread that is skipped by a guard is never settled', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps(
    [{ kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 'go', recordedAt: NOW }],
    { getThread: (_id: string) => ({ id: _id, status: 'completed', channel: 'C2', projectId: 'proj' }) as any },
  );
  await dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.resume.length, 0, 'guarded thread is not resumed');
  assert.equal(calls.settled.length, 0, 'guarded thread is not settled');
});

test('old entry is still dispatched (no staleness cutoff)', async () => {
  // Regression: a fixed max-age cutoff (formerly 6h) silently dropped entries whose rate-limit
  // window legitimately exceeded it — e.g. a seven_day limit whose resetsAt is 8-9h out. Once the
  // window resets, the entry must be resumed regardless of how long it waited. Only live-state
  // guards (busy channel, thread gone / no longer rate_limited) may skip it.
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const old = NOW - (30 * 60 * 60 * 1000); // 30h ago — would have been "stale" under the old cutoff
  const { deps, calls } = baseDeps([
    { kind: 'direct', channel: 'C1', userMessage: 'orig', recordedAt: old },
  ]);
  await dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.route.length, 1);
});

test('direct entry on a busy channel is dropped', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps(
    [{ kind: 'direct', channel: 'C1', userMessage: 'orig', recordedAt: NOW }],
    { channelBusy: (_c: string) => true },
  );
  await dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.route.length, 0);
});

test('thread entry is NOT skipped when only other threads hold the channel (channelBusy true, no direct session)', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps(
    [{ kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 'go', recordedAt: NOW }],
    { channelBusy: (_c: string) => true, directSessionBusy: (_c: string) => false },
  );
  await dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.resume.length, 1, 'thread resumes despite a concurrent thread on the channel');
});

test('thread entry is requeued while a live direct session holds the channel', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const entry: ResumeEntry = {
    kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 'go', recordedAt: NOW,
  };
  const { deps, calls } = baseDeps([entry], {
    directSessionBusy: (_c: string) => true,
  });

  await dispatchPendingResumes(adapter as any, deps);

  assert.equal(calls.resume.length, 0, 'thread avoids interleaving with an interactive turn');
  assert.deepEqual(calls.requeued, [entry], 'busy thread remains durable for the idle wake');
});

test('multiple rate-limited threads on the SAME channel all resume (no self-skip)', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps([
    { kind: 'thread', threadId: 'thr_a', channel: 'C1', userMessage: 'a', recordedAt: NOW },
    { kind: 'thread', threadId: 'thr_b', channel: 'C1', userMessage: 'b', recordedAt: NOW },
    { kind: 'thread', threadId: 'thr_c', channel: 'C1', userMessage: 'c', recordedAt: NOW },
  ]);
  await dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.resume.length, 3, 'all three threads on one channel resume concurrently');
  assert.deepEqual(calls.resume.map((r: any) => r.threadId).sort(), ['thr_a', 'thr_b', 'thr_c']);
});

test('thread entry dropped when thread no longer exists', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps(
    [{ kind: 'thread', threadId: 'gone', channel: 'C2', userMessage: 'go', recordedAt: NOW }],
    { getThread: (_id: string) => null },
  );
  await dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.resume.length, 0);
});

test('thread entry dropped when thread is no longer paused', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps(
    [{ kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 'go', recordedAt: NOW }],
    { getThread: (_id: string) => ({ id: _id, status: 'completed', channel: 'C2', projectId: 'proj' }) as any },
  );
  await dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.resume.length, 0);
});

test('disabled flag drains the queue without dispatching', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const prev = process.env.CORTEX_AUTO_RESUME;
  process.env.CORTEX_AUTO_RESUME = '0';
  const { deps, calls } = baseDeps([
    { kind: 'direct', channel: 'C1', userMessage: 'orig', recordedAt: NOW },
  ]);
  await (await freshResumeDispatcher()).dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.taken, 1, 'queue must be drained');
  assert.equal(calls.route.length, 0, 'no dispatch when disabled');
  if (prev === undefined) delete process.env.CORTEX_AUTO_RESUME; else process.env.CORTEX_AUTO_RESUME = prev;
});

// --- Busy-gate bracket (2026-07-09 regression) ---
// A rate-limit-resumed thread ran with NO trackPendingTask bracket, so the daemon's busy/idle
// gate saw count=0 while the thread was mid-stream; a .restart trigger then fired immediately
// and SIGKILLed app.ts, killing 3 streaming threads. The fire-and-forget thread resume must
// hold the busy gate (+1 sync at fire, -1 after run AND settle), mirroring runThreadDetached.

/** Flush the fire-and-forget resume promise chain (resume → settle → finally). */
const flushDetached = () => new Promise((r) => setImmediate(r));

test('thread resume holds the busy gate across the run AND the settle', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const order: string[] = [];
  const { deps } = baseDeps(
    [{ kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 'go', recordedAt: NOW }],
    {
      track: (d: number) => order.push(`track:${d}`),
      resumeThread: async (threadId: string) => { order.push(`resume:${threadId}`); },
      settleResumedThread: async (threadId: string) => { order.push(`settle:${threadId}`); },
    },
  );
  await dispatchPendingResumes(adapter as any, deps);
  await flushDetached();
  assert.deepEqual(order, ['track:1', 'resume:thr_a', 'settle:thr_a', 'track:-1'],
    '+1 fires synchronously before the run; -1 only after settle completes');
});

test('busy gate never leaks when the resumed run rejects', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const trackCalls: number[] = [];
  const { deps, calls } = baseDeps(
    [{ kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 'go', recordedAt: NOW }],
    {
      track: (d: number) => trackCalls.push(d),
      resumeThread: async () => { throw new Error('boom'); },
    },
  );
  await dispatchPendingResumes(adapter as any, deps);
  await flushDetached();
  assert.deepEqual(trackCalls, [1, -1], 'gate released exactly once despite the rejection');
  assert.equal(calls.settled.length, 0, 'settle skipped on failure (unchanged behavior)');
});

test('guard-skipped thread never touches the busy gate', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const trackCalls: number[] = [];
  const { deps } = baseDeps(
    [{ kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 'go', recordedAt: NOW }],
    {
      track: (d: number) => trackCalls.push(d),
      getThread: (_id: string) => ({ id: _id, status: 'completed', channel: 'C2', projectId: 'proj' }) as any,
    },
  );
  await dispatchPendingResumes(adapter as any, deps);
  await flushDetached();
  assert.deepEqual(trackCalls, [], 'no +1/-1 for a thread that was never resumed');
});

test('direct resume does NOT double-track (agentRunner brackets internally)', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const trackCalls: number[] = [];
  const { deps, calls } = baseDeps(
    [{ kind: 'direct', channel: 'C1', userMessage: 'orig', recordedAt: NOW }],
    { track: (d: number) => trackCalls.push(d) },
  );
  await dispatchPendingResumes(adapter as any, deps);
  await flushDetached();
  assert.equal(calls.route.length, 1);
  assert.deepEqual(trackCalls, [], 'direct path relies on agentRunner internal tracking');
});

test('multiple thread resumes hold and release the gate in balance', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  let count = 0; let peak = 0;
  const { deps } = baseDeps([
    { kind: 'thread', threadId: 'thr_a', channel: 'C1', userMessage: 'a', recordedAt: NOW },
    { kind: 'thread', threadId: 'thr_b', channel: 'C1', userMessage: 'b', recordedAt: NOW },
    { kind: 'thread', threadId: 'thr_c', channel: 'C1', userMessage: 'c', recordedAt: NOW },
  ], {
    track: (d: number) => { count += d; peak = Math.max(peak, count); },
  });
  await dispatchPendingResumes(adapter as any, deps);
  await flushDetached();
  assert.equal(count, 0, 'all +1s released');
  assert.ok(peak >= 1, 'gate was actually held');
});

test('readiness drain is invoked exactly once per dispatch', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps([
    { kind: 'direct', channel: 'C1', userMessage: 'a', recordedAt: NOW },
    { kind: 'thread', threadId: 'thr_b', channel: 'C2', userMessage: 'b', recordedAt: NOW },
  ]);
  await dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.taken, 1);
  assert.equal(calls.route.length, 1);
  assert.equal(calls.resume.length, 1);
});
