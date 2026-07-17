// input:  runThreadDetached helper (orch/thread-executor)
// output: unit tests — fire-and-forget thread runs hold the busy gate for the whole pipeline
// pos:    regression for "server restart kills MCP-started (thread_start) background threads":
//         the webhook fire-and-forget path must bracket runThread with trackPendingTask(±1) so
//         childBusy stays true across the entire thread, deferring daemon restart/rebuild. The
//         gate is held across the onSettled callback too (test e) — it wakes the parent agent for
//         a full turn, and a deferred restart firing mid-wake would drop the notification.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runThreadDetached } from '../../src/orchestration/thread-executor.js';

// A controllable run() so the test owns when the thread "completes".
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('(a) runThreadDetached calls track(+1) synchronously, before the thread settles', () => {
  const trackCalls: number[] = [];
  const d = deferred<any>();
  runThreadDetached('thr_a', {} as any, {
    run: () => d.promise,
    track: (n) => { trackCalls.push(n); },
  });
  // track(+1) must fire synchronously so the daemon sees `busy` before it can act on an idle.
  assert.deepEqual(trackCalls, [+1], 'track(+1) fired synchronously, track(-1) NOT yet');
  d.resolve({});
});

test('(b) track(-1) and onSettled fire after a successful run', async () => {
  const trackCalls: number[] = [];
  const settled: string[] = [];
  const d = deferred<any>();
  runThreadDetached('thr_b', {} as any, {
    run: () => d.promise,
    track: (n) => { trackCalls.push(n); },
    onSettled: (id) => { settled.push(id); },
  });
  assert.deepEqual(trackCalls, [+1], 'before completion: only +1');

  d.resolve({});
  // allow the .finally microtasks to flush
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(trackCalls, [+1, -1], 'track(-1) fired in finally after success');
  assert.deepEqual(settled, ['thr_b'], 'onSettled fired with threadId after success');
});

test('(c) track(-1) and onSettled STILL fire when the run rejects (no throw escapes)', async () => {
  const trackCalls: number[] = [];
  const settled: string[] = [];
  const d = deferred<any>();
  runThreadDetached('thr_c', {} as any, {
    run: () => d.promise,
    track: (n) => { trackCalls.push(n); },
    onSettled: (id) => { settled.push(id); },
  });

  d.reject(new Error('boom'));
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(trackCalls, [+1, -1], 'track(-1) fired in finally even on rejection');
  assert.deepEqual(settled, ['thr_c'], 'onSettled fired even on rejection — busy gate never leaks');
});

test('(d) count returns to zero exactly once across the lifecycle (balanced bracket)', async () => {
  let count = 0;
  const observed: number[] = [];
  const d = deferred<any>();
  runThreadDetached('thr_d', {} as any, {
    run: () => d.promise,
    track: (n) => { count += n; observed.push(count); },
  });
  assert.equal(count, 1, 'busy while running');
  d.resolve({});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(count, 0, 'idle after settle');
  assert.deepEqual(observed, [1, 0], 'exactly one +1 then one -1');
});

test('(e) track(-1) is deferred until the onSettled callback settles (gate held across callback)', async () => {
  const trackCalls: number[] = [];
  const cb = deferred<void>();
  const d = deferred<any>();
  runThreadDetached('thr_e', {} as any, {
    run: () => d.promise,
    track: (n) => { trackCalls.push(n); },
    onSettled: () => cb.promise, // long-running callback (e.g. waking the parent agent for a turn)
  });

  d.resolve({});
  await new Promise((r) => setTimeout(r, 0));
  // Thread done, but callback still in flight → busy gate NOT released yet (no premature idle).
  assert.deepEqual(trackCalls, [+1], 'track(-1) deferred while onSettled callback in flight');

  cb.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(trackCalls, [+1, -1], 'track(-1) fires only after the callback settles');
});
