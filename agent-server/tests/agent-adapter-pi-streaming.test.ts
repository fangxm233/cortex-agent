// input:  PIAdapter, stub process, events, runtime settings
// output: assistant delta and buffered text regressions
// pos:    Covers the PI token streaming contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import type { NormalizedEvent } from '../src/agent-adapter/normalize/event-types.js';

// --- Stub child process infrastructure (mirrors agent-adapter-pi.test.ts) ---

interface StubChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  __killed: boolean;
}

function makeStubChild(): StubChild {
  const emitter = new EventEmitter() as StubChild;
  emitter.stdin = new PassThrough();
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.__killed = false;
  emitter.kill = (_signal?: NodeJS.Signals | number) => {
    if (emitter.__killed) return false;
    emitter.__killed = true;
    return true;
  };
  return emitter;
}

function makeStubSpawner(): {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  children: StubChild[];
} {
  const children: StubChild[] = [];
  return {
    children,
    spawn: (_cmd, _args, _opts) => {
      const child = makeStubChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  };
}

/** Feed one raw PI rpc stdout line (JSONL) into the session. */
function pushLine(child: StubChild, obj: unknown): void {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
}

/** A message_update carrying one assistant text delta. `id` omitted → no message object. */
function textDelta(delta: string, id?: string): unknown {
  const ev: Record<string, unknown> = {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta },
  };
  if (id !== undefined) ev['message'] = { id };
  return ev;
}

/** Drain exactly `n` events from the (already-buffered) queue. */
async function collect(proc: { events: AsyncIterable<NormalizedEvent> }, n: number): Promise<NormalizedEvent[]> {
  const iter = proc.events[Symbol.asyncIterator]();
  const out: NormalizedEvent[] = [];
  for (let i = 0; i < n; i++) {
    const r = await iter.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

/**
 * Drive one assistant block: three text deltas then message_end (a non-text event, which
 * forces the adapter's whole-message flush). Returns every event produced.
 * `deltasEmitted` controls how many assistant_delta events to expect ahead of the flush.
 */
async function runBlock(
  streamEnv: string | undefined,
  id: string | undefined,
  expectedCount: number,
): Promise<NormalizedEvent[]> {
  const prev = process.env['CORTEX_STREAM_DELTAS'];
  if (streamEnv === undefined) delete process.env['CORTEX_STREAM_DELTAS'];
  else process.env['CORTEX_STREAM_DELTAS'] = streamEnv;
  try {
    vi.resetModules();
    const { PIAdapter: FreshPIAdapter } = await import('../src/agent-adapter/pi/adapter.js');
    const stub = makeStubSpawner();
    const adapter = new FreshPIAdapter(stub.spawn);
    const proc = adapter.spawn({ sessionId: null, sessionKey: `stream-${id ?? 'noid'}-${streamEnv ?? 'on'}`, resume: false });
    await Promise.resolve();
    const child = stub.children[0]!;

    pushLine(child, textDelta('Hel', id));
    pushLine(child, textDelta('lo ', id));
    pushLine(child, textDelta('world', id));
    pushLine(child, { type: 'message_end' });

    const events = await collect(proc, expectedCount);
    child.emit('close', 0, null);
    await proc.close();
    return events;
  } finally {
    if (prev === undefined) delete process.env['CORTEX_STREAM_DELTAS'];
    else process.env['CORTEX_STREAM_DELTAS'] = prev;
  }
}

// --- (a) per-delta assistant_delta with a stable, shared blockId ---

test('PI streams one assistant_delta per incoming text_delta, carrying the incremental chunk', async () => {
  // 3 deltas + flushed assistant_text + turn_progress = 5
  const events = await runBlock(undefined, 'm1', 5);

  const deltas = events.filter((e) => e.type === 'assistant_delta') as Extract<NormalizedEvent, { type: 'assistant_delta' }>[];
  assert.equal(deltas.length, 3, 'one assistant_delta per incoming text_delta');
  assert.deepEqual(
    deltas.map((d) => d.text),
    ['Hel', 'lo ', 'world'],
    'text is the incremental chunk, never the accumulated total',
  );
  assert.deepEqual(
    deltas.map((d) => d.blockId),
    ['m1', 'm1', 'm1'],
    'blockId is stable across every delta of one assistant block',
  );
});

// --- (b) the finalizing assistant_text still arrives once, whole, with the same blockId ---

test('PI still emits exactly one whole-message assistant_text carrying the same blockId', async () => {
  const events = await runBlock(undefined, 'm1', 5);

  const texts = events.filter((e) => e.type === 'assistant_text') as Extract<NormalizedEvent, { type: 'assistant_text' }>[];
  assert.equal(texts.length, 1, 'whole-message granularity is preserved (one assistant_text per block)');
  assert.equal(texts[0]!.text, 'Hello world', 'assistant_text carries the complete accumulated message');
  assert.equal(texts[0]!.blockId, 'm1', 'the finalizing message shares the blockId of its deltas');

  // The deltas must precede the authoritative complete message.
  // findLastIndex would need lib es2023; the repo targets es2022.
  const lastDelta = events.reduce((acc, e, i) => (e.type === 'assistant_delta' ? i : acc), -1);
  const textIdx = events.findIndex((e) => e.type === 'assistant_text');
  assert.ok(lastDelta < textIdx, 'all deltas are emitted before the finalizing assistant_text');
});

// --- (c) kill switch suppresses deltas ONLY ---

test('CORTEX_STREAM_DELTAS=0 suppresses assistant_delta but leaves assistant_text untouched', async () => {
  // no deltas: flushed assistant_text + turn_progress = 2
  const events = await runBlock('0', 'm1', 2);

  assert.equal(events.filter((e) => e.type === 'assistant_delta').length, 0, 'kill switch emits no deltas');
  const texts = events.filter((e) => e.type === 'assistant_text') as Extract<NormalizedEvent, { type: 'assistant_text' }>[];
  assert.equal(texts.length, 1, 'the complete message is unaffected by the kill switch');
  assert.equal(texts[0]!.text, 'Hello world');
  assert.equal(texts[0]!.blockId, 'm1');
});

// --- edge: PI supplied no message.id → no stable blockId → no stream, text still delivered ---

test('a text_delta without a message id yields no assistant_delta but still flushes assistant_text', async () => {
  const events = await runBlock(undefined, undefined, 2);

  assert.equal(events.filter((e) => e.type === 'assistant_delta').length, 0, 'no blockId → nothing stable to stream');
  const texts = events.filter((e) => e.type === 'assistant_text') as Extract<NormalizedEvent, { type: 'assistant_text' }>[];
  assert.equal(texts.length, 1);
  assert.equal(texts[0]!.text, 'Hello world');
  assert.equal(texts[0]!.blockId, undefined, 'no blockId is invented when PI did not supply one');
});

// --- the real PI wire shape (no message.id; responseId is the stable per-message field) ---

test('a genuine PI message_update (responseId, contentIndex, partial) streams with a stable blockId', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'stream-real-shape', resume: false });
  await Promise.resolve();
  const child = stub.children[0]!;

  // Shape taken from the PI SDK: MessageUpdateEvent.message is an AssistantMessage, which has
  // role/content/api/provider/model/responseId/usage/stopReason/timestamp — and no `id`.
  const realDelta = (delta: string, partialText: string): unknown => ({
    type: 'message_update',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: partialText }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      responseId: 'msg_01XyZ',
      usage: { input: 10, output: 3 },
      stopReason: 'stop',
      timestamp: 1753459200000,
    },
    assistantMessageEvent: { type: 'text_delta', delta, contentIndex: 0, partial: { text: partialText } },
  });

  pushLine(child, realDelta('Hel', 'Hel'));
  pushLine(child, realDelta('lo', 'Hello'));
  pushLine(child, { type: 'message_end' });

  // 2 deltas + flushed assistant_text + turn_progress = 4
  const events = await collect(proc, 4);
  child.emit('close', 0, null);
  await proc.close();

  const deltas = events.filter((e) => e.type === 'assistant_delta') as Extract<NormalizedEvent, { type: 'assistant_delta' }>[];
  assert.deepEqual(deltas.map((d) => [d.text, d.blockId]), [['Hel', 'msg_01XyZ'], ['lo', 'msg_01XyZ']]);

  const texts = events.filter((e) => e.type === 'assistant_text') as Extract<NormalizedEvent, { type: 'assistant_text' }>[];
  assert.equal(texts.length, 1);
  assert.equal(texts[0]!.text, 'Hello', 'the whole message is the concatenation of the deltas');
  assert.equal(texts[0]!.blockId, 'msg_01XyZ', 'finalizing message shares the deltas blockId');
});

// --- edge: a new block id starts a new block, so a flush never mixes two blocks ---

test('a delta from a new message id flushes the previous block, keeping blockId 1:1 with its text', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'stream-two-blocks', resume: false });
  await Promise.resolve();
  const child = stub.children[0]!;

  pushLine(child, textDelta('alpha', 'm1'));
  pushLine(child, textDelta('beta', 'm2'));
  pushLine(child, { type: 'message_end' });

  // delta(m1) + flush(m1) + delta(m2) + flush(m2) + turn_progress = 5
  const events = await collect(proc, 5);
  child.emit('close', 0, null);
  await proc.close();

  const texts = events.filter((e) => e.type === 'assistant_text') as Extract<NormalizedEvent, { type: 'assistant_text' }>[];
  assert.equal(texts.length, 2, 'each message id finalizes as its own assistant_text');
  assert.deepEqual(
    texts.map((t) => [t.text, t.blockId]),
    [['alpha', 'm1'], ['beta', 'm2']],
    'no assistant_text ever mixes text from two block ids',
  );
});
