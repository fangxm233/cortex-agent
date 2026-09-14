// input:  PIAdapter over the fake PI runtime, engine surface (open().run()) only
// output: engine contract: phased RunEvent order, result/settled, steer acks, run-scoped cancel
// pos:    PI EngineSession contract after the legacy spawn() parity half was deleted
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { engineSpecFixture } from '../engine-spec-fixture.js';

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { toRunEvent, type RunEvent } from '../../src/agent-adapter/run-events.js';
import type { EngineSpec } from '../../src/agent-adapter/types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import { makeFakeRuntimeFactory } from './pi-fake-runtime.js';

function spec(sessionKey: string): EngineSpec {
  return engineSpecFixture({ sessionId: null, sessionKey, resume: false, piProvider: 'fake' });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

/** The trailing phase the engine appends once a PI turn's stream has ended. */
const DONE: RunEvent = {
  type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0,
};

test('open().run() yields the phased events, in order, for a scripted PI turn', async (t) => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const engine = adapter.open(spec('pi-engine-parity'));
  t.onTestFinished(() => engine.close());

  // The raw protocol record the engine forwards is the authority for the phased stream; it is
  // tapped from the same run so the RunEvent stream can be asserted against the wire, not
  // against a second (deleted) surface.
  const raw: NormalizedEvent[] = [];
  const run = engine.run({ text: 'opening' }, {
    awaitBackground: 'none',
    onNormalizedEvent: (event) => raw.push(event),
  });
  const runtime = await fake.runtime(0);
  await runtime.nextCall('prompt');
  runtime.emitSimpleTurn('hello', { usage: { cost: { total: 0.02 } } });
  const result = await run.result;
  const settled = await run.settled;
  const events = await collect(run.events);

  // Literal PI protocol facts (legacy spawn() parity expectations folded in): one turn, in order,
  // including the terminal marker the engine drops.
  assert.deepEqual(raw, [
    { type: 'session_started', sessionId: 'fake-pi-engine-parity', sessionFile: runtime.sessionFile },
    // The session's default `streamDeltas` keeps the per-token preview event AND the whole
    // buffered message; both are part of the real wire record the tap forwards.
    { type: 'assistant_delta', text: 'hello', blockId: 'msg-1' },
    { type: 'assistant_text', text: 'hello', blockId: 'msg-1' },
    { type: 'turn_progress', numTurns: 1 },
    {
      type: 'cost_record', provider: 'fake', model: 'fake-model',
      tokens_in: 0, tokens_out: 0,
      prompt_tokens: null, cached_tokens: null,
      input_tokens: null, output_tokens: null,
      cache_read_tokens: null, cache_creation_tokens: null,
      provider_requests: 1, cost_usd: 0.02,
    },
    { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.02 },
  ]);

  const expectedResult: AgentResult = {
    sessionId: 'fake-pi-engine-parity',
    total_cost_usd: 0.02,
    num_turns: 1,
    rateLimited: false,
    rateLimitMessage: null,
    planFilePath: null,
    enteredPlanMode: false,
    exitedPlanMode: false,
    // PI's `buildAgentResult` always writes the key (undefined when the turn asked nothing), and
    // the strict comparison pins that own property rather than treating an absent key as equal.
    askUserQuestions: undefined,
    finalOutput: null,
  };
  // The RunEvent stream is the tapped protocol record phased foreground, minus `turn_complete`
  // (the marker, not a result), plus the authoritative result and the terminal phase.
  const expected: RunEvent[] = [
    ...raw
      .filter((event) => event.type !== 'turn_complete')
      .map((event) => toRunEvent(event, 'foreground')),
    { type: 'foreground_result', result: expectedResult },
    DONE,
  ];
  assert.deepEqual(events, expected);
  assert.deepEqual(result, expectedResult);
  assert.deepEqual(settled, expectedResult);
});

test('open().run() rejects a failed PI turn with the provider error', async (t) => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const engine = adapter.open(spec('pi-engine-fail'));
  t.onTestFinished(() => engine.close());

  const run = engine.run({ text: 'opening' }, { awaitBackground: 'none' });
  const runtime = await fake.runtime(0);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAgentEnd({ stopReason: 'error', errorMessage: 'boom' });

  const engineError = await run.result.then(
    () => assert.fail('engine run must reject'),
    (error: Error) => error,
  );
  // Literal expectations, folded in from the deleted spawn().send() comparison.
  assert.equal(engineError.message, 'boom');
  assert.equal((engineError as Error & { reason?: string }).reason, 'provider_error');

  // A rejected turn ends the run stream with its terminal phase and no foreground result.
  const events = await collect(run.events);
  assert.deepEqual(events.map((event) => event.type), ['engine_started', 'cost_record', 'phase']);
  assert.deepEqual(events.at(-1), DONE);
});

test('open().run() surfaces steer refusals and deliveries on the run stream', async (t) => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const engine = adapter.open(spec('pi-engine-steer'));
  t.onTestFinished(() => engine.close());

  const run = engine.run({ text: 'opening' }, { awaitBackground: 'none' });
  // The prompt has not reached PI (the runtime may not even exist yet): PI refuses by design.
  const refused = engine.steer({ text: 'too early' });
  assert.equal(refused.accepted, false);

  const runtime = await fake.runtime(0);
  await runtime.nextCall('prompt');
  const accepted = engine.steer({ text: 'while running' });
  assert.equal(accepted.accepted, true);

  runtime.emitAgentStart();
  runtime.emitUserMessage('while running');
  runtime.emitAssistantText('reply');
  runtime.emitAgentEnd({ usage: { cost: { total: 0.01 } } });

  await run.result;
  const events = await collect(run.events);
  const injections = events.filter(
    (event) => event.type === 'injection_delivered' || event.type === 'injection_rejected',
  );
  assert.deepEqual(injections, [
    { type: 'injection_rejected', injectionId: refused.injectionId, reason: 'refused' },
    { type: 'injection_delivered', injectionId: accepted.injectionId, foldedIntoTurn: true },
  ]);
  assert.equal(events.at(-1)?.type, 'phase');
});

test('cancel() ends the run stream without closing the session; a later run still works', async (t) => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const engine = adapter.open(spec('pi-engine-cancel'));
  t.onTestFinished(() => engine.close());

  const first = engine.run({ text: 'first' }, { awaitBackground: 'none' });
  void first.result.catch(() => undefined);
  const runtime = await fake.runtime(0);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();

  first.cancel();
  const firstEvents = await collect(first.events);
  assert.deepEqual(firstEvents.at(-1), DONE);
  assert.equal(runtime.disposed, false, 'cancel must not dispose the session');

  const second = engine.run({ text: 'second' }, { awaitBackground: 'none' });
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAssistantText('second reply');
  runtime.emitAgentEnd({ usage: { cost: { total: 0.03 } } });
  const result = await second.result;
  const secondEvents = await collect(second.events);

  assert.deepEqual(secondEvents.at(-1), DONE);
  assert.equal(result.total_cost_usd, 0.03);
  assert.equal(runtime.disposed, false);
});
