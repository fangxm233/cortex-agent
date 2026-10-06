import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  dispatchPendingResumes,
  isAutoResumeEnabled,
  registerResumeWakeOnAgentSettle,
} from '../../src/orchestration/resume-dispatcher.js';
import { EventBus } from '../../src/events/index.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { SYNTHETIC_CALLBACK_SENDER } from '../../src/platform/index.js';
import type { ResumeEntry } from '../../src/domain/costs/resume-registry.js';
import { resetSettingsForTests } from '../../src/core/settings.js';
import { runRegistry } from '../../src/core/run-registry.js';

const NOW = 1_000_000_000_000;

function baseDeps(entries: ResumeEntry[], overrides: any = {}) {
  const calls = { route: [] as any[], taken: 0, active: [] as string[] };
  const deps = {
    takeReady: (active: string[]) => { calls.taken++; calls.active = active; return entries; },
    activeProviders: () => [],
    route: async (ctx: any) => { calls.route.push(ctx); },
    channelBusy: (_c: string) => false,
    acquireSessionUse: async (_sessionId: string) => () => {},
    delay: async (_ms: number) => {},
    ...overrides,
  };
  return { deps, calls };
}

test('isAutoResumeEnabled defaults true, false only for 0/false', async () => {
  const prev = process.env.CORTEX_AUTO_RESUME;
  delete process.env.CORTEX_AUTO_RESUME;
  resetSettingsForTests();
  assert.equal(isAutoResumeEnabled(), true);
  process.env.CORTEX_AUTO_RESUME = '0';
  resetSettingsForTests();
  assert.equal(isAutoResumeEnabled(), false);
  process.env.CORTEX_AUTO_RESUME = 'false';
  resetSettingsForTests();
  assert.equal(isAutoResumeEnabled(), false);
  process.env.CORTEX_AUTO_RESUME = '1';
  resetSettingsForTests();
  assert.equal(isAutoResumeEnabled(), true);
  if (prev === undefined) delete process.env.CORTEX_AUTO_RESUME; else process.env.CORTEX_AUTO_RESUME = prev;
  resetSettingsForTests();
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
  assert.equal(ctx.message.senderId, SYNTHETIC_CALLBACK_SENDER);
  // Tagged so the chat shows a one-line hint instead of putting the reminder in the user's mouth.
  assert.equal(ctx.message.systemOrigin, 'resume');
  assert.ok(ctx.message.text.includes('<system-reminder>'));
  assert.equal(ctx.message.ref.conduit, 'C1');
});

test('direct resume holds the stable session lease until route has enqueued the turn', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const order: string[] = [];
  const { deps } = baseDeps(
    [{ kind: 'direct', provider: 'provider-a', channel: 'C1', trackSessionId: 'track-1', userMessage: 'orig', recordedAt: NOW }],
    {
      acquireSessionUse: async (sessionId: string) => {
        order.push(`acquire:${sessionId}`);
        return () => { order.push('release'); };
      },
      route: async () => { order.push('route'); },
    },
  );

  await dispatchPendingResumes(adapter as any, deps);
  assert.deepEqual(order, ['acquire:track-1', 'route', 'release']);
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

test('old entry is still dispatched (no staleness cutoff)', async () => {
  // Regression: a fixed max-age cutoff (formerly 6h) silently dropped entries whose rate-limit
  // window legitimately exceeded it — e.g. a seven_day limit whose resetsAt is 8-9h out. Once the
  // window resets, the entry must be resumed regardless of how long it waited. Only the live-state
  // guard (a busy channel) may skip it.
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

/** Registers a background subagent child on `channel` the way a Claude child run does, and drops the
 *  stubbed busy checks so the dispatcher's real ones read the live registry. */
function withChildOnChannel(deps: any, channel: string): () => void {
  runRegistry.register({
    channel, executionId: null, registryKey: 'resume-child',
    kind: 'local', kill: () => true, backend: 'claude', trackSessionId: null, subagent: true,
  });
  delete deps.channelBusy;
  return () => runRegistry.remove('resume-child');
}

test('direct entry still resumes while only a background subagent of it is running', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps([
    { kind: 'direct', provider: 'provider-a', channel: 'C-sub', userMessage: 'orig', recordedAt: NOW },
  ]);
  const cleanup = withChildOnChannel(deps, 'C-sub');
  try {
    await dispatchPendingResumes(adapter as any, deps);
  } finally {
    cleanup();
  }
  assert.equal(calls.route.length, 1, 'a child is not the conversation, so the channel is idle');
});

test('disabled flag drains the queue without dispatching', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const prev = process.env.CORTEX_AUTO_RESUME;
  process.env.CORTEX_AUTO_RESUME = '0';
  resetSettingsForTests();
  const { deps, calls } = baseDeps([
    { kind: 'direct', channel: 'C1', userMessage: 'orig', recordedAt: NOW },
  ]);
  await dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.taken, 1, 'queue must be drained');
  assert.equal(calls.route.length, 0, 'no dispatch when disabled');
  if (prev === undefined) delete process.env.CORTEX_AUTO_RESUME; else process.env.CORTEX_AUTO_RESUME = prev;
  resetSettingsForTests();
});

test('readiness drain is invoked exactly once per dispatch', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const { deps, calls } = baseDeps([
    { kind: 'direct', channel: 'C1', userMessage: 'a', recordedAt: NOW },
  ]);
  await dispatchPendingResumes(adapter as any, deps);
  assert.equal(calls.taken, 1);
  assert.equal(calls.route.length, 1);
  assert.equal(calls.route[0].channel, 'C1');
});
