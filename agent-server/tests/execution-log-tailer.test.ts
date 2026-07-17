// input:  Node test runner + ExecutionLogTailer engine (domain/executions/log-tailer.ts)
// output: incremental-read / flood-bound / ref-count / resolver regression tests
// pos:    child B (task 342f) — live execution log tail source + execution.log event
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../src/events/event-bus.js';
import type { CortexEvent } from '../src/events/event-types.js';
import {
  ExecutionLogTailer,
  resolveExecutionLogLocation,
  type LogLocation,
  type LogReader,
} from '../src/domain/executions/log-tailer.js';

type LogEvent = Extract<CortexEvent, { type: 'execution.log' }>;

/** In-memory fake of an append-only output.log, read via byte offset. */
function makeFs() {
  const files = new Map<string, string>();
  const read: LogReader = async (loc, offset) => {
    const buf = Buffer.from(files.get(loc.path) ?? '', 'utf8');
    const start = offset > buf.length ? 0 : offset; // rotation/truncation resets
    return { chunk: buf.subarray(start).toString('utf8'), nextOffset: buf.length };
  };
  return { files, read };
}

function captureLog(bus: EventBus): LogEvent[] {
  const events: LogEvent[] = [];
  bus.subscribe('execution.log', (e) => { events.push(e); });
  return events;
}

const LOCAL = (path: string): LogLocation => ({ kind: 'local', path });

test('publishes new complete lines incrementally, holding a partial last line', async () => {
  const { files, read } = makeFs();
  const bus = new EventBus();
  const events = captureLog(bus);
  const tailer = new ExecutionLogTailer({ read, pollIntervalMs: 0 });
  tailer.setBus(bus);

  files.set('/log', 'a\nb\n');
  tailer.startTail('e1', LOCAL('/log'));
  await tailer.pollOnce('e1');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].lines, ['a', 'b']);
  assert.equal(events[0].seq, 0);
  assert.equal(events[0].executionId, 'e1');
  assert.equal(events[0].dropped ?? 0, 0);

  // 'c' is complete; 'par' is a partial line and must be withheld.
  files.set('/log', 'a\nb\nc\npar');
  await tailer.pollOnce('e1');
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].lines, ['c']);
  assert.equal(events[1].seq, 1);

  // The partial line completes on the next flush.
  files.set('/log', 'a\nb\nc\npartial done\n');
  await tailer.pollOnce('e1');
  assert.equal(events.length, 3);
  assert.deepEqual(events[2].lines, ['partial done']);
  assert.equal(events[2].seq, 2);

  // No new bytes → no emit.
  await tailer.pollOnce('e1');
  assert.equal(events.length, 3);
});

test('flood: bounds emitted lines to the cap and marks the drop count', async () => {
  const { files, read } = makeFs();
  const bus = new EventBus();
  const events = captureLog(bus);
  const tailer = new ExecutionLogTailer({ read, pollIntervalMs: 0, maxBufferLines: 10 });
  tailer.setBus(bus);

  const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n';
  files.set('/f', content);
  tailer.startTail('e1', LOCAL('/f'));
  await tailer.pollOnce('e1');

  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.lines.length, 10, 'emitted lines must not exceed the cap');
  assert.equal(e.dropped, 90, 'drop marker must count coalesced/dropped lines');
  // drop-oldest keeps the newest tail (most relevant for a live view)
  assert.deepEqual(e.lines, Array.from({ length: 10 }, (_, i) => `line${90 + i}`));
});

test('flood: bounds buffered bytes to the byte cap', async () => {
  const { files, read } = makeFs();
  const bus = new EventBus();
  const events = captureLog(bus);
  const tailer = new ExecutionLogTailer({ read, pollIntervalMs: 0, maxBufferLines: 100000, maxBufferBytes: 30 });
  tailer.setBus(bus);

  const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n';
  files.set('/f', content);
  tailer.startTail('e1', LOCAL('/f'));
  await tailer.pollOnce('e1');

  assert.equal(events.length, 1);
  const e = events[0];
  const bytes = e.lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8'), 0);
  assert.ok(bytes <= 30, `buffered bytes ${bytes} must be within the 30-byte cap`);
  assert.ok((e.dropped ?? 0) > 0, 'over-cap flood must set a drop marker');
});

test('ref-counted start/stop: last stop tears down the underlying tail', async () => {
  const { files, read } = makeFs();
  const bus = new EventBus();
  const events = captureLog(bus);
  const tailer = new ExecutionLogTailer({ read, pollIntervalMs: 0 });
  tailer.setBus(bus);

  files.set('/r', '');
  tailer.startTail('e1', LOCAL('/r'));
  assert.equal(tailer.refCount('e1'), 1);
  tailer.startTail('e1', LOCAL('/r'));
  assert.equal(tailer.refCount('e1'), 2);

  files.set('/r', 'x\n');
  await tailer.pollOnce('e1');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].lines, ['x']);

  // First stop: still one consumer left → tail stays alive.
  tailer.stopTail('e1');
  assert.equal(tailer.refCount('e1'), 1);
  files.set('/r', 'x\ny\n');
  await tailer.pollOnce('e1');
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].lines, ['y']);

  // Last stop: tail is torn down; offset/carry state is gone.
  tailer.stopTail('e1');
  assert.equal(tailer.refCount('e1'), 0);
  files.set('/r', 'x\ny\nz\n');
  await tailer.pollOnce('e1'); // no live tail → no-op
  assert.equal(events.length, 2, 'no emit after the underlying tail is torn down');

  // Stopping an unknown / already-stopped execution is a no-op.
  assert.doesNotThrow(() => tailer.stopTail('e1'));
  assert.doesNotThrow(() => tailer.stopTail('never-started'));
});

test('resolveExecutionLogLocation resolves from persisted dispatch.runName (executionId only)', () => {
  const rec = (machine: string | null, runName: string | null) =>
    ({ dispatch: machine || runName ? { machine, runName } : null }) as any;
  const getExecution = (id: string) => {
    if (id === 'local-id') return rec(null, 'run1');
    if (id === 'self-id') return rec('lab2', 'run1');
    if (id === 'remote-id') return rec('lab', 'run1');
    if (id === 'no-runname') return rec('lab2', null); // registered but never got a run name
    return null;
  };
  const opts = { getExecution, localMachine: 'lab2', tmpBaseDir: '/base' } as const;

  assert.deepEqual(
    resolveExecutionLogLocation('local-id', opts),
    { kind: 'local', path: '/base/run1/output.log' },
  );
  assert.deepEqual(
    resolveExecutionLogLocation('self-id', opts),
    { kind: 'local', path: '/base/run1/output.log' },
  );
  assert.deepEqual(
    resolveExecutionLogLocation('remote-id', opts),
    { kind: 'remote', device: 'lab', path: '/base/run1/output.log' },
  );
  // Unknown id and a record without a runName both resolve to null (nothing to tail).
  assert.equal(resolveExecutionLogLocation('no-runname', opts), null);
  assert.equal(resolveExecutionLogLocation('missing', opts), null);
});
