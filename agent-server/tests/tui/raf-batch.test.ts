// input:  src/tui/raf-batch.js
// output: Unit tests for the numeric coalescer + leading/trailing throttle
// pos:    Guards Stage 2 of the TUI render-perf plan (event coalescing)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createNumericBatcher, createThrottle } from '../../src/tui/raf-batch.js';

test('numeric batcher sums deltas and applies once per flush', () => {
  const applied: number[] = [];
  let scheduled: (() => void) | null = null;
  const batcher = createNumericBatcher(
    (s) => applied.push(s),
    (cb) => { scheduled = cb; return 1; },
    () => { scheduled = null; },
  );
  batcher.add(1);
  batcher.add(1);
  batcher.add(-1); // net +1
  assert.equal(applied.length, 0, 'no apply before flush');
  scheduled!(); // run the scheduled flush
  assert.deepEqual(applied, [1]);
});

test('numeric batcher skips apply when net delta is zero', () => {
  const applied: number[] = [];
  let scheduled: (() => void) | null = null;
  const batcher = createNumericBatcher(
    (s) => applied.push(s),
    (cb) => { scheduled = cb; return 1; },
    () => { scheduled = null; },
  );
  batcher.add(2);
  batcher.add(-2);
  scheduled!();
  assert.deepEqual(applied, []);
});

test('numeric batcher schedules only one flush per burst', () => {
  let scheduleCount = 0;
  let scheduled: (() => void) | null = null;
  const batcher = createNumericBatcher(
    () => {},
    (cb) => { scheduleCount++; scheduled = cb; return scheduleCount; },
    () => {},
  );
  batcher.add(1);
  batcher.add(1);
  batcher.add(1);
  assert.equal(scheduleCount, 1, 'one schedule for three adds in a burst');
  scheduled!();
  batcher.add(1); // new burst after flush
  assert.equal(scheduleCount, 2);
});

test('flushNow applies immediately and cancels pending', () => {
  const applied: number[] = [];
  let cancelled = false;
  const batcher = createNumericBatcher(
    (s) => applied.push(s),
    () => 1,
    () => { cancelled = true; },
  );
  batcher.add(5);
  batcher.flushNow();
  assert.deepEqual(applied, [5]);
  assert.ok(cancelled);
});

test('throttle runs leading call immediately', () => {
  const calls: number[] = [];
  let clock = 1000;
  const t = createThrottle((n: number) => calls.push(n), 16, {
    now: () => clock,
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  t.call(1);
  assert.deepEqual(calls, [1]);
});

test('throttle coalesces a burst into one trailing call with latest args', () => {
  const calls: number[] = [];
  let clock = 1000;
  let trailing: (() => void) | null = null;
  const t = createThrottle((n: number) => calls.push(n), 16, {
    now: () => clock,
    schedule: (cb) => { trailing = cb; return 1; },
    cancelSchedule: () => { trailing = null; },
  });
  t.call(1);          // leading -> runs now
  clock = 1005;
  t.call(2);          // within window -> scheduled
  clock = 1008;
  t.call(3);          // within window -> updates pending args
  assert.deepEqual(calls, [1]);
  clock = 1016;
  trailing!();        // trailing fires with the latest args (3)
  assert.deepEqual(calls, [1, 3]);
});

test('throttle runs leading again after the interval elapses', () => {
  const calls: number[] = [];
  let clock = 1000;
  const t = createThrottle((n: number) => calls.push(n), 16, {
    now: () => clock,
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  t.call(1);
  clock = 1100; // well past interval
  t.call(2);
  assert.deepEqual(calls, [1, 2]);
});
