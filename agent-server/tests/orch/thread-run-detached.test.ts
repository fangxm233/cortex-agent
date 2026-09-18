// input:  openThreadRunDetached (orch/thread-run) — the detached helper thread-executor owned
// output: unit tests — fire-and-forget thread runs hold the busy gate for the whole pipeline
// pos:    regression for "server restart kills MCP-started (thread_start) background threads":
//         the webhook fire-and-forget path must bracket runThread with trackPendingTask(±1) so
//         childBusy stays true across the entire thread, deferring daemon restart/rebuild. The
//         gate is held across the onSettled callback too (test e) — it wakes the parent agent for
//         a full turn, and a deferred restart firing mid-wake would drop the notification. Since
//         T2.1 the ThreadRun the gate brackets also contains the terminal seal and the settle, so
//         "run" below means run + render + settle.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { openThreadRunDetached } from '../../src/orchestration/thread-run/index.js';

// A controllable run() so the test owns when the thread "completes".
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('(c) track(-1) and onSettled STILL fire when the run rejects (no throw escapes)', async () => {
  const trackCalls: number[] = [];
  const settled: string[] = [];
  const d = deferred<any>();
  openThreadRunDetached({ threadId: 'thr_c' } as any, (id) => { settled.push(id); }, {
    run: () => d.promise,
    track: (n) => { trackCalls.push(n); },
  });

  d.reject(new Error('boom'));
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(trackCalls, [+1, -1], 'track(-1) fired in finally even on rejection');
  assert.deepEqual(settled, ['thr_c'], 'onSettled fired even on rejection — busy gate never leaks');
});
