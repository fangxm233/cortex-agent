// input:  PIAdapter over the fake PI runtime in tests/agent-adapter/pi-fake-runtime.ts
// output: PI run-phase regression: steer form per loop state, deferred turn_complete, refusal acks, session_started placement
// pos:    PI backend run-phase fixture (plan §9.2 P0.2), freezing today's behaviour before Phase 1.8/2.2
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { engineSpecFixture, type EngineSpecFixtureInput } from '../engine-spec-fixture.js';


import { test } from 'vitest';
import assert from 'node:assert/strict';

import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import type { AgentProcess, InjectionAckSink } from '../../src/agent-adapter/types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import {
  makeFakeRuntimeFactory, type FakeRuntime, type FakeRuntimeFactory, type FakeSessionCall,
} from './pi-fake-runtime.js';

type ErrorEvent = Extract<NormalizedEvent, { type: 'error' }>;
type TerminalEvent = Extract<NormalizedEvent, { type: 'turn_complete' }>;

interface Fixture {
  adapter: PIAdapter;
  fake: FakeRuntimeFactory;
  proc: AgentProcess;
  runtime: FakeRuntime;
}

function spawnConfig(sessionKey: string): EngineSpecFixtureInput {
  return { sessionId: null, sessionKey, resume: false };
}

/** One spawned PI process with its runtime already resolved, so `send` dispatches at once. */
async function spawnProcess(sessionKey: string): Promise<Fixture> {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn(engineSpecFixture(spawnConfig(sessionKey)));
  const runtime = await fake.runtime(0);
  return { adapter, fake, proc, runtime };
}

/**
 * Open a turn and wait until its prompt reached PI: injections before that are refused by design.
 * The turn promise is boxed so awaiting this helper does not await the turn itself.
 */
async function openTurn(fixture: Fixture, text = 'opening'): Promise<{ turn: Promise<AgentResult> }> {
  const turn = fixture.proc.send({ text });
  void turn.catch(() => undefined);
  await fixture.runtime.nextCall('prompt');
  return { turn };
}

/** Next lifecycle event on the process stream; per-message cost and context readings are skipped. */
async function nextEvent(proc: AgentProcess): Promise<NormalizedEvent | undefined> {
  const iterator = proc.events[Symbol.asyncIterator]();
  for (;;) {
    const result = await iterator.next();
    if (result.done) return undefined;
    if (result.value.type !== 'cost_record' && result.value.type !== 'context_usage') return result.value;
  }
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

/** Consume one process's whole event stream in the background; `done` resolves when it closes. */
function collect(proc: AgentProcess): { events: NormalizedEvent[]; done: Promise<void> } {
  const events: NormalizedEvent[] = [];
  const done = (async () => {
    for await (const event of proc.events) events.push(event);
  })();
  return { events, done };
}

/** Flush every microtask queued by an emit before the assertions run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function errorEvents(events: NormalizedEvent[]): ErrorEvent[] {
  return events.filter((event): event is ErrorEvent => event.type === 'error');
}

function terminals(events: NormalizedEvent[]): TerminalEvent[] {
  return events.filter((event): event is TerminalEvent => event.type === 'turn_complete');
}

/** Resolves to a getter for whether the turn promise has already settled. */
function trackSettled(turn: Promise<AgentResult>): () => boolean {
  let settled = false;
  void turn.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

interface AckSink extends InjectionAckSink {
  delivered: string[];
  undelivered: string[];
}

function ackSink(): AckSink {
  const delivered: string[] = [];
  const undelivered: string[] = [];
  return {
    delivered,
    undelivered,
    onDelivered: ({ text }) => delivered.push(text),
    onUndelivered: ({ text }) => undelivered.push(text),
  };
}

test('a steer while PI is still in preflight takes the dedicated steer call', async (t) => {
  const fixture = await spawnProcess('pi-phases-preflight');
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const sink = ackSink();
  proc.setInjectionAckSink?.(sink);
  const { turn } = await openTurn(fixture);

  // PI has the opening prompt but has not entered its agent loop, so its own run flag is still
  // clear: only the dedicated steer call survives that window, and the loop's opening steering
  // poll is what drains it into the turn.
  assert.equal(proc.injectUserMessage?.({ text: 'preflight steer' }), true);
  assert.deepEqual(steeringForms(runtime), ['steer']);
  assert.match(runtime.steers()[0]!, /preflight steer/);

  runtime.emitAgentStart();
  assert.deepEqual(sink.delivered, [], 'a preflight steer is not delivered before the loop opens');
  runtime.emitUserMessage('preflight steer');
  assert.deepEqual(sink.delivered, ['preflight steer']);

  settleRun(runtime, 0.01);
  await turn;
});

test("a steer while PI's loop runs takes prompt with streamingBehavior=steer", async (t) => {
  const fixture = await spawnProcess('pi-phases-running');
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const { turn } = await openTurn(fixture);
  runtime.emitAgentStart();

  assert.equal(proc.injectUserMessage?.({ text: 'while running' }), true);
  const [call] = steeringCalls(runtime);
  assert.ok(call && call.kind === 'prompt', 'the running loop is steered with a streaming prompt');
  assert.equal(call.options?.streamingBehavior, 'steer');
  assert.deepEqual(runtime.steers(), [], 'the dedicated call is only for the preflight window');

  runtime.emitUserMessage('while running');
  settleRun(runtime, 0.01);
  await turn;
});

test('a steer after PI settled reopens with prompt+steer, and the fresh preflight takes steer', async (t) => {
  const fixture = await spawnProcess('pi-phases-idle');
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const { turn } = await openTurn(fixture);
  runtime.emitAgentStart();

  assert.equal(proc.injectUserMessage?.({ text: 'while running' }), true);
  // PI settles its low-level run while that steer is still undelivered, so it is provably idle
  // again: the next message must be a prompt to reopen a turn ...
  settleRun(runtime, 0.02);
  assert.equal(proc.injectUserMessage?.({ text: 'reopens the turn' }), true);
  // ... and the one after that lands in the reopened turn's preflight, which is only safe as steer.
  assert.equal(proc.injectUserMessage?.({ text: 'rides the new preflight' }), true);
  assert.deepEqual(steeringForms(runtime), ['prompt+steer', 'prompt+steer', 'steer']);

  runtime.emitUserMessage('while running');
  runtime.emitUserMessage('reopens the turn');
  runtime.emitUserMessage('rides the new preflight');
  settleRun(runtime, 0.03);

  const result = await turn;
  assert.equal(result.num_turns, 2);
  assert.equal(result.total_cost_usd, 0.05);
});

test('a turn_complete is deferred while a steering message is still undelivered', async (t) => {
  const fixture = await spawnProcess('pi-phases-deferred');
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const { events, done } = collect(proc);
  const { turn } = await openTurn(fixture);
  const settled = trackSettled(turn);

  runtime.emitAgentStart();
  assert.equal(proc.injectUserMessage?.({ text: 'late steer' }), true);
  settleRun(runtime, 0.02);
  await tick();

  assert.equal(settled(), false, 'a settled PI run cannot close Cortex while a steer is pending');
  assert.deepEqual(terminals(events), [], 'the terminal event is withheld until the steer lands');

  runtime.emitUserMessage('late steer');
  settleRun(runtime, 0.03);
  const result = await turn;
  await done;

  assert.equal(result.num_turns, 2);
  assert.equal(result.total_cost_usd, 0.05);
  const [terminal, ...rest] = terminals(events);
  assert.deepEqual(rest, [], 'the deferred terminal is emitted exactly once');
  assert.equal(terminal?.numTurns, 2);
  assert.equal(terminal?.totalCostUsd, 0.05);
});

test('a refused steer reports error{fatal:false} and seals the message as undelivered', async (t) => {
  const fixture = await spawnProcess('pi-phases-refused-steer');
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const sink = ackSink();
  proc.setInjectionAckSink?.(sink);
  const { events, done } = collect(proc);
  const { turn } = await openTurn(fixture);
  runtime.emitAgentStart();

  runtime.promptRejections.push(new Error('prompt rejected'));
  assert.equal(proc.injectUserMessage?.({ text: 'refused steer' }), true);
  // The refusal lands a microtask later, i.e. after PI already settled this run.
  settleRun(runtime, 0.02);
  await tick();

  const result = await turn;
  await done;

  assert.deepEqual(sink.delivered, [], 'a refused steer is never delivered');
  assert.deepEqual(sink.undelivered, ['refused steer']);
  assert.equal(result.num_turns, 1);
  assert.equal(result.total_cost_usd, 0.02);

  const [refusal, ...extraErrors] = errorEvents(events);
  assert.deepEqual(extraErrors, []);
  assert.equal(refusal?.fatal, false, 'a refused injection stays non-fatal on the turn stream');
  assert.equal(refusal?.message, 'injection refused: prompt rejected');
  assert.equal(terminals(events).length, 1, 'the deferred terminal is restored once the steer is sealed');
});

test('a refused steer during the preflight window keeps its turn open', async (t) => {
  const fixture = await spawnProcess('pi-phases-refused-preflight');
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const sink = ackSink();
  proc.setInjectionAckSink?.(sink);
  const { events, done } = collect(proc);
  // Still in the preflight window: this steer is the dedicated call, not a streaming prompt.
  const { turn } = await openTurn(fixture);

  runtime.steerRejections.push(new Error('steer rejected'));
  assert.equal(proc.injectUserMessage?.({ text: 'refused preflight steer' }), true);
  assert.deepEqual(steeringForms(runtime), ['steer']);
  await tick();

  assert.deepEqual(sink.undelivered, ['refused preflight steer']);
  assert.deepEqual(errorEvents(events).map((event) => event.fatal), [false]);
  assert.deepEqual(terminals(events), [], 'nothing terminal is reported before PI ends its run');

  settleRun(runtime, 0.02);
  const result = await turn;
  await done;

  assert.equal(result.num_turns, 1);
  assert.equal(terminals(events).length, 1, "the turn still ends on PI's own terminal event");
});

test('session_started lands on the stream of the first turn, never on a reused one', async (t) => {
  const fixture = await spawnProcess('pi-phases-session-start');
  const { adapter, fake, proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());

  // Runtime creation is asynchronous and no prompt has been sent yet, yet the announcement is
  // already waiting on the stream the first spawn opened.
  const announced = await nextEvent(proc);
  assert.deepEqual(runtime.calls, [], 'nothing was asked of PI before the announcement');
  assert.equal(announced?.type, 'session_started');
  if (announced?.type !== 'session_started') assert.fail('the first turn must be announced');
  assert.equal(announced.sessionId, runtime.sessionId);
  assert.equal(announced.sessionFile, runtime.sessionFile);

  const turn = proc.send({ text: 'first' });
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAssistantText('first reply');
  settleRun(runtime, 0.01);
  await turn;

  // A second spawn reuses the pooled runtime, so its stream starts at PI's own events: the
  // announcement belongs to the stream that was open when the runtime was created.
  const second = adapter.spawn(engineSpecFixture(spawnConfig('pi-phases-session-start')));
  t.onTestFinished(() => second.close());
  const reused = collect(second);
  const secondTurn = second.send({ text: 'second' });
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAssistantText('second reply');
  settleRun(runtime, 0.01);
  await secondTurn;
  await reused.done;

  assert.equal(fake.runtimes.length, 1, 'the second turn reused the pooled PI runtime');
  assert.equal(reused.events.some((event) => event.type === 'session_started'), false);
});
