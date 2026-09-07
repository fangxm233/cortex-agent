// input:  PIAdapter over the fake PI runtime, temp session files
// output: PI switch guard, steering form, FIFO ack, rejection, and failure guarantees
// pos:    PI backend mid-turn injection wiring regression
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import type { AgentProcess } from '../../src/agent-adapter/types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import {
  makeFakeRuntimeFactory, type FakeRuntime, type FakeRuntimeFactoryOptions, type FakeSessionCall,
} from './pi-fake-runtime.js';

interface Fixture {
  adapter: PIAdapter;
  proc: AgentProcess;
  runtime: FakeRuntime;
}

interface SwitchingFixture {
  adapter: PIAdapter;
  first: AgentProcess;
  second: AgentProcess;
  firstRuntime: FakeRuntime;
  sessionDir: string;
}

let counter = 0;

/** One spawned PI process with its runtime already resolved, so `send` dispatches at once. */
async function spawnProcess(options: FakeRuntimeFactoryOptions = {}): Promise<Fixture> {
  const fake = makeFakeRuntimeFactory(options);
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({ sessionId: null, sessionKey: `pi-inject-${counter++}`, resume: false });
  const runtime = await fake.runtime(0);
  return { adapter, proc, runtime };
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

/** Every steering call after the opening prompt: prompt+steer forms and dedicated steers alike. */
function steeringCalls(runtime: FakeRuntime): FakeSessionCall[] {
  return runtime.calls.filter((call) =>
    (call.kind === 'prompt' && call.options?.streamingBehavior === 'steer') || call.kind === 'steer');
}

function settleRun(runtime: FakeRuntime, cost: number): void {
  runtime.emitAgentEnd({ usage: { cost: { total: cost } } });
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

async function spawnSwitchingFixture(): Promise<SwitchingFixture> {
  const sessionDir = mkdtempSync(join(tmpdir(), 'cortex-pi-switch-'));
  writeFileSync(join(sessionDir, 'session-a.jsonl'), '{}\n');
  writeFileSync(join(sessionDir, 'session-b.jsonl'), '{}\n');
  const fake = makeFakeRuntimeFactory({ sessionIds: ['session-a', 'session-b'] });
  const adapter = new PIAdapter(fake.factory, sessionDir);
  const first = adapter.spawn({ sessionId: null, sessionKey: 'pi-switch-first', resume: false });
  const second = adapter.spawn({ sessionId: null, sessionKey: 'pi-switch-second', resume: false });
  const [firstRuntime] = await Promise.all([fake.runtime(0), fake.runtime(1)]);
  return { adapter, first, second, firstRuntime, sessionDir };
}

async function cleanupSwitchingFixture(fixture: SwitchingFixture): Promise<void> {
  try {
    await Promise.all([fixture.first.close(), fixture.second.close()]);
  } finally {
    rmSync(fixture.sessionDir, { recursive: true, force: true });
  }
}

test('injectUserMessage refuses an idle PI session without touching the runtime', async (t) => {
  const fixture = await spawnProcess();
  t.onTestFinished(() => fixture.proc.close());

  assert.equal(fixture.proc.injectUserMessage?.({ text: 'steer me' }), false);
  assert.deepEqual(fixture.runtime.calls, []);
});

test('injection refuses while sendTurn is still switching to the target session', async (t) => {
  const fixture = await spawnSwitchingFixture();
  const { adapter, first, firstRuntime } = fixture;
  t.onTestFinished(() => cleanupSwitchingFixture(fixture));

  assert.deepEqual(await adapter.switchSession('session-b', 'pi-switch-first'), { ok: true, cancelled: false });

  let releaseSwitch = (): void => undefined;
  firstRuntime.switchGate = new Promise<void>((resolve) => { releaseSwitch = resolve; });
  const turn = first.send({ text: 'opening after switch-back' });
  void turn.catch(() => undefined);
  await Promise.resolve();
  assert.equal(firstRuntime.calls.at(-1)?.kind, 'switch', 'the turn first switches back to its own transcript');
  assert.equal(first.injectUserMessage?.({ text: 'too early' }), false);

  releaseSwitch();
  await firstRuntime.nextCall('prompt');
  assert.equal(first.injectUserMessage?.({ text: 'now safe' }), true);

  firstRuntime.emitUserMessage('opening after switch-back');
  firstRuntime.emitUserMessage('now safe');
  settleRun(firstRuntime, 0.01);
  await turn;
});

test('a prompt still in PI preflight is steered with the dedicated steer call', async (t) => {
  const fixture = await spawnProcess();
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const delivered: string[] = [];
  proc.setInjectionAckSink?.({ onDelivered: ({ text }) => delivered.push(text) });
  const { turn } = await openTurn(fixture);

  // PI has the opening prompt but has not entered its agent loop, so it still reads its own run
  // flag as inactive: a streaming prompt would be dropped and poison every later injection.
  assert.equal(proc.injectUserMessage?.({ text: 'during preflight' }), true);
  const [call] = steeringCalls(runtime);
  assert.equal(call?.kind, 'steer');
  assert.match(runtime.steers()[0]!, /during preflight/);

  runtime.emitAgentStart();
  runtime.emitUserMessage('during preflight');
  assert.deepEqual(delivered, ['during preflight'], 'the loop opening poll drains it into the turn');

  settleRun(runtime, 0.01);
  await turn;
});

test('an injection reopening a settled PI turn steers its own follow-on preflight', async (t) => {
  const fixture = await spawnProcess();
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const { turn } = await openTurn(fixture);

  runtime.emitAgentStart();
  proc.injectUserMessage?.({ text: 'while running' });
  settleRun(runtime, 0.01);

  // PI is provably idle now, so this one has to be a prompt to reopen a turn -- and the next one
  // lands in that fresh preflight, which is only safe as a steer.
  proc.injectUserMessage?.({ text: 'reopens the turn' });
  proc.injectUserMessage?.({ text: 'rides the new preflight' });
  assert.deepEqual(steeringCalls(runtime).map((call) => call.kind), ['prompt', 'prompt', 'steer']);

  runtime.emitAgentStart();
  runtime.emitUserMessage('while running');
  runtime.emitUserMessage('reopens the turn');
  runtime.emitUserMessage('rides the new preflight');
  settleRun(runtime, 0.02);
  await turn;
});

test('a rejected steer call seals its message just like a rejected prompt', async (t) => {
  const fixture = await spawnProcess();
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const undelivered: string[] = [];
  proc.setInjectionAckSink?.({
    onDelivered: () => assert.fail('rejected steering must not be delivered'),
    onUndelivered: ({ text }) => undelivered.push(text),
  });
  const { turn } = await openTurn(fixture);

  runtime.steerRejections.push(new Error('steer rejected'));
  proc.injectUserMessage?.({ text: 'rejected steer' });
  assert.equal(steeringCalls(runtime)[0]?.kind, 'steer');
  await Promise.resolve();
  assert.deepEqual(undelivered, ['rejected steer']);

  runtime.emitAgentStart();
  settleRun(runtime, 0.01);
  await turn;
});

test('active PI turn injects an attachment-aware prompt with streamingBehavior=steer', async (t) => {
  const fixture = await spawnProcess();
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const { turn } = await openTurn(fixture);
  runtime.emitAgentStart();

  assert.equal(proc.injectUserMessage?.({
    text: 'inspect this',
    attachments: [{ mimeType: 'image/png', path: '/tmp/frame.png' }],
  }), true);

  const [call] = steeringCalls(runtime);
  assert.ok(call && call.kind === 'prompt', 'one steering prompt is queued');
  assert.equal(call.options?.streamingBehavior, 'steer');
  assert.match(call.text, /inspect this/);
  assert.match(call.text, /\/tmp\/frame\.png/);

  runtime.emitUserMessage('inspect this');
  settleRun(runtime, 0.01);
  await turn;
});

test('opening user event is ignored, then steering messages ack FIFO including duplicate text', async (t) => {
  const fixture = await spawnProcess();
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const delivered: Array<{ text: string; foldedIntoTurn: boolean }> = [];
  proc.setInjectionAckSink?.({ onDelivered: (message) => delivered.push(message) });
  const { turn } = await openTurn(fixture);
  runtime.emit({ type: 'agent_start' });

  proc.injectUserMessage?.({ text: 'same' });
  proc.injectUserMessage?.({ text: 'same' });
  runtime.emitUserMessage('opening');
  assert.deepEqual(delivered, [], 'the external turn opening prompt is not a steering ack');

  runtime.emitUserMessage('transformed-by-pi');
  runtime.emitUserMessage('transformed-by-pi');
  assert.deepEqual(delivered, [
    { text: 'same', foldedIntoTurn: true },
    { text: 'same', foldedIntoTurn: true },
  ]);

  settleRun(runtime, 0.01);
  await turn;
});

test('a later rejected duplicate waits for the earlier duplicate delivery before sealing FIFO', async (t) => {
  const fixture = await spawnProcess();
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const lifecycle: string[] = [];
  proc.setInjectionAckSink?.({
    onDelivered: ({ text }) => lifecycle.push(`delivered:${text}`),
    onUndelivered: ({ text }) => lifecycle.push(`undelivered:${text}`),
  });
  const { turn } = await openTurn(fixture);
  runtime.emit({ type: 'agent_start' });

  proc.injectUserMessage?.({ text: 'same' });
  runtime.promptRejections.push(new Error('second rejected'));
  proc.injectUserMessage?.({ text: 'same' });
  runtime.emitUserMessage('opening');
  await Promise.resolve();
  assert.deepEqual(lifecycle, [], 'second duplicate cannot seal ahead of the first');

  runtime.emitUserMessage('same');
  assert.deepEqual(lifecycle, ['delivered:same', 'undelivered:same']);
  settleRun(runtime, 0.01);
  await turn;
});

test('post-run compaction stays active until agent_settled and aggregates both PI runs', async (t) => {
  const fixture = await spawnProcess();
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const { turn } = await openTurn(fixture);
  let settled = false;
  void turn.finally(() => { settled = true; });

  runtime.emitUserMessage('opening');
  runtime.emitAgentEnd({ usage: { cost: { total: 0.02 } }, settle: false });
  await Promise.resolve();
  assert.equal(settled, false, 'low-level agent_end is not a Cortex terminal event');

  runtime.emit({ type: 'compaction_start', reason: 'threshold' });
  runtime.emit({ type: 'compaction_end' });
  runtime.emitAgentEnd({ usage: { cost: { total: 0.03 } }, settle: false });
  await Promise.resolve();
  assert.equal(settled, false, 'compaction continuation remains inside the active turn');

  runtime.emit({ type: 'agent_settled' });
  const result = await turn;
  assert.equal(result.num_turns, 2);
  assert.equal(result.total_cost_usd, 0.05);
});

test('idle-boundary first agent_end is suppressed and final result aggregates both PI runs', async (t) => {
  const fixture = await spawnProcess();
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const delivered: string[] = [];
  proc.setInjectionAckSink?.({ onDelivered: ({ text }) => delivered.push(text) });
  const { turn } = await openTurn(fixture);
  let settled = false;
  void turn.finally(() => { settled = true; });

  runtime.emitAgentStart();
  proc.injectUserMessage?.({ text: 'late steering' });
  settleRun(runtime, 0.02);
  await Promise.resolve();
  assert.equal(settled, false, 'the old run cannot terminate Cortex while its race-safe prompt is pending');

  runtime.emitUserMessage('late steering');
  settleRun(runtime, 0.03);
  const result = await turn;
  assert.deepEqual(delivered, ['late steering']);
  assert.equal(result.num_turns, 2);
  assert.equal(result.total_cost_usd, 0.05);

  assert.equal((await nextEvent(proc))?.type, 'session_started');
  const terminal = await nextEvent(proc);
  assert.equal(terminal?.type, 'turn_complete');
  if (terminal?.type === 'turn_complete') {
    assert.equal(terminal.numTurns, 2);
    assert.equal(terminal.totalCostUsd, 0.05);
  }
});

test('a refused steering prompt after a deferred completion seals the message and settles the original turn', async (t) => {
  const fixture = await spawnProcess();
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const undelivered: string[] = [];
  proc.setInjectionAckSink?.({
    onDelivered: () => assert.fail('rejected steering must not be delivered'),
    onUndelivered: ({ text }) => undelivered.push(text),
  });
  const { turn } = await openTurn(fixture);

  runtime.emitAgentStart();
  runtime.promptRejections.push(new Error('prompt rejected'));
  proc.injectUserMessage?.({ text: 'rejected steering' });
  // The refusal lands a microtask later, i.e. after PI already settled this run.
  settleRun(runtime, 0.02);

  const result = await turn;
  assert.deepEqual(undelivered, ['rejected steering']);
  assert.equal(result.num_turns, 1);
  assert.equal(result.total_cost_usd, 0.02);

  assert.equal((await nextEvent(proc))?.type, 'session_started');
  const refusal = await nextEvent(proc);
  assert.equal(refusal?.type, 'error', 'PI rejection remains observable');
  if (refusal?.type === 'error') {
    assert.equal(refusal.fatal, false);
    assert.match(refusal.message, /prompt rejected/);
  }
  assert.equal((await nextEvent(proc))?.type, 'turn_complete', 'deferred terminal event is restored');
});

test('a failing opening prompt reports every queued steering message as undelivered', async (t) => {
  const fixture = await spawnProcess({ holdPrompts: true });
  const { proc, runtime } = fixture;
  t.onTestFinished(() => proc.close());
  const undelivered: string[] = [];
  proc.setInjectionAckSink?.({
    onDelivered: () => assert.fail('a failed run cannot deliver'),
    onUndelivered: ({ text }) => undelivered.push(text),
  });
  const { turn } = await openTurn(fixture);

  proc.injectUserMessage?.({ text: 'one' });
  proc.injectUserMessage?.({ text: 'two' });
  runtime.heldPrompts[0]!.reject(new Error('backend exited'));

  await assert.rejects(turn, /backend exited/);
  assert.deepEqual(undelivered, ['one', 'two']);
  assert.equal(proc.injectUserMessage?.({ text: 'after failure' }), false);
});
