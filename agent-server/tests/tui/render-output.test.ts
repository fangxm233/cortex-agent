// input:  src/tui/render-output.js
// output: Unit tests for the synchronized-output stdout wrapper + render stats
// pos:    Guards Stage 0/1 of the TUI render-perf plan (flicker fix)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  BSU, ESU,
  wrapFrame,
  newRenderStats,
  recordWrite,
  writesPerSecond,
  makeRenderStdout,
} from '../../src/tui/render-output.js';

test('wrapFrame wraps in BSU/ESU when sync is on', () => {
  const out = wrapFrame('FRAME', true);
  assert.equal(out, BSU + 'FRAME' + ESU);
  assert.ok(out.startsWith(BSU));
  assert.ok(out.endsWith(ESU));
});

test('wrapFrame is a no-op when sync is off (escape hatch)', () => {
  assert.equal(wrapFrame('FRAME', false), 'FRAME');
});

test('recordWrite folds writes, bytes, clears and timing', () => {
  const stats = newRenderStats();
  recordWrite(stats, 'abc', 1000);
  recordWrite(stats, '\x1b[2Jrepaint', 1100); // full-clear frame
  assert.equal(stats.writes, 2);
  assert.equal(stats.bytes, 3 + '\x1b[2Jrepaint'.length);
  assert.equal(stats.clears, 1);
  assert.equal(stats.firstAt, 1000);
  assert.equal(stats.lastAt, 1100);
});

test('writesPerSecond derives a rate, 0 when under-sampled', () => {
  const stats = newRenderStats();
  assert.equal(writesPerSecond(stats), 0);
  recordWrite(stats, 'a', 0);
  recordWrite(stats, 'b', 500); // 2 writes over 0.5s -> 4/s
  assert.equal(writesPerSecond(stats), 4);
});

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

test('makeRenderStdout passes through geometry getters bound to the real stream', () => {
  const { base } = fakeStdout();
  const out = makeRenderStdout(base, { sync: true });
  assert.equal(out.columns, 120);
  assert.equal(out.rows, 40);
  assert.equal(out.isTTY, true);
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

test('makeRenderStdout sync=false leaves frames untouched', () => {
  const { base, writes } = fakeStdout();
  const out = makeRenderStdout(base, { sync: false });
  out.write('raw');
  assert.equal(writes[0], 'raw');
});
