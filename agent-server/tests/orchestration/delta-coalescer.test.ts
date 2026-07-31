// input:  delta coalescer, fake timers, runtime settings
// output: batching and session stream gate regressions
// pos:    Covers server-side assistant delta throttling
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';

import {
  createDeltaCoalescer,
  createSessionDeltaStream,
  resolveFlushMs,
  DEFAULT_FLUSH_MS,
  MAX_PENDING_CHARS,
  type DeltaFlush,
} from '../../src/orchestration/delta-coalescer.js';

describe('resolveFlushMs', () => {
  test('defaults to 120ms', () => {
    assert.equal(resolveFlushMs({}), 120);
    assert.equal(DEFAULT_FLUSH_MS, 120);
  });

  test('honours CORTEX_STREAM_DELTA_MS', () => {
    assert.equal(resolveFlushMs({ CORTEX_STREAM_DELTA_MS: '250' }), 250);
  });

  test('rejects nonsense values rather than disabling batching by accident', () => {
    assert.equal(resolveFlushMs({ CORTEX_STREAM_DELTA_MS: 'soon' }), 120);
    assert.equal(resolveFlushMs({ CORTEX_STREAM_DELTA_MS: '-5' }), 120);
    assert.equal(resolveFlushMs({ CORTEX_STREAM_DELTA_MS: '' }), 120);
  });

  test('0 is honoured — it means publish every chunk as it arrives', () => {
    assert.equal(resolveFlushMs({ CORTEX_STREAM_DELTA_MS: '0' }), 0);
  });
});

describe('createDeltaCoalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('batches the chunks that arrive inside one window into a single flush', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 120 });

    c.push('b1', 'Tea ');
    c.push('b1', 'begins ');
    c.push('b1', 'as a leaf.');
    assert.deepEqual(out, [], 'nothing is published before the window closes');

    vi.advanceTimersByTime(120);
    assert.deepEqual(out, [{ blockId: 'b1', text: 'Tea begins as a leaf.', seq: 0 }]);
  });

  test('seq starts at 0 per blockId and increments per published event', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 100 });

    c.push('b1', 'one');
    vi.advanceTimersByTime(100);
    c.push('b1', 'two');
    vi.advanceTimersByTime(100);
    c.push('b2', 'other');
    vi.advanceTimersByTime(100);

    assert.deepEqual(out.map((f) => [f.blockId, f.seq]), [['b1', 0], ['b1', 1], ['b2', 0]]);
  });

  test('two blocks in flight batch independently', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 100 });

    c.push('b1', 'aa');
    c.push('b2', 'bb');
    vi.advanceTimersByTime(100);

    assert.deepEqual(
      out.map((f) => `${f.blockId}:${f.text}`).sort(),
      ['b1:aa', 'b2:bb'],
    );
  });

  test('a long burst flushes on the character cap without waiting for the timer', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 10_000 });

    c.push('b1', 'x'.repeat(MAX_PENDING_CHARS - 1));
    assert.equal(out.length, 0, 'one char short of the cap still waits');
    c.push('b1', 'y');
    assert.equal(out.length, 1, 'reaching the cap publishes immediately');
    assert.equal(out[0].text.length, MAX_PENDING_CHARS);
  });

  test('the timer is rearmed after a cap-triggered flush, not left dangling', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 100 });

    c.push('b1', 'z'.repeat(MAX_PENDING_CHARS));
    assert.equal(out.length, 1);
    c.push('b1', 'tail');
    vi.advanceTimersByTime(100);
    assert.deepEqual(out.map((f) => f.text), ['z'.repeat(MAX_PENDING_CHARS), 'tail']);
    assert.deepEqual(out.map((f) => f.seq), [0, 1]);
  });

  test('flush(blockId) publishes what is pending right now — the pre-finalizing drain', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 10_000 });

    c.push('b1', 'partial');
    c.flush('b1');
    assert.deepEqual(out, [{ blockId: 'b1', text: 'partial', seq: 0 }]);

    // The pending timer must have been cancelled — no phantom empty flush later.
    vi.advanceTimersByTime(20_000);
    assert.equal(out.length, 1);
  });

  test('flushing a block with nothing pending publishes nothing', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 100 });

    c.flush('never-seen');
    c.push('b1', 'x');
    c.flush('b1');
    c.flush('b1');
    assert.equal(out.length, 1, 'a second flush of a drained block is a no-op');
  });

  test('flush() with no argument drains every block', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 10_000 });

    c.push('b1', 'aa');
    c.push('b2', 'bb');
    c.flush();
    assert.equal(out.length, 2);
  });

  test('an empty chunk is ignored and never arms a window', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 100 });

    c.push('b1', '');
    vi.advanceTimersByTime(1000);
    assert.equal(out.length, 0);
  });

  test('dispose() drops pending text and cancels every timer', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 100 });

    c.push('b1', 'inflight');
    c.dispose();
    vi.advanceTimersByTime(1000);
    assert.equal(out.length, 0, 'a turn that ended must not publish afterwards');

    c.push('b1', 'after-dispose');
    c.flush('b1');
    assert.equal(out.length, 0, 'a disposed coalescer stays inert');
  });

  test('a throwing sink cannot poison the coalescer', () => {
    let calls = 0;
    const c = createDeltaCoalescer({
      onFlush: () => { calls++; throw new Error('bus exploded'); },
      flushMs: 100,
    });

    c.push('b1', 'a');
    vi.advanceTimersByTime(100);
    c.push('b1', 'b');
    vi.advanceTimersByTime(100);
    assert.equal(calls, 2, 'the second window still fires');
  });

  test('flushMs 0 publishes each chunk on the next tick without merging late arrivals', () => {
    const out: DeltaFlush[] = [];
    const c = createDeltaCoalescer({ onFlush: (f) => out.push(f), flushMs: 0 });

    c.push('b1', 'a');
    vi.advanceTimersByTime(0);
    c.push('b1', 'b');
    vi.advanceTimersByTime(0);
    assert.deepEqual(out.map((f) => f.text), ['a', 'b']);
  });
});

describe('createSessionDeltaStream — who is allowed to stream at all', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type Published = { sessionId: string; channel: string; blockId: string; text: string; seq: number };
  const sink = (): { out: Published[]; publish: (p: Published) => void } => {
    const out: Published[] = [];
    return { out, publish: (p) => out.push(p) };
  };

  test('a web session streams: chunks are coalesced and published with its session/channel', () => {
    const s = sink();
    const stream = createSessionDeltaStream({ sessionId: 'sess-1', channel: 'web:abc', publish: s.publish, flushMs: 100 });
    assert.ok(stream, 'a web session must get a stream');

    stream!.onDelta('Tea ', 'msg_A:1');
    stream!.onDelta('is a leaf.', 'msg_A:1');
    vi.advanceTimersByTime(100);

    assert.deepEqual(s.out, [{
      sessionId: 'sess-1', channel: 'web:abc', blockId: 'msg_A:1', text: 'Tea is a leaf.', seq: 0,
    }]);
  });

  test('Slack / Feishu / Ink-TUI / thread channels never stream — no delta can reach OutputStream', () => {
    for (const channel of ['slack:C123', 'feishu:oc_1', 'tui:local', 'thr:e0b6:1', 'general']) {
      const s = sink();
      const stream = createSessionDeltaStream({ sessionId: 'sess-1', channel, publish: s.publish, flushMs: 100 });
      assert.equal(stream, null, `${channel} must not stream`);
    }
  });

  test('a session without an id cannot stream (nothing to key the events by)', () => {
    const s = sink();
    assert.equal(createSessionDeltaStream({ sessionId: null, channel: 'web:abc', publish: s.publish }), null);
  });

  test('CORTEX_STREAM_DELTAS=0 disables the stream even for a web session', async () => {
    const prev = process.env.CORTEX_STREAM_DELTAS;
    process.env.CORTEX_STREAM_DELTAS = '0';
    try {
      vi.resetModules();
      const { createSessionDeltaStream: createFresh } = await import('../../src/orchestration/delta-coalescer.js');
      const s = sink();
      assert.equal(createFresh({ sessionId: 'sess-1', channel: 'web:abc', publish: s.publish }), null);
    } finally {
      if (prev === undefined) delete process.env.CORTEX_STREAM_DELTAS;
      else process.env.CORTEX_STREAM_DELTAS = prev;
    }
  });

  test('flush drains the block before its complete message goes out', () => {
    const s = sink();
    const stream = createSessionDeltaStream({ sessionId: 'sess-1', channel: 'web:abc', publish: s.publish, flushMs: 10_000 })!;

    stream.onDelta('half a sen', 'msg_A:1');
    stream.flush('msg_A:1');
    assert.equal(s.out.length, 1, 'pending preview is published before the authoritative text');
    assert.equal(s.out[0].text, 'half a sen');
  });

  test('dispose stops the stream for good (turn over)', () => {
    const s = sink();
    const stream = createSessionDeltaStream({ sessionId: 'sess-1', channel: 'web:abc', publish: s.publish, flushMs: 100 })!;

    stream.onDelta('late', 'msg_A:1');
    stream.dispose();
    vi.advanceTimersByTime(1000);
    assert.equal(s.out.length, 0);
  });
});
