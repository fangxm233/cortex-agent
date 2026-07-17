// input:  Node test runner + orchestration/bg-wait-guard (injectable timers/track)
// output: BgWaitGuard spec — busy bracket (F1), grace watchdog (F5), max-wait cap (F6)
// pos:    CC background-task waiting-window guard unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { startBgWaitGuard, getBgGraceMs, getBgMaxWaitMs } from '../../src/orchestration/bg-wait-guard.js';

function fakeTimers() {
  const armed: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    armed,
    timers: {
      set: (fn: () => void, ms: number) => { const h = { fn, ms, cleared: false }; armed.push(h); return h; },
      clear: (h: any) => { if (h) h.cleared = true; },
    },
    /** Live (not-cleared) timers. */
    live: () => armed.filter((h) => !h.cleared),
    fire: (h: { fn: () => void }) => h.fn(),
  };
}

function trackRecorder() {
  const deltas: number[] = [];
  return { deltas, track: (d: number) => deltas.push(d), sum: () => deltas.reduce((a, b) => a + b, 0) };
}

const noop = () => {};

test('bg-wait-guard: start takes the busy bracket (+1); settle releases exactly once (-1)', () => {
  const ft = fakeTimers();
  const tr = trackRecorder();
  const g = startBgWaitGuard({ running: 1, undelivered: 0, track: tr.track, onGraceTimeout: noop, onMaxWait: noop, graceMs: 1000, maxWaitMs: 5000, timers: ft.timers });
  assert.deepEqual(tr.deltas, [1], 'bracket taken synchronously at start');
  g.settle();
  assert.deepEqual(tr.deltas, [1, -1], 'released on settle');
  g.settle();
  assert.deepEqual(tr.deltas, [1, -1], 'double settle does not double-release');
  assert.equal(g.settled, true);
  assert.equal(ft.live().length, 0, 'timers cleared on settle');
});

test('bg-wait-guard: running > 0 arms the max-wait cap; firing calls onMaxWait and settles', () => {
  const ft = fakeTimers();
  const tr = trackRecorder();
  let capped = 0;
  const g = startBgWaitGuard({ running: 2, undelivered: 0, track: tr.track, onGraceTimeout: noop, onMaxWait: () => { capped++; }, graceMs: 1000, maxWaitMs: 5000, timers: ft.timers });
  assert.equal(ft.live().length, 1, 'one timer armed');
  assert.equal(ft.live()[0].ms, 5000, 'armed with maxWaitMs');
  ft.fire(ft.live()[0]);
  assert.equal(capped, 1, 'onMaxWait fired');
  assert.equal(g.settled, true, 'guard settled after cap');
  assert.equal(tr.sum(), 0, 'bracket balanced');
});

test('bg-wait-guard: undelivered-only arms the grace watchdog; firing calls onGraceTimeout and settles', () => {
  const ft = fakeTimers();
  const tr = trackRecorder();
  let graced = 0;
  const g = startBgWaitGuard({ running: 0, undelivered: 1, track: tr.track, onGraceTimeout: () => { graced++; }, onMaxWait: noop, graceMs: 1000, maxWaitMs: 5000, timers: ft.timers });
  assert.equal(ft.live().length, 1);
  assert.equal(ft.live()[0].ms, 1000, 'armed with graceMs');
  ft.fire(ft.live()[0]);
  assert.equal(graced, 1, 'onGraceTimeout fired');
  assert.equal(g.settled, true);
  assert.equal(tr.sum(), 0);
});

test('bg-wait-guard: rearm switches cap → grace when running drains to undelivered-only', () => {
  const ft = fakeTimers();
  const tr = trackRecorder();
  let graced = 0;
  let capped = 0;
  const g = startBgWaitGuard({ running: 1, undelivered: 0, track: tr.track, onGraceTimeout: () => { graced++; }, onMaxWait: () => { capped++; }, graceMs: 1000, maxWaitMs: 5000, timers: ft.timers });
  g.rearm(0, 1);
  const live = ft.live();
  assert.equal(live.length, 1, 'old cap timer cleared, one live timer');
  assert.equal(live[0].ms, 1000, 'now the grace watchdog');
  ft.fire(live[0]);
  assert.equal(graced, 1);
  assert.equal(capped, 0);
  assert.equal(tr.sum(), 0, 'bracket balanced through rearm + fire');
  assert.equal(g.settled, true);
});

test('bg-wait-guard: rearm(0, 0) settles immediately (nothing left to wait for)', () => {
  const ft = fakeTimers();
  const tr = trackRecorder();
  const g = startBgWaitGuard({ running: 1, undelivered: 0, track: tr.track, onGraceTimeout: noop, onMaxWait: noop, graceMs: 1000, maxWaitMs: 5000, timers: ft.timers });
  g.rearm(0, 0);
  assert.equal(g.settled, true);
  assert.equal(tr.sum(), 0);
  assert.equal(ft.live().length, 0);
});

test('bg-wait-guard: rearm after settle is a no-op (no timer resurrection, no double bracket)', () => {
  const ft = fakeTimers();
  const tr = trackRecorder();
  const g = startBgWaitGuard({ running: 1, undelivered: 0, track: tr.track, onGraceTimeout: noop, onMaxWait: noop, graceMs: 1000, maxWaitMs: 5000, timers: ft.timers });
  g.settle();
  g.rearm(3, 2);
  assert.equal(ft.live().length, 0, 'no timers armed after settle');
  assert.deepEqual(tr.deltas, [1, -1]);
});

test('bg-wait-guard: env-tunable durations with sane defaults', () => {
  const prevGrace = process.env.CORTEX_BG_GRACE_S;
  const prevMax = process.env.CORTEX_BG_WAIT_MAX_S;
  try {
    delete process.env.CORTEX_BG_GRACE_S;
    delete process.env.CORTEX_BG_WAIT_MAX_S;
    assert.equal(getBgGraceMs(), 90_000, 'grace default 90s (> observed 24s updated→notification gap)');
    assert.equal(getBgMaxWaitMs(), 1_800_000, 'max-wait default 30min');
    process.env.CORTEX_BG_GRACE_S = '5';
    process.env.CORTEX_BG_WAIT_MAX_S = '60';
    assert.equal(getBgGraceMs(), 5_000);
    assert.equal(getBgMaxWaitMs(), 60_000);
    process.env.CORTEX_BG_GRACE_S = 'not-a-number';
    process.env.CORTEX_BG_WAIT_MAX_S = '-3';
    assert.equal(getBgGraceMs(), 90_000, 'invalid → default');
    assert.equal(getBgMaxWaitMs(), 1_800_000, 'non-positive → default');
  } finally {
    if (prevGrace === undefined) delete process.env.CORTEX_BG_GRACE_S; else process.env.CORTEX_BG_GRACE_S = prevGrace;
    if (prevMax === undefined) delete process.env.CORTEX_BG_WAIT_MAX_S; else process.env.CORTEX_BG_WAIT_MAX_S = prevMax;
  }
});
