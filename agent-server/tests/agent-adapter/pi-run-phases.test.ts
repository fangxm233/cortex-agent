// input:  PIAdapter over the fake PI runtime in tests/agent-adapter/pi-fake-runtime.ts
// output: PI run-phase regression: steer form per loop state, deferred foreground result, injection
//         acks, session_started placement
// pos:    PI backend run-phase fixture (plan §9.2 P0.2), now driven through the EngineSession seam
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { engineSpecFixture, type EngineSpecFixtureInput } from '../engine-spec-fixture.js';


import { test } from 'vitest';
import assert from 'node:assert/strict';

import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { piPool } from './pi-pool-fixture.js';
import type { PIEngineSession } from '../../src/agent-adapter/pi/engine.js';
import type { EngineRun } from '../../src/agent-adapter/types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import {
  makeFakeRuntimeFactory, type FakeRuntime, type FakeRuntimeFactory, type FakeSessionCall,
} from './pi-fake-runtime.js';

type ErrorEvent = Extract<RunEvent, { type: 'error' }>;
type ResultEvent = Extract<RunEvent, { type: 'foreground_result' | 'background_result' }>;
type InjectionEvent = Extract<RunEvent, { type: 'injection_delivered' | 'injection_rejected' }>;
type DonePhase = Extract<RunEvent, { type: 'phase' }>;

interface Fixture {
  adapter: PIAdapter;
  fake: FakeRuntimeFactory;
  engine: PIEngineSession;
  runtime: FakeRuntime;
}

function phaseSpec(sessionKey: string): EngineSpecFixtureInput {
  return { sessionId: null, sessionKey, resume: false };
}

/** One pooled PI engine with its runtime already resolved, so `run` dispatches at once. */
async function openSession(sessionKey: string): Promise<Fixture> {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const engine = piPool(adapter).open(engineSpecFixture(phaseSpec(sessionKey)));
  const runtime = await fake.runtime(0);
  return { adapter, fake, engine, runtime };
}

/**
 * Open a run and wait until its prompt reached PI: injections before that are refused by design.
 * The returned run is boxed so awaiting this helper does not await the run itself.
 */
async function openTurn(fixture: Fixture, text = 'opening'): Promise<EngineRun> {
  const run = fixture.engine.run({ text }, { awaitBackground: 'none' });
  void run.result.catch(() => undefined);
  await fixture.runtime.nextCall('prompt');
  return run;
}

/** Every steering SDK call made after the opening prompt, in call order. */
function steeringCalls(runtime: FakeRuntime): FakeSessionCall[] {
  return runtime.calls.filter((call) =>
    call.kind === 'steer' || (call.kind === 'prompt' && call.options?.streamingBehavior === 'steer'));
}

/** The SDK form each steering call took: the dedicated call, or the streaming prompt. */
function steeringForms(runtime: FakeRuntime): string[] {
  return steeringCalls(runtime).map((call) => (call.kind === 'steer' ? 'steer' : 'prompt+steer'));
}

function settleRun(runtime: FakeRuntime, cost: number): void {
  runtime.emitAgentEnd({ usage: { cost: { total: cost } } });
}

/** Consume one run's whole event stream in the background; `done` resolves when it closes. */
function collect(run: EngineRun): { events: RunEvent[]; done: Promise<void> } {
  const events: RunEvent[] = [];
  const done = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  return { events, done };
}

/** Flush every microtask queued by an emit before the assertions run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function errorEvents(events: RunEvent[]): ErrorEvent[] {
  return events.filter((event): event is ErrorEvent => event.type === 'error');
}

/** The run stream's own terminal results. The engine drops `turn_complete`; it maps onto these. */
function results(events: RunEvent[]): ResultEvent[] {
  return events.filter((event): event is ResultEvent =>
    event.type === 'foreground_result' || event.type === 'background_result');
}

/** The run stream's terminal marker, pushed exactly once when the whole run has ended. */
function donePhases(events: RunEvent[]): DonePhase[] {
  return events.filter((event): event is DonePhase =>
    event.type === 'phase' && event.phase === 'done');
}

/** Injection lifecycle acks, which replaced the legacy `InjectionAckSink` arrays. */
function injectionEvents(events: RunEvent[]): InjectionEvent[] {
  return events.filter((event): event is InjectionEvent =>
    event.type === 'injection_delivered' || event.type === 'injection_rejected');
}

/** Resolves to a getter for whether the foreground result promise has already settled. */
function trackSettled(result: Promise<AgentResult>): () => boolean {
  let settled = false;
  void result.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

test('a steer while PI is still in preflight takes the dedicated steer call', async (t) => {
  const fixture = await openSession('pi-phases-preflight');
  const { engine, runtime } = fixture;
  t.onTestFinished(() => engine.close());
  const run = await openTurn(fixture);
  const { events, done } = collect(run);

  // PI has the opening prompt but has not entered its agent loop, so its own run flag is still
  // clear: only the dedicated steer call survives that window, and the loop's opening steering
  // poll is what drains it into the turn.
  const steer = engine.steer({ text: 'preflight steer' });
  assert.equal(steer.accepted, true);
  assert.deepEqual(steeringForms(runtime), ['steer']);
  assert.match(runtime.steers()[0]!, /preflight steer/);

  runtime.emitAgentStart();
  assert.deepEqual(injectionEvents(events), [], 'a preflight steer is not delivered before the loop opens');
  runtime.emitUserMessage('preflight steer');
  await tick();
  assert.deepEqual(injectionEvents(events), [
    { type: 'injection_delivered', injectionId: steer.injectionId, foldedIntoTurn: true },
  ]);

  settleRun(runtime, 0.01);
  await run.result;
  await done;
});

test("a steer while PI's loop runs takes prompt with streamingBehavior=steer", async (t) => {
  const fixture = await openSession('pi-phases-running');
  const { engine, runtime } = fixture;
  t.onTestFinished(() => engine.close());
  const run = await openTurn(fixture);
  runtime.emitAgentStart();

  const steer = engine.steer({ text: 'while running' });
  assert.equal(steer.accepted, true);
  const [call] = steeringCalls(runtime);
  assert.ok(call && call.kind === 'prompt', 'the running loop is steered with a streaming prompt');
  assert.equal(call.options?.streamingBehavior, 'steer');
  assert.deepEqual(runtime.steers(), [], 'the dedicated call is only for the preflight window');

  runtime.emitUserMessage('while running');
  settleRun(runtime, 0.01);
  await run.result;
});

test('a steer after PI settled reopens with prompt+steer, and the fresh preflight takes steer', async (t) => {
  const fixture = await openSession('pi-phases-idle');
  const { engine, runtime } = fixture;
  t.onTestFinished(() => engine.close());
  const run = await openTurn(fixture);
  runtime.emitAgentStart();

  assert.equal(engine.steer({ text: 'while running' }).accepted, true);
  // PI settles its low-level run while that steer is still undelivered, so it is provably idle
  // again: the next message must be a prompt to reopen a turn ...
  settleRun(runtime, 0.02);
  assert.equal(engine.steer({ text: 'reopens the turn' }).accepted, true);
  // ... and the one after that lands in the reopened turn's preflight, which is only safe as steer.
  assert.equal(engine.steer({ text: 'rides the new preflight' }).accepted, true);
  assert.deepEqual(steeringForms(runtime), ['prompt+steer', 'prompt+steer', 'steer']);

  runtime.emitUserMessage('while running');
  runtime.emitUserMessage('reopens the turn');
  runtime.emitUserMessage('rides the new preflight');
  settleRun(runtime, 0.03);

  const result = await run.result;
  assert.equal(result.num_turns, 2);
  assert.equal(result.total_cost_usd, 0.05);
});

test('a turn_complete is deferred while a steering message is still undelivered', async (t) => {
  const fixture = await openSession('pi-phases-deferred');
  const { engine, runtime } = fixture;
  t.onTestFinished(() => engine.close());
  const run = await openTurn(fixture);
  const { events, done } = collect(run);
  const settled = trackSettled(run.result);

  runtime.emitAgentStart();
  assert.equal(engine.steer({ text: 'late steer' }).accepted, true);
  settleRun(runtime, 0.02);
  await tick();

  assert.equal(settled(), false, 'a settled PI run cannot close Cortex while a steer is pending');
  // The engine drops the raw `turn_complete` marker; the withheld terminal work is visible as the
  // missing authoritative `foreground_result` and its trailing `done` phase.
  assert.deepEqual(results(events), [], 'the foreground result is withheld until the steer lands');
  assert.deepEqual(donePhases(events), [], 'the terminal done phase is withheld until the steer lands');

  runtime.emitUserMessage('late steer');
  settleRun(runtime, 0.03);
  const result = await run.result;
  await done;

  assert.equal(result.num_turns, 2);
  assert.equal(result.total_cost_usd, 0.05);
  const [foreground, ...restResults] = results(events);
  assert.deepEqual(restResults, [], 'the deferred result is emitted exactly once');
  assert.equal(foreground?.result.num_turns, 2);
  assert.equal(foreground?.result.total_cost_usd, 0.05);
  assert.equal(donePhases(events).length, 1, 'the run emits exactly one terminal done phase');
});

test('a refused steer reports error{fatal:false} and seals the message as undelivered', async (t) => {
  const fixture = await openSession('pi-phases-refused-steer');
  const { engine, runtime } = fixture;
  t.onTestFinished(() => engine.close());
  const run = await openTurn(fixture);
  const { events, done } = collect(run);
  runtime.emitAgentStart();

  runtime.promptRejections.push(new Error('prompt rejected'));
  const steer = engine.steer({ text: 'refused steer' });
  assert.equal(steer.accepted, true);
  // The refusal lands a microtask later, i.e. after PI already settled this run.
  settleRun(runtime, 0.02);
  await tick();

  const result = await run.result;
  await done;

  assert.deepEqual(injectionEvents(events).filter((event) => event.type === 'injection_delivered'),
    [], 'a refused steer is never delivered');
  assert.deepEqual(injectionEvents(events).filter((event) => event.type === 'injection_rejected'), [
    { type: 'injection_rejected', injectionId: steer.injectionId, reason: 'undelivered' },
  ]);
  assert.equal(result.num_turns, 1);
  assert.equal(result.total_cost_usd, 0.02);

  const [refusal, ...extraErrors] = errorEvents(events);
  assert.deepEqual(extraErrors, []);
  assert.equal(refusal?.fatal, false, 'a refused injection stays non-fatal on the turn stream');
  assert.equal(refusal?.message, 'injection refused: prompt rejected');
  assert.equal(results(events).length, 1, 'the deferred result is restored once the steer is sealed');
});

test('a refused steer during the preflight window keeps its turn open', async (t) => {
  const fixture = await openSession('pi-phases-refused-preflight');
  const { engine, runtime } = fixture;
  t.onTestFinished(() => engine.close());
  const run = await openTurn(fixture);
  const { events, done } = collect(run);

  // Still in the preflight window: this steer is the dedicated call, not a streaming prompt.
  runtime.steerRejections.push(new Error('steer rejected'));
  const steer = engine.steer({ text: 'refused preflight steer' });
  assert.equal(steer.accepted, true);
  assert.deepEqual(steeringForms(runtime), ['steer']);
  await tick();

  assert.deepEqual(injectionEvents(events).filter((event) => event.type === 'injection_rejected'), [
    { type: 'injection_rejected', injectionId: steer.injectionId, reason: 'undelivered' },
  ]);
  assert.deepEqual(errorEvents(events).map((event) => event.fatal), [false]);
  assert.deepEqual(results(events), [], 'nothing terminal is reported before PI ends its run');
  assert.deepEqual(donePhases(events), [], 'nothing terminal is reported before PI ends its run');

  settleRun(runtime, 0.02);
  const result = await run.result;
  await done;

  assert.equal(result.num_turns, 1);
  assert.equal(results(events).length, 1, "the turn still ends on PI's own terminal result");
  assert.equal(donePhases(events).length, 1, "the turn still ends on PI's own terminal marker");
});

test('session_started lands on the stream of the first turn, never on a reused one', async (t) => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const key = 'pi-phases-session-start';
  const engine = piPool(adapter).open(engineSpecFixture(phaseSpec(key)));
  t.onTestFinished(() => engine.close());

  // Runtime creation is asynchronous and the run opens its turn stream synchronously, before the
  // runtime resolves, so the announcement is already waiting on the stream the first run opened.
  // The raw tap is what preserves the wire-level `session_started` (the run stream translates it
  // to `engine_started`), and reading the call log inside the tap is what proves it is announced
  // before PI is asked for anything.
  const runtime = fake.runtimes[0]!;
  const firstPrompt = runtime.nextCall('prompt');
  const firstRaw: NormalizedEvent[] = [];
  let callsWhenAnnounced = -1;
  const first = engine.run({ text: 'first' }, {
    awaitBackground: 'none',
    onNormalizedEvent: (event) => {
      firstRaw.push(event);
      if (event.type === 'session_started') callsWhenAnnounced = runtime.calls.length;
    },
  });
  void first.result.catch(() => undefined);
  await firstPrompt;

  assert.equal(callsWhenAnnounced, 0, 'nothing was asked of PI before the announcement');
  const announced = firstRaw.find((event) => event.type === 'session_started');
  assert.ok(announced && announced.type === 'session_started', 'the first turn must be announced');
  if (announced?.type !== 'session_started') assert.fail('the first turn must be announced');
  assert.equal(announced.sessionId, runtime.sessionId);
  assert.equal(announced.sessionFile, runtime.sessionFile);

  runtime.emitAgentStart();
  runtime.emitAssistantText('first reply');
  settleRun(runtime, 0.01);
  await first.result;

  // A second run reuses the pooled runtime, so its stream starts at PI's own events: the
  // announcement belongs to the stream that was open when the runtime was created.
  const secondRaw: NormalizedEvent[] = [];
  const second = piPool(adapter).open(engineSpecFixture(phaseSpec(key))).run(
    { text: 'second' },
    { awaitBackground: 'none', onNormalizedEvent: (event) => secondRaw.push(event) },
  );
  void second.result.catch(() => undefined);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAssistantText('second reply');
  settleRun(runtime, 0.01);
  await second.result;

  assert.equal(fake.runtimes.length, 1, 'the second turn reused the pooled PI runtime');
  assert.equal(secondRaw.some((event) => event.type === 'session_started'), false);
});
