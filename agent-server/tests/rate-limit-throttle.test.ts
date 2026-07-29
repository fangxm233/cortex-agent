// input:  Vitest timers, provider events, persistence
// output: provider windows, outage gates, and callbacks
// pos:    Covers provider-scoped throttle and outage state
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { importFresh } from './module-loader.js';
import { MockAdapter } from '../src/platform/testing.js';

function makePersistenceStub(initial: any = null) {
  let savedState: any = initial;
  return {
    saved: savedState,
    save(state: any) { savedState = state; return Promise.resolve(); },
    load() { return Promise.resolve(savedState); },
    /** Test helper: get raw saved state */
    getSaved() { return savedState; },
    /** Test helper: set state for next load() call */
    setSaved(state: any) { savedState = state; },
  };
}

function makeAdapterStub() {
  return new MockAdapter({ adminChannel: 'mock-admin' });
}

async function freshModule() {
  return await importFresh('./../src/domain/costs/rate-limit-throttle.js') as typeof import('../src/domain/costs/rate-limit-throttle.js');
}

// Production module owns a 5-min setTimeout (`_resumeTimer`). If a test asserts
// before reaching its trailing `_testReset()`, the timer leaks and Node's event
// loop refuses to drain — `npm test` hangs. Register reset via `t.after()` so
// it runs even when assertions throw.
async function freshModuleWithCleanup(t: { onTestFinished: (fn: () => unknown) => void }) {
  const mod = await freshModule();
  t.onTestFinished(() => mod._testReset());
  // vitest does not auto-restore fake timers; no-op when a test never faked them.
  t.onTestFinished(() => vi.useRealTimers());
  return mod;
}

test('handleRateLimitEvent is no-op before init', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.99, resetsAt: Math.floor(Date.now() / 1000) + 300 });
  assert.equal(mod.isThrottled(), false);
});

test('activates on seven_day with utilization ≥ 0.95', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);
  await mod.handleRateLimitEvent({ rateLimitType: 'seven_day', utilization: 0.96, resetsAt: Math.floor(Date.now() / 1000) + 300 });
  assert.equal(mod.isThrottled(), true);
  const state = mod.getThrottleState();
  assert.ok(state.rateLimitedTypes.includes('seven_day'));
  assert.ok(adapter.posted[0].content.text.includes('[seven_day]'));
});

test('ignores seven_day below threshold (0.94)', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);
  await mod.handleRateLimitEvent({ rateLimitType: 'seven_day', utilization: 0.94, resetsAt: Math.floor(Date.now() / 1000) + 300 });
  assert.equal(mod.isThrottled(), false);
});

test('activates on seven_day_overage_included with utilization ≥ 0.95', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);
  await mod.handleRateLimitEvent({ rateLimitType: 'seven_day_overage_included', utilization: 0.96, resetsAt: Math.floor(Date.now() / 1000) + 300 });
  assert.equal(mod.isThrottled(), true);
  const state = mod.getThrottleState();
  assert.ok(state.rateLimitedTypes.includes('seven_day_overage_included'));
});

test('activates on seven_day at exactly 0.95 (boundary)', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);
  await mod.handleRateLimitEvent({ rateLimitType: 'seven_day', utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 300 });
  assert.equal(mod.isThrottled(), true);
});

test('unknown rateLimitType falls back to default threshold 0.90', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);
  await mod.handleRateLimitEvent({ rateLimitType: 'unknown_type', utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 300 });
  assert.equal(mod.isThrottled(), true);
});

test('five_hour at 0.89 still ignored (below 0.90 threshold)', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.89, resetsAt: Math.floor(Date.now() / 1000) + 300 });
  assert.equal(mod.isThrottled(), false);
});

test('ignores utilization below threshold', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.89, resetsAt: Math.floor(Date.now() / 1000) + 300 });
  assert.equal(mod.isThrottled(), false);
});

test('ignores events without resetsAt', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.99 });
  assert.equal(mod.isThrottled(), false);
});

test('activates throttle and persists state', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);

  const resetSec = Math.floor(Date.now() / 1000) + 300;
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.96, resetsAt: resetSec });

  assert.equal(mod.isThrottled(), true);
  assert.equal(adapter.posted.length, 1);
  assert.ok(adapter.posted[0].content.text.includes('throttle activated'));

  const state = mod.getThrottleState();
  assert.equal(state.resetsAt, resetSec);
  assert.deepEqual(state.rateLimitedModes, []);

  // Verify persistence saved the state
  const saved = persistence.getSaved();
  assert.ok(saved);
  assert.equal(saved.providers[0].windows[0].resetsAt, resetSec);
  assert.deepEqual(saved.providers[0].modes, []);
  assert.deepEqual(saved.providers[0].windows.map((w: any) => w.type), ['five_hour']);
});

test('extends timer on later resetsAt while already throttled', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);

  const baseReset = Math.floor(Date.now() / 1000) + 300;
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.95, resetsAt: baseReset });
  assert.equal(mod.isThrottled(), true);

  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.97, resetsAt: baseReset + 600 });
  assert.equal(mod.isThrottled(), true);
  assert.equal(mod.getThrottleState().resetsAt, baseReset + 600);

  // Persisted provider window updated
  const saved = persistence.getSaved();
  assert.ok(saved);
  assert.equal(saved.providers[0].windows[0].resetsAt, baseReset + 600);
});

test('does not extend timer on earlier resetsAt', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);

  const baseReset = Math.floor(Date.now() / 1000) + 600;
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.95, resetsAt: baseReset });

  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.96, resetsAt: baseReset - 300 });
  assert.equal(mod.getThrottleState().resetsAt, baseReset);
});

test('initRateLimitThrottle recovers expired throttle on restart', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub({ resetsAt: Math.floor(Date.now() / 1000) - 600, activatedAt: Date.now() - 3600000, modes: ['plan'] });
  const adapter = makeAdapterStub();

  await mod.initRateLimitThrottle(adapter, persistence as any);

  // Throttle metadata cleared
  assert.equal(persistence.getSaved(), null);
  assert.equal(mod.isThrottled(), false);
});

test('initRateLimitThrottle recovers active throttle on restart', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const futureReset = Math.floor(Date.now() / 1000) + 600;
  const persistence = makePersistenceStub({ resetsAt: futureReset, activatedAt: Date.now() - 60000, modes: ['plan', 'api'] });
  const adapter = makeAdapterStub();

  await mod.initRateLimitThrottle(adapter, persistence as any);

  // Throttle should be restored with modes
  assert.equal(mod.isThrottled(), true);
  assert.equal(mod.getThrottleState().resetsAt, futureReset);
  assert.deepEqual(mod.getThrottleState().rateLimitedModes.sort(), ['api', 'plan']);
  assert.ok(mod.isModeRateLimited('plan'));
  assert.ok(mod.isModeRateLimited('api'));
});

test('tracks mode on handleRateLimitEvent', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);

  const resetSec = Math.floor(Date.now() / 1000) + 300;
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.95, resetsAt: resetSec }, 'plan');

  assert.equal(mod.isThrottled(), true);
  assert.ok(mod.isModeRateLimited('plan'));
  assert.equal(mod.isModeRateLimited('api'), false);
  assert.ok(mod.isModeRateLimited('plan'));
});

test('adds new mode on extended throttle', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);

  const baseReset = Math.floor(Date.now() / 1000) + 300;
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.95, resetsAt: baseReset }, 'plan');
  assert.ok(mod.isModeRateLimited('plan'));

  // Extension with a different mode
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.97, resetsAt: baseReset + 600 }, 'execute');
  assert.ok(mod.isModeRateLimited('execute'));

  // Both modes tracked
  assert.ok(mod.isModeRateLimited('plan'));
  assert.ok(mod.isModeRateLimited('execute'));

  // Persistence includes both provider/mode records
  const saved = persistence.getSaved();
  assert.deepEqual(saved.providers.flatMap((p: any) => p.modes).sort(), ['execute', 'plan']);
});

test('isModeRateLimited returns false when not throttled', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);

  assert.equal(mod.isThrottled(), false);
  assert.equal(mod.isModeRateLimited('plan'), false);
  assert.equal(mod.isModeRateLimited('api'), false);
});

test('handleRateLimitEvent without mode activates throttle but no mode tracking', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);

  const resetSec = Math.floor(Date.now() / 1000) + 300;
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.95, resetsAt: resetSec });

  assert.equal(mod.isThrottled(), true);
  // No mode was tracked
  assert.deepEqual(mod.getThrottleState().rateLimitedModes, []);
  assert.equal(mod.isModeRateLimited('anything'), false);
});

test('onResume fires once when the resume timer clears the throttle', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  let resumeCount = 0;
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any, () => { resumeCount++; });

  const resetSec = Math.floor(Date.now() / 1000) + 1;
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.96, resetsAt: resetSec });
  assert.equal(mod.isThrottled(), true);
  assert.equal(resumeCount, 0);

  // Advance past resetsAt + RESUME_BUFFER_MS so the resume timer fires.
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(resumeCount, 1);
  assert.equal(mod.isThrottled(), false);
});

test('onResume fires when an expired throttle is recovered on restart', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  let resumeCount = 0;
  const persistence = makePersistenceStub({ resetsAt: Math.floor(Date.now() / 1000) - 600, activatedAt: Date.now() - 3600000, modes: ['plan'] });
  const adapter = makeAdapterStub();

  await mod.initRateLimitThrottle(adapter, persistence as any, () => { resumeCount++; });

  assert.equal(mod.isThrottled(), false);
  assert.equal(resumeCount, 1);
});

test('onResume does NOT fire immediately when an active throttle is recovered', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  let resumeCount = 0;
  const futureReset = Math.floor(Date.now() / 1000) + 600;
  const persistence = makePersistenceStub({ resetsAt: futureReset, activatedAt: Date.now() - 60000, modes: ['plan'] });
  const adapter = makeAdapterStub();

  await mod.initRateLimitThrottle(adapter, persistence as any, () => { resumeCount++; });

  assert.equal(mod.isThrottled(), true);
  assert.equal(resumeCount, 0);
});

test('initRateLimitThrottle is backward-compatible without onResume', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);

  const resetSec = Math.floor(Date.now() / 1000) + 1;
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.96, resetsAt: resetSec });
  assert.equal(mod.isThrottled(), true);

  // Timer clearing without an onResume callback must not throw.
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(mod.isThrottled(), false);
});

test('persistence roundtrip with modes', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);

  // Activate with modes
  const resetSec = Math.floor(Date.now() / 1000) + 300;
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.95, resetsAt: resetSec }, 'plan');
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.97, resetsAt: resetSec + 600 }, 'api');

  const saved1 = persistence.getSaved();
  assert.deepEqual(saved1.providers.flatMap((p: any) => p.modes).sort(), ['api', 'plan']);
  assert.deepEqual([...new Set(saved1.providers.flatMap((p: any) => p.windows.map((w: any) => w.type)))], ['five_hour']);
  assert.equal(Math.max(...saved1.providers.flatMap((p: any) => p.windows.map((w: any) => w.resetsAt))), resetSec + 600);

  // Create a fresh module and test recovery from persisted state
  const mod2 = await freshModuleWithCleanup(t);
  const persistence2 = makePersistenceStub(persistence.getSaved());
  const adapter2 = makeAdapterStub();
  await mod2.initRateLimitThrottle(adapter2, persistence2 as any);

  assert.equal(mod2.isThrottled(), true);
  assert.equal(mod2.getThrottleState().resetsAt, resetSec + 600);
  assert.deepEqual(mod2.getThrottleState().rateLimitedModes.sort(), ['api', 'plan']);
  assert.deepEqual(mod2.getThrottleState().rateLimitedTypes.sort(), ['five_hour']);
  assert.ok(mod2.isModeRateLimited('plan'));
  assert.ok(mod2.isModeRateLimited('api'));
});

test('cross-type extension: seven_day extends five_hour resetsAt', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  await mod.initRateLimitThrottle(adapter, persistence as any);

  const fiveHourReset = Math.floor(Date.now() / 1000) + 300;
  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.95, resetsAt: fiveHourReset });
  assert.equal(mod.isThrottled(), true);

  // seven_day with later resetsAt should extend and track both types
  const sevenDayReset = fiveHourReset + 3600;
  await mod.handleRateLimitEvent({ rateLimitType: 'seven_day', utilization: 0.99, resetsAt: sevenDayReset });
  assert.equal(mod.getThrottleState().resetsAt, sevenDayReset);
  assert.deepEqual(mod.getThrottleState().rateLimitedTypes.sort(), ['five_hour', 'seven_day']);
});

test('tracks two providers with independent windows and persists provider records', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  await mod.initRateLimitThrottle(makeAdapterStub(), persistence as any);
  const now = Math.floor(Date.now() / 1000);

  await mod.handleRateLimitEvent(
    { rateLimitType: 'seven_day', utilization: 0.97, resetsAt: now + 600 },
    { provider: 'anthropic', displayName: 'Anthropic', mode: 'plan' } as any,
  );
  await mod.handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.96, resetsAt: now + 120 },
    { provider: 'openai-codex', displayName: 'OpenAI', mode: 'subscription' } as any,
  );

  const state = mod.getThrottleState() as any;
  assert.deepEqual(state.providers.map((p: any) => p.provider).sort(), ['anthropic', 'openai-codex']);
  assert.equal(state.providers.find((p: any) => p.provider === 'anthropic').windows[0].resetsAt, now + 600);
  assert.equal(state.providers.find((p: any) => p.provider === 'openai-codex').windows[0].resetsAt, now + 120);
  assert.ok(mod.isModeRateLimited('plan'));
  assert.ok(mod.isModeRateLimited('subscription'));
  assert.equal(persistence.getSaved().providers.length, 2);
});

test('expires providers independently and reports each provider as soon as it clears', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-07-27T20:00:00.000Z'));
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const cleared: string[][] = [];
  let changes = 0;
  await mod.initRateLimitThrottle(
    makeAdapterStub(),
    persistence as any,
    (providers: string[]) => { cleared.push(providers); },
    () => { changes++; },
  );
  const now = Math.floor(Date.now() / 1000);

  await mod.handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: now + 1 },
    { provider: 'provider-a', displayName: 'Provider A', mode: 'shared' } as any,
  );
  await mod.handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: now + 60 },
    { provider: 'provider-b', displayName: 'Provider B', mode: 'shared' } as any,
  );

  await vi.advanceTimersByTimeAsync(7_000);
  const midway = mod.getThrottleState() as any;
  assert.deepEqual(midway.providers.map((p: any) => p.provider), ['provider-b']);
  assert.equal(mod.isProviderModeRateLimited('provider-a', 'shared'), false);
  assert.equal(mod.isProviderModeRateLimited('provider-b', 'shared'), true);
  assert.deepEqual(cleared, [['provider-a']]);

  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal((mod.getThrottleState() as any).providers.length, 0);
  assert.deepEqual(cleared, [['provider-a'], ['provider-b']]);
  assert.ok(changes >= 4, 'activation + each provider expiry should publish changes');
});

test('does not report a provider ready until all of its window types clear', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-07-27T21:00:00.000Z'));
  const mod = await freshModuleWithCleanup(t);
  const cleared: string[][] = [];
  await mod.initRateLimitThrottle(
    makeAdapterStub(),
    makePersistenceStub() as any,
    (providers: string[]) => { cleared.push(providers); },
  );
  const now = Math.floor(Date.now() / 1000);
  const source = { provider: 'provider-a', displayName: 'Provider A', mode: 'shared' } as any;

  await mod.handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: now + 1 },
    source,
  );
  await mod.handleRateLimitEvent(
    { rateLimitType: 'seven_day', utilization: 0.99, resetsAt: now + 60 },
    source,
  );

  await vi.advanceTimersByTimeAsync(7_000);
  assert.deepEqual(cleared, []);
  assert.equal((mod.getThrottleState() as any).providers[0].windows.length, 1);

  await vi.advanceTimersByTimeAsync(60_000);
  assert.deepEqual(cleared, [['provider-a']]);
});

test('provider-aware mode gates do not collide when providers share a mode name', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  await mod.initRateLimitThrottle(makeAdapterStub(), makePersistenceStub() as any);
  const reset = Math.floor(Date.now() / 1000) + 300;

  await mod.handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: reset },
    { provider: 'provider-a', displayName: 'Provider A', mode: 'shared' } as any,
  );

  assert.equal(mod.isProviderModeRateLimited('provider-a', 'shared'), true);
  assert.equal(mod.isProviderModeRateLimited('provider-b', 'shared'), false);
  assert.equal(mod.isProviderModeRateLimited('provider-a', 'other'), false);
});

test('groups multiple active window types under one provider', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  await mod.initRateLimitThrottle(makeAdapterStub(), persistence as any);
  const now = Math.floor(Date.now() / 1000);
  const source = { provider: 'anthropic', displayName: 'Anthropic', mode: 'plan' } as any;

  await mod.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.91, resetsAt: now + 300 }, source);
  await mod.handleRateLimitEvent({ rateLimitType: 'seven_day', utilization: 0.96, resetsAt: now + 900 }, source);

  const provider = (mod.getThrottleState() as any).providers[0];
  assert.equal(provider.provider, 'anthropic');
  assert.deepEqual(provider.modes, ['plan']);
  assert.deepEqual(provider.windows.map((w: any) => w.type).sort(), ['five_hour', 'seven_day']);
  assert.equal(mod.getThrottleState().resetsAt, now + 900);
});

test('legacy persisted throttle recovers as an Anthropic provider record', async (t) => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const persistence = makePersistenceStub({
    resetsAt: reset,
    activatedAt: Date.now() - 1_000,
    modes: ['plan'],
    types: ['seven_day'],
  });
  const mod = await freshModuleWithCleanup(t);
  await mod.initRateLimitThrottle(makeAdapterStub(), persistence as any);

  const provider = (mod.getThrottleState() as any).providers[0];
  assert.equal(provider.provider, 'anthropic');
  assert.equal(provider.displayName, 'Anthropic');
  assert.deepEqual(provider.modes, ['plan']);
  assert.deepEqual(provider.windows.map((w: any) => w.type), ['seven_day']);
  assert.equal(provider.windows[0].resetsAt, reset);
});

function assertOutageActivation(mod: any, persistence: any, adapter: MockAdapter): void {
  const provider = mod.getThrottleState().providers[0];
  assert.equal(provider.provider, 'provider-a');
  assert.deepEqual(provider.modes, []);
  assert.equal(provider.windows[0].type, 'outage');
  assert.equal(provider.windows[0].utilization, null);
  assert.equal(provider.windows[0].resetsAt * 1000, Date.now() + 5 * 60_000);
  assert.equal(mod.isProviderModeRateLimited('provider-a', 'api'), true);
  assert.equal(mod.isProviderModeRateLimited('provider-a', 'subscription'), true);
  assert.equal(mod.isProviderModeRateLimited('provider-b', 'api'), false);
  assert.equal(persistence.getSaved().providers[0].windows[0].type, 'outage');
  assert.match(adapter.posted[0].content.text, /provider outage/i);
  assert.doesNotMatch(adapter.posted[0].content.text, /utilization/i);
}

test('synthetic outage is provider-wide, persisted, distinct, and expires on schedule', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  const adapter = makeAdapterStub();
  const cleared: string[][] = [];
  await mod.initRateLimitThrottle(
    adapter, persistence as any,
    (providers: string[]) => { cleared.push(providers); },
  );

  await mod.activateOutageWindow('provider-a', 5 * 60_000);
  assertOutageActivation(mod, persistence, adapter);
  await vi.advanceTimersByTimeAsync(5 * 60_000);

  assert.deepEqual(cleared, [['provider-a']]);
  assert.equal(mod.getThrottleState().providers.length, 0);
  assert.equal(persistence.getSaved(), null);
  assert.match(adapter.posted.at(-1)!.content.text, /provider outage.*cleared/i);
});

test('nullable outage provider uses the legacy all-providers fallback', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-07-29T11:00:00.000Z'));
  const mod = await freshModuleWithCleanup(t);
  const cleared: string[][] = [];
  await mod.initRateLimitThrottle(
    makeAdapterStub(),
    makePersistenceStub() as any,
    (providers: string[]) => { cleared.push(providers); },
  );

  await mod.activateOutageWindow(null, 60_000);

  assert.equal(mod.getThrottleState().providers[0].provider, 'unknown');
  assert.equal(mod.isProviderRateLimited(null), true);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.deepEqual(cleared, [['unknown']]);
  assert.equal(mod.isProviderRateLimited(null), false);
});
