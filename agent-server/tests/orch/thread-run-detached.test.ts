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
