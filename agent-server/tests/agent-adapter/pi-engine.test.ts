// input:  PIAdapter over the fake PI runtime, both spawn() and open() surfaces
// output: parity spec: open().run() matches spawn().send() events/result, steer acks, cancel scope
// pos:    P2.2b — PI implements EngineSession alongside the pooled spawn() path
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { engineSpecFixture } from '../engine-spec-fixture.js';

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { piPool } from './pi-pool-fixture.js';
import { toRunEvent, type RunEvent } from '../../src/agent-adapter/run-events.js';
import type { EngineSpec } from '../../src/agent-adapter/types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import { makeFakeRuntimeFactory, type FakeRuntime, type FakeRuntimeFactory } from './pi-fake-runtime.js';

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

/** Run one scripted PI turn through the legacy pooled surface and collect its normalized events. */
async function driveSpawn(
  fake: FakeRuntimeFactory, adapter: PIAdapter, sessionKey: string,
  script: (runtime: FakeRuntime) => void,
): Promise<{ events: NormalizedEvent[]; result: AgentResult }> {
  const proc = piPool(adapter).spawn(spec(sessionKey));
  const events = collect(proc.events);
  const runtime = await fake.runtime(0);
  const turn = proc.send({ text: 'opening' });
  void turn.catch(() => undefined);
  await runtime.nextCall('prompt');
  script(runtime);
  const result = await turn;
  return { events: await events, result };
}

test('open().run() yields the same phased events, in order, as spawn().send()', async (t) => {
  const sessionKey = 'pi-engine-parity';
  const script = (runtime: FakeRuntime): void => {
    runtime.emitSimpleTurn('hello', { usage: { cost: { total: 0.02 } } });
  };

  const spawnFake = makeFakeRuntimeFactory();
  const spawnAdapter = new PIAdapter(spawnFake.factory);
  const spawn = await driveSpawn(spawnFake, spawnAdapter, sessionKey, script);

  const engineFake = makeFakeRuntimeFactory();
  const engineAdapter = new PIAdapter(engineFake.factory);
  const engine = engineAdapter.open(spec(sessionKey));
  const run = engine.run({ text: 'opening' }, { awaitBackground: 'none' });
  const engineRuntime = await engineFake.runtime(0);
  await engineRuntime.nextCall('prompt');
  script(engineRuntime);
  const engineResult = await run.result;
  const engineEvents = await collect(run.events);

  t.onTestFinished(async () => { await Promise.allSettled([piPool(spawnAdapter).close(sessionKey), engine.close()]); });

  const expected = [...spawn.events.map((event) => toRunEvent(event, 'foreground')), DONE];
  assert.deepEqual(engineEvents, expected);
  assert.deepEqual(engineResult, spawn.result);
});

test('open().run() rejects a failed turn exactly as spawn().send() does', async (t) => {
  const sessionKey = 'pi-engine-fail';
  const script = (runtime: FakeRuntime): void => {
    runtime.emitAgentStart();
    runtime.emitAgentEnd({ stopReason: 'error', errorMessage: 'boom' });
  };

  const spawnFake = makeFakeRuntimeFactory();
  const spawnAdapter = new PIAdapter(spawnFake.factory);
  const proc = piPool(spawnAdapter).spawn(spec(sessionKey));
  const spawnRuntime = await spawnFake.runtime(0);
  const spawnTurn = proc.send({ text: 'opening' });
  await spawnRuntime.nextCall('prompt');
  script(spawnRuntime);
  const spawnError = await spawnTurn.then(
    () => assert.fail('spawn turn must reject'),
    (error: Error) => error,
  );

  const engineFake = makeFakeRuntimeFactory();
  const engineAdapter = new PIAdapter(engineFake.factory);
  const engine = engineAdapter.open(spec(sessionKey));
  const run = engine.run({ text: 'opening' }, { awaitBackground: 'none' });
  const engineRuntime = await engineFake.runtime(0);
  await engineRuntime.nextCall('prompt');
  script(engineRuntime);
  const engineError = await run.result.then(
    () => assert.fail('engine run must reject'),
    (error: Error) => error,
  );

  t.onTestFinished(async () => { await Promise.allSettled([piPool(spawnAdapter).close(sessionKey), engine.close()]); });

  assert.equal(engineError.message, spawnError.message);
  assert.equal(
    (engineError as Error & { reason?: string }).reason,
    (spawnError as Error & { reason?: string }).reason,
  );
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
