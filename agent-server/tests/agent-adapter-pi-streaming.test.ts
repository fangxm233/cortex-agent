import { engineSpecFixture } from './engine-spec-fixture.js';


import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import type { PIEngineSession } from '../src/agent-adapter/pi/engine.js';
import type { EngineRun } from '../src/agent-adapter/types.js';
import { piPool } from './agent-adapter/pi-pool-fixture.js';
import type { NormalizedEvent } from '../src/agent-adapter/normalize/event-types.js';
import { resetSettingsForTests } from '../src/core/settings.js';
import { makeFakeRuntimeFactory, type FakeRuntime } from './agent-adapter/pi-fake-runtime.js';

/** A message_update carrying one assistant text delta. `id` omitted → no message object. */
function textDelta(delta: string, id?: string): Record<string, unknown> & { type: string } {
  const ev: Record<string, unknown> & { type: string } = {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta },
  };
  if (id !== undefined) ev['message'] = { id };
  return ev;
}

/** A queue over the engine's raw NormalizedEvent port, drained like the old `proc.events`. */
interface RawTap {
  push(event: NormalizedEvent): void;
  collect(n: number): Promise<NormalizedEvent[]>;
}

/**
 * Tap `run(msg, { onNormalizedEvent })` and replay its events like the old `proc.events` queue,
 * skipping the opening `session_started`. These tests assert the PI SDK wire shape (incremental
 * delta chunks, stable blockIds, the session announcement), which only exists on the raw
 * `NormalizedEvent` stream: the run's translated `RunEvent` stream retags `session_started` and
 * adds a phase.
 */
function rawTap(): RawTap {
  const pending: NormalizedEvent[] = [];
  let wake: (() => void) | null = null;
  return {
    push(event) {
      pending.push(event);
      const resolve = wake;
      wake = null;
      resolve?.();
    },
    async collect(n) {
      const out: NormalizedEvent[] = [];
      while (out.length < n) {
        while (pending.length > 0) {
          const event = pending.shift()!;
          if (event.type !== 'session_started') out.push(event);
        }
        if (out.length >= n) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      return out;
    },
  };
}

async function spawnStreaming(sessionKey: string): Promise<{
  engine: PIEngineSession; run: EngineRun; tap: RawTap; runtime: FakeRuntime;
}> {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const tap = rawTap();
  const engine = piPool(adapter).open(engineSpecFixture({ sessionId: null, sessionKey, resume: false }));
  // `open()` alone has no turn stream; a run opens it. The tap keeps the raw protocol events that
  // the old pooled `proc.events` exposed, and no prompt has to be answered to observe them.
  const run = engine.run({ text: 'opening' }, { awaitBackground: 'none', onNormalizedEvent: tap.push });
  const runtime = await fake.runtime();
  return { engine, run, tap, runtime };
}

/**
 * Drive one assistant block: three text deltas then message_end (a non-text event, which
 * forces the adapter's whole-message flush). Returns every event produced.
 * `expectedCount` is how many events to wait for (deltas + flush + turn_progress).
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
    resetSettingsForTests();
    const { run, tap, runtime } = await spawnStreaming(`stream-${id ?? 'noid'}-${streamEnv ?? 'on'}`);

    runtime.emit(textDelta('Hel', id));
    runtime.emit(textDelta('lo ', id));
    runtime.emit(textDelta('world', id));
    runtime.emit({ type: 'message_end' });

    const events = await tap.collect(expectedCount);
    run.cancel();
    return events;
  } finally {
    if (prev === undefined) delete process.env['CORTEX_STREAM_DELTAS'];
    else process.env['CORTEX_STREAM_DELTAS'] = prev;
    resetSettingsForTests();
  }
}

test('PI keeps attribution on a subagent assistant message instead of merging it into main text', async () => {
  const { run, tap, runtime } = await spawnStreaming('stream-subagent-text');

  runtime.emit({
    type: 'cortex_subagent_event',
    notice: {
      ref: 'agent-call#0', type: 'explore', description: 'Inspect adapter',
      model: 'gpt-5.4-mini', kind: 'assistant_text', text: 'child report',
    },
  });
  runtime.emit({ type: 'message_end' });

  const events = await tap.collect(2);
  run.cancel();

  const text = events.find((event) => event.type === 'assistant_text');
  assert.ok(text && text.type === 'assistant_text');
  assert.equal(text.text, 'child report');
  assert.deepEqual(text.subagent, {
    parentToolUseId: 'agent-call#0', type: 'explore',
    description: 'Inspect adapter', model: 'gpt-5.4-mini',
  });
});

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
  const { run, tap, runtime } = await spawnStreaming('stream-real-shape');

  // Shape taken from the PI SDK: MessageUpdateEvent.message is an AssistantMessage, which has
  // role/content/api/provider/model/responseId/usage/stopReason/timestamp — and no `id`.
  const realDelta = (delta: string, partialText: string): Record<string, unknown> & { type: string } => ({
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

  runtime.emit(realDelta('Hel', 'Hel'));
  runtime.emit(realDelta('lo', 'Hello'));
  runtime.emit({ type: 'message_end' });

  // 2 deltas + flushed assistant_text + turn_progress = 4
  const events = await tap.collect(4);
  run.cancel();

  const deltas = events.filter((e) => e.type === 'assistant_delta') as Extract<NormalizedEvent, { type: 'assistant_delta' }>[];
  assert.deepEqual(deltas.map((d) => [d.text, d.blockId]), [['Hel', 'msg_01XyZ'], ['lo', 'msg_01XyZ']]);

  const texts = events.filter((e) => e.type === 'assistant_text') as Extract<NormalizedEvent, { type: 'assistant_text' }>[];
  assert.equal(texts.length, 1);
  assert.equal(texts[0]!.text, 'Hello', 'the whole message is the concatenation of the deltas');
  assert.equal(texts[0]!.blockId, 'msg_01XyZ', 'finalizing message shares the deltas blockId');
});

// --- edge: a new block id starts a new block, so a flush never mixes two blocks ---

test('a delta from a new message id flushes the previous block, keeping blockId 1:1 with its text', async () => {
  const { run, tap, runtime } = await spawnStreaming('stream-two-blocks');

  runtime.emit(textDelta('alpha', 'm1'));
  runtime.emit(textDelta('beta', 'm2'));
  runtime.emit({ type: 'message_end' });

  // delta(m1) + flush(m1) + delta(m2) + flush(m2) + turn_progress = 5
  const events = await tap.collect(5);
  run.cancel();

  const texts = events.filter((e) => e.type === 'assistant_text') as Extract<NormalizedEvent, { type: 'assistant_text' }>[];
  assert.equal(texts.length, 2, 'each message id finalizes as its own assistant_text');
  assert.deepEqual(
    texts.map((t) => [t.text, t.blockId]),
    [['alpha', 'm1'], ['beta', 'm2']],
    'no assistant_text ever mixes text from two block ids',
  );
});
