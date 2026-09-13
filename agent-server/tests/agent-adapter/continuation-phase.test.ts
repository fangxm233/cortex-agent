// input:  ContinuationPhase with its port, fake timers and scripted continuation results
// output: spec for the background phase: settle policy, phase events, merge, watchdog, interruption
// pos:    Engine-side run-lifecycle spec — one definition of when a run is over (plan W1.1)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { ContinuationPhase, mergeContinuation, type RunTimers } from '../../src/agent-adapter/continuation-phase.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';

/** Costs are floating-point sums; compare them as such. */
function closeTo(actual: number | null | undefined, expected: number, message?: string): void {
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9,
    message ?? `expected ${expected}, got ${String(actual)}`);
}

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: 's-1', total_cost_usd: 0.02, num_turns: 2,
    rateLimited: false, rateLimitMessage: null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false, finalOutput: null,
    ...overrides,
  };
}

/** A timer seam a test drives by hand, so no watchdog test waits 90 seconds. */
function fakeTimers() {
  const armed: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timers: RunTimers = {
    set(fn, ms) { const entry = { fn, ms, cleared: false }; armed.push(entry); return entry; },
    clear(handle) { (handle as { cleared: boolean }).cleared = true; },
  };
  return {
    timers, armed,
    /** Fire the newest armed (and not cleared) timer. */
    fire(): void {
      const live = armed.filter((entry) => !entry.cleared);
      const entry = live[live.length - 1];
      assert.ok(entry, 'no live timer armed');
      entry.cleared = true;
      entry.fn();
    },
    live(): { fn: () => void; ms: number; cleared: boolean }[] {
      return armed.filter((entry) => !entry.cleared);
    },
  };
}

function harness(mode: 'none' | 'hold' | 'inline' | 'completion-only', base: AgentResult, stopPromise?: Promise<unknown>) {
  const events: RunEvent[] = [];
  const clock = fakeTimers();
  const settled: { value?: AgentResult } = {};
  const rejected: { error?: Error } = {};
  let closed = 0;
  const phase = new ContinuationPhase(mode, {
    push: (event) => events.push(event),
    settle: (value) => { settled.value = value; },
    reject: (error) => { rejected.error = error; },
    close: () => { closed += 1; },
    timers: clock.timers,
    graceMs: 1000,
    maxWaitMs: 10_000,
    stopPromise,
  });
  return { phase, events, clock, settled, rejected, closedCount: () => closed };
}

test('none: settles at the foreground result and closes, whatever the counts say', () => {
  const base = result({ pendingBackgroundTasks: 3, undeliveredBackgroundTasks: 1 });
  const h = harness('none', base);
  h.phase.start(base);

  assert.equal(h.settled.value, base);
  assert.deepEqual(h.events.map((e) => e.type), ['phase']);
  assert.deepEqual(h.events[0], {
    type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0,
  });
  assert.equal(h.closedCount(), 1);
  assert.equal(h.clock.live().length, 0, 'no watchdog for a foreground-only run');
});

test('hold: settles at the foreground result but keeps streaming until the work is gone', () => {
  const base = result({ pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0 });
  const h = harness('hold', base);
  h.phase.start(base);

  // The caller's foreground await is released immediately; the stream stays open.
  assert.equal(h.settled.value, base);
  assert.equal(h.closedCount(), 0, 'the stream must stay open while a task runs');
  assert.deepEqual(h.events[0], {
    type: 'phase', phase: 'background', pendingBackground: 1, undeliveredBackground: 0,
  });
  assert.equal(h.clock.live()[0]?.ms, 10_000, 'a still-running task arms the max-wait cap');

  const sink = h.phase.sink();
  // A background turn opens: the cap stops (its length is unbounded) and the phase boundary is
  // reported again.
  sink.onTurnOpen?.();
  assert.equal(h.clock.live().length, 0, 'the wait is paused while the continuation turn runs');
  sink.onAssistantText('done: DONE', 'claude-opus-5');
  sink.onResult(result({
    pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0, total_cost_usd: 0.01, num_turns: 1,
  }));

  assert.deepEqual(h.events.map((e) => e.type), ['phase', 'phase', 'assistant_text', 'background_result', 'phase']);
  const text = h.events.find((e) => e.type === 'assistant_text');
  assert.deepEqual(text, { type: 'assistant_text', text: 'done: DONE', model: 'claude-opus-5', phase: 'background' });
  assert.deepEqual(h.events.at(-1), {
    type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0,
  });
  assert.equal(h.closedCount(), 1);
  // The merged tally, not the last turn's: cost and turns accumulate across continuations.
  closeTo(h.settled.value?.total_cost_usd, 0.03);
  assert.equal(h.settled.value?.num_turns, 3);
});

test('inline: the settle waits for the continuation and carries the merged result', () => {
  const base = result({ pendingBackgroundTasks: 1, total_cost_usd: 0.25, num_turns: 2 });
  const h = harness('inline', base);
  h.phase.start(base);

  assert.equal(h.settled.value, undefined, 'an inline caller awaits the whole phase');
  assert.equal(h.closedCount(), 0);

  const sink = h.phase.sink();
  sink.onTurnOpen?.();
  sink.onResult(result({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0, total_cost_usd: 0.01, num_turns: 1 }));

  closeTo(h.settled.value?.total_cost_usd, 0.26);
  assert.equal(h.settled.value?.num_turns, 3);
  assert.equal(h.closedCount(), 1);
  assert.deepEqual(h.events.map((e) => e.type), ['phase', 'phase', 'background_result', 'phase']);
});

test('grace watchdog: releases a finished-but-unnotified task and reports the timeout', () => {
  const base = result({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 });
  const h = harness('hold', base);
  h.phase.start(base);

  assert.equal(h.clock.live()[0]?.ms, 1000, 'unnotified work arms the grace window');
  h.clock.fire();

  assert.deepEqual(h.events.map((e) => e.type), ['phase', 'background_timeout', 'phase']);
  assert.equal(h.settled.value?.total_cost_usd, 0.02);
  assert.equal(h.closedCount(), 1);
});

test('max-wait cap: stops holding, but never finalizes the run', () => {
  const base = result({ pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0 });
  const h = harness('hold', base);
  h.phase.start(base);
  h.clock.fire();

  assert.deepEqual(h.events.map((e) => e.type), ['phase', 'background_timeout']);
  assert.equal(h.closedCount(), 0, 'a very late continuation must still land on this stream');
  assert.equal(h.clock.live().length, 0, 'the cap does not restart the clock');

  // The late continuation arrives after all.
  const sink = h.phase.sink();
  sink.onResult(result({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0 }));
  assert.equal(h.closedCount(), 1);
  assert.deepEqual(h.events.at(-1), {
    type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0,
  });
});

test('completion-only: no ambient cap, and the stop boundary rejects', async () => {
  let stop!: (error?: unknown) => void;
  const stopPromise = new Promise<unknown>((_resolve, reject) => { stop = reject; });
  const base = result({ pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0 });
  const h = harness('completion-only', base, stopPromise);
  h.phase.start(base);

  assert.equal(h.settled.value, undefined);
  assert.equal(h.clock.live().length, 0, 'caps are disabled: only the backend or the stop ends it');

  stop(new Error('killed'));
  await stopPromise.catch(() => undefined);
  await Promise.resolve();
  assert.equal(h.rejected.error?.message, 'killed');
  assert.deepEqual(h.events.map((e) => e.type), ['phase', 'error', 'phase']);
  assert.equal(h.closedCount(), 1);
});

test('a rate-limited continuation ends the phase at once', () => {
  const base = result({ pendingBackgroundTasks: 1 });
  const h = harness('hold', base);
  h.phase.start(base);
  h.phase.sink().onResult(result({ rateLimited: true, pendingBackgroundTasks: 0 }));

  assert.equal(h.settled.value?.rateLimited, true);
  assert.equal(h.closedCount(), 1);
});

test('a process that dies mid-continuation finalizes the accumulated work', () => {
  const base = result({ pendingBackgroundTasks: 1 });
  const h = harness('hold', base);
  h.phase.start(base);
  h.phase.sink().onResult(result({ backgroundInterrupted: true, pendingBackgroundTasks: 0 }));

  assert.equal(h.settled.value?.backgroundInterrupted, true);
  assert.equal(h.closedCount(), 1);
  const settledEvent = h.events.find((e) => e.type === 'background_result');
  assert.equal((settledEvent as { result?: AgentResult } | undefined)?.result?.backgroundInterrupted, true);
});

test('a continuation that finishes inside the foreground turn is not lost', () => {
  // A task can complete while the foreground turn is still running: the sink reports it before
  // `start()` has a base to merge into.
  const h = harness('inline', result({ pendingBackgroundTasks: 0, total_cost_usd: 0.1 }));
  h.phase.sink().onResult(result({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0, total_cost_usd: 0.05, num_turns: 1 }));
  h.phase.start(result({ pendingBackgroundTasks: 1, total_cost_usd: 0.1, num_turns: 1 }));

  closeTo(h.settled.value?.total_cost_usd, 0.15, 'the buffered continuation is merged');
  assert.equal(h.closedCount(), 1);
});

test('mergeContinuation sums cost and turns, and lets the latest output win', () => {
  const merged = mergeContinuation(
    result({ total_cost_usd: 0.1, num_turns: 3, finalOutput: 'first' }),
    result({ total_cost_usd: 0.2, num_turns: 2, finalOutput: 'second', pendingBackgroundTasks: 1 }),
  );
  closeTo(merged.total_cost_usd, 0.3);
  assert.equal(merged.num_turns, 5);
  assert.equal(merged.finalOutput, 'second');
  assert.equal(merged.pendingBackgroundTasks, 1);
  // Both null stays null: "unreported" must not become 0.
  assert.equal(mergeContinuation(result({ total_cost_usd: null }), result({ total_cost_usd: null })).total_cost_usd, null);
});
