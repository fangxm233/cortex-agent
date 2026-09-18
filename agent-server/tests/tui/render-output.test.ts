// input:  src/tui/render-output.js
// output: Unit tests for the synchronized-output stdout wrapper + render stats
// pos:    Guards Stage 0/1 of the TUI render-perf plan (flicker fix)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  BSU, ESU,
  newRenderStats,
  makeRenderStdout,
} from '../../src/tui/render-output.js';

/** Minimal stdout double capturing raw writes. */
function fakeStdout() {
  const writes: string[] = [];
  const base = {
    columns: 120,
    rows: 40,
    isTTY: true,
    write(chunk: unknown): boolean { writes.push(String(chunk)); return true; },
    on() { return base; },
  } as unknown as NodeJS.WriteStream;
  return { base, writes };
}

test('makeRenderStdout wraps each string frame atomically', () => {
  const { base, writes } = fakeStdout();
  const out = makeRenderStdout(base, { sync: true });
  out.write('hello');
  assert.equal(writes.length, 1);
  assert.equal(writes[0], BSU + 'hello' + ESU);
});

test('makeRenderStdout records stats and exposes them', () => {
  const { base } = fakeStdout();
  const stats = newRenderStats();
  let clock = 1000;
  const out = makeRenderStdout(base, { sync: true, stats, now: () => clock });
  out.write('first');
  clock = 1050;
  out.write('\x1b[2Jsecond');
  assert.equal(out.__renderStats, stats);
  assert.equal(stats.writes, 2);
  assert.equal(stats.clears, 1);
});
