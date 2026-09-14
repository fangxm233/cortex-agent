import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { EventBus } from '../src/events/event-bus.js';
import { runRegistry } from '../src/core/run-registry.js';
import { busyTracker } from '../src/orchestration/busy-tracker.js';
import { ctx as jobCtx } from '../src/domain/scheduling/job-registry.js';
import { setSubagentTurnSender } from '../src/orchestration/subagent-delivery.js';
import {
  _resetAdoptedRuns, adoptForegroundRun, settleAdoptedRun,
} from '../src/orchestration/subagent-adopt.js';
import {
  _resetSubagentRuns, _sweepAbandonedForTest, detachSubagentRun, FOREGROUND_ABANDON_MS,
  getSubagentRun, startSubagentRun, stopSubagentRunsForSession, waitForSubagentRun,
  type StartSubagentRunOptions, type SubagentRunView,
} from '../src/domain/agents/subagent/registry.js';
import { emptyUsage } from '@core/agents/subagent/usage.js';
import type { SubagentToolResult } from '@core/agents/subagent/orchestrate.js';
import type { Invocation } from '@core/agents/subagent/types.js';

const SESSION = 'sess-adopt';
const CHANNEL = 'web:9';
/** Comfortably past the sweep's threshold, so no test depends on the exact boundary. */
const PAST_ABANDON_MS = FOREGROUND_ABANDON_MS + 1_000;

let bus: EventBus;
let delivered: Array<{ channel: string; text: string; systemOrigin?: string }>;
/** See the note in subagent-background.test.ts: the busy tracker's IPC frame kills a Vitest fork. */
let originalSend: typeof process.send;
let clock: number;

/** `Promise.withResolvers` is newer than this package's `lib` target. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function invocation(description = 'dig'): Invocation {
  return {
    mode: 'single',
    tasks: [{ description, prompt: 'p', subagent_type: 'general-purpose' }],
  };
}

function toolResult(text: string): SubagentToolResult {
  return {
    content: [{ type: 'text', text }],
    details: { mode: 'single', results: [], usage: emptyUsage() },
  };
}

function view(overrides: Partial<SubagentRunView> = {}): SubagentRunView {
  return {
    id: 'sa_x', status: 'running', background: false, mode: 'single',
    descriptions: ['dig'], sessionId: SESSION, startedAt: 0, endedAt: null, error: null,
    ...overrides,
  };
}

/**
 * A foreground run wired the way the webhook wires one. Never settles on its own unless the test
 * resolves the gate or aborts it, which is what makes it abandonable.
 */
function startForeground(overrides: Partial<StartSubagentRunOptions> = {}) {
  const gate = deferred<SubagentToolResult>();
  const run = startSubagentRun({
    invocation: invocation('long job'),
    sessionId: SESSION,
    background: false,
    onAbandon: abandoned => adoptForegroundRun(abandoned, CHANNEL),
    onSettled: (settled, result) => settleAdoptedRun(settled, result, CHANNEL),
    execute: (signal) => {
      signal.addEventListener('abort', () => gate.reject(new Error('aborted')), { once: true });
      return gate.promise;
    },
    ...overrides,
  });
  return { run, gate };
}

/** Age every run past the abandonment threshold and run the sweep, without waiting 75 real seconds. */
function sweepAfterAbandonWindow(): void {
  clock += PAST_ABANDON_MS;
  vi.setSystemTime(new Date(clock));
  _sweepAbandonedForTest();
}

beforeEach(() => {
  originalSend = process.send;
  (process as { send?: unknown }).send = undefined;
  // Date only: the registry reads the clock to decide who was abandoned, but its waits and the
  // promises under test must still run on real time.
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Date.now();
  vi.setSystemTime(new Date(clock));
  bus = new EventBus();
  jobCtx.bus = bus;
  busyTracker.setBus(bus);
  runRegistry.clear();
  _resetSubagentRuns();
  _resetAdoptedRuns();
  bus.subscribe('session.status', (event: any) => { runRegistry.onSessionStatus(event); });
  delivered = [];
  setSubagentTurnSender(opts => { delivered.push(opts); });
});

afterEach(() => {
  process.send = originalSend;
  vi.useRealTimers();
  setSubagentTurnSender(null);
  _resetSubagentRuns();
  _resetAdoptedRuns();
  runRegistry.clear();
  jobCtx.bus = null;
});

// --- the sweep ---

test('a foreground run nobody waited on is adopted into the background, not stopped', async () => {
  const before = busyTracker.count;
  const { run } = startForeground();

  sweepAfterAbandonWindow();

  const after = getSubagentRun(run.id)!;
  assert.equal(after.status, 'running', 'the work outlives the caller that walked away');
  assert.equal(after.background, true);
  assert.equal(busyTracker.count, before + 1, 'held, so a deferred restart cannot kill it');
  assert.ok(runRegistry.has(SESSION), 'the session is Stop-able again');
  // Through a wait, not a bare read: a stop only signals the abort and settles a tick later.
  assert.equal((await waitForSubagentRun(run.id, 25))!.view.status, 'running');
});

test('an adopted run is offered to the hook once — later sweeps skip it', () => {
  const before = busyTracker.count;
  let offers = 0;
  const { run } = startForeground({
    onAbandon: abandoned => { offers++; return adoptForegroundRun(abandoned, CHANNEL); },
  });
  sweepAfterAbandonWindow();
  sweepAfterAbandonWindow();
  assert.equal(offers, 1);
  assert.equal(busyTracker.count, before + 1, 'one hold, not two');
  assert.equal(getSubagentRun(run.id)!.background, true);
});

test('a run with nowhere to deliver is still stopped', async () => {
  // No channel: the answer would land nowhere, so burning tokens for it is the wrong trade.
  const { run } = startForeground({
    onAbandon: abandoned => adoptForegroundRun(abandoned, undefined),
  });
  sweepAfterAbandonWindow();
  assert.equal((await waitForSubagentRun(run.id, 1000))!.view.status, 'stopped');
  assert.equal(getSubagentRun(run.id)!.background, false);
});

test('a run with no session is still stopped', async () => {
  const { run } = startForeground({ sessionId: null });
  sweepAfterAbandonWindow();
  assert.equal((await waitForSubagentRun(run.id, 1000))!.view.status, 'stopped');
});

test('a run with no abandon hook keeps the old behaviour', async () => {
  const { run } = startForeground({ onAbandon: undefined });
  sweepAfterAbandonWindow();
  assert.equal((await waitForSubagentRun(run.id, 1000))!.view.status, 'stopped');
});

test('an abandon hook that throws is read as a refusal, not as an adoption', async () => {
  const { run } = startForeground({ onAbandon: () => { throw new Error('hook broke'); } });
  sweepAfterAbandonWindow();
  assert.equal((await waitForSubagentRun(run.id, 1000))!.view.status, 'stopped');
  assert.equal(getSubagentRun(run.id)!.background, false);
});

test('a foreground run whose caller is still polling is left alone', async () => {
  const { run } = startForeground();
  clock += PAST_ABANDON_MS;
  vi.setSystemTime(new Date(clock));
  await waitForSubagentRun(run.id, 1); // the caller checking in
  _sweepAbandonedForTest();
  assert.equal(getSubagentRun(run.id)!.background, false, 'not abandoned: someone just asked');
});

// --- settle ---

test('an adopted run releases its hold once and delivers its result once', async () => {
  const before = busyTracker.count;
  const { run, gate } = startForeground();
  sweepAfterAbandonWindow();
  assert.equal(busyTracker.count, before + 1);

  gate.resolve(toolResult('the findings'));
  await waitForSubagentRun(run.id, 1000);
  await vi.waitFor(() => assert.equal(busyTracker.count, before, 'hold released'));

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, CHANNEL);
  assert.equal(delivered[0].systemOrigin, 'agent-result');
  assert.match(delivered[0].text, new RegExp(`Background agent ${run.id} — long job`));
  assert.match(delivered[0].text, /the findings/);

  // A second settle — a stray hook call, or a Stop landing on a finished run — changes nothing.
  settleAdoptedRun(getSubagentRun(run.id)!, toolResult('again'), CHANNEL);
  assert.equal(delivered.length, 1);
  assert.equal(busyTracker.count, before);
});

test('a foreground run that was never adopted delivers nothing when it settles', async () => {
  const { run, gate } = startForeground();
  gate.resolve(toolResult('collected by the caller'));
  await waitForSubagentRun(run.id, 1000);
  assert.equal(delivered.length, 0, 'its caller already has the answer as a tool result');
});

test('a run that settles while its hold is being installed does not leave the hold standing', () => {
  const settling = view({ id: 'sa_race' });
  let releases = 0;
  // The window `startBackgroundSubagentRun` guards too: adoption is decided, the hold is not yet
  // installed, and the run ends in between. Reproduced by settling from inside the install, which
  // is the only moment the settle hook can find an adoption with no release to call.
  const adopted = adoptForegroundRun(settling, CHANNEL, {
    hold: (held, channel) => {
      settleAdoptedRun({ ...held, status: 'completed' }, toolResult('done'), channel);
      return () => { releases++; };
    },
  });
  assert.equal(adopted, true);
  assert.equal(releases, 1, 'the install, arriving second, performed the release');
  assert.equal(delivered.length, 1, 'delivered by whoever got there first');
  // And the adoption is gone, so a late second settle cannot deliver or release twice.
  settleAdoptedRun({ ...settling, status: 'completed' }, toolResult('done'), CHANNEL);
  assert.equal(delivered.length, 1);
  assert.equal(releases, 1);
});

test('adopting the same run twice takes one hold, not two', () => {
  const before = busyTracker.count;
  assert.equal(adoptForegroundRun(view({ id: 'sa_twice' }), CHANNEL), true);
  assert.equal(adoptForegroundRun(view({ id: 'sa_twice' }), CHANNEL), true);
  assert.equal(busyTracker.count, before + 1);
  settleAdoptedRun(view({ id: 'sa_twice', status: 'completed' }), toolResult('out'), CHANNEL);
  assert.equal(busyTracker.count, before);
});

test('settling a run that was never adopted is a no-op', () => {
  const before = busyTracker.count;
  settleAdoptedRun(view({ id: 'sa_unknown', status: 'completed' }), toolResult('out'), CHANNEL);
  assert.equal(delivered.length, 0);
  assert.equal(busyTracker.count, before);
});

// --- stopping an adopted run ---

test('agent_stop still reaches an adopted run, through the hold\'s Stop handle', async () => {
  const { run } = startForeground();
  sweepAfterAbandonWindow();
  assert.equal(runRegistry.stopHolds(SESSION), true);
  const outcome = await waitForSubagentRun(run.id, 1000);
  assert.equal(outcome!.view.status, 'stopped');
  await vi.waitFor(() => assert.match(delivered.at(-1)!.text, /Stopped before it finished/));
});

test('a user Stop still kills an adopted run — adoption covers absence, not refusal', async () => {
  const before = busyTracker.count;
  const { run } = startForeground();
  sweepAfterAbandonWindow();

  // The path `cancelSubagentRuns` takes. Adoption must not put a run out of its reach.
  assert.equal(stopSubagentRunsForSession(SESSION), 1);
  assert.equal((await waitForSubagentRun(run.id, 1000))!.view.status, 'stopped');
  await vi.waitFor(() => assert.equal(busyTracker.count, before, 'and the hold comes down with it'));
});

test('a user Stop still kills a foreground run that was never adopted', async () => {
  const { run } = startForeground();
  assert.equal(stopSubagentRunsForSession(SESSION), 1);
  assert.equal((await waitForSubagentRun(run.id, 1000))!.view.status, 'stopped');
});

// --- detach ---

test('detach adopts a foreground run on the spot, without waiting out the sweep', () => {
  const before = busyTracker.count;
  const { run } = startForeground();
  const detached = detachSubagentRun(run.id);
  assert.equal(detached!.background, true);
  assert.equal(detached!.status, 'running');
  assert.equal(busyTracker.count, before + 1);
  assert.ok(runRegistry.has(SESSION));
});

test('detach is idempotent, and answers null only for a run that does not exist', () => {
  const { run } = startForeground();
  detachSubagentRun(run.id);
  const before = busyTracker.count;
  assert.equal(detachSubagentRun(run.id)!.background, true, 'already background: reported as-is');
  assert.equal(busyTracker.count, before, 'and no second hold');
  assert.equal(detachSubagentRun('sa_ghost'), null);
});

test('detach on a run that cannot be delivered leaves it in the foreground for the sweep', () => {
  const { run } = startForeground({
    onAbandon: abandoned => adoptForegroundRun(abandoned, undefined),
  });
  assert.equal(detachSubagentRun(run.id)!.background, false);
});

test('the webhook\'s detach action reports the run the same way stop does', async () => {
  const { handleSubagentWebhook } = await import('../src/orchestration/subagent-webhook.js');
  const { run } = startForeground();

  const reply = await handleSubagentWebhook({ action: 'detach', runId: run.id });
  assert.deepEqual(reply, { success: true, data: { id: run.id, status: 'running' } });
  assert.equal(getSubagentRun(run.id)!.background, true);

  const missing = await handleSubagentWebhook({ action: 'detach', runId: 'sa_ghost' });
  assert.equal(missing.success, false);
  assert.match(missing.error!, /no such agent run: sa_ghost/);
});
