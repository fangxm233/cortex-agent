import { engineSpecFixture } from '../engine-spec-fixture.js';


import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { piPool } from './pi-pool-fixture.js';
import type { PIEngineSession } from '../../src/agent-adapter/pi/engine.js';
import type { EngineRun } from '../../src/agent-adapter/types.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';
import {
  makeFakeRuntimeFactory, type FakeRuntime, type FakeRuntimeFactoryOptions, type FakeSessionCall,
} from './pi-fake-runtime.js';

interface Fixture {
  adapter: PIAdapter;
  engine: PIEngineSession;
  fake: ReturnType<typeof makeFakeRuntimeFactory>;
}

interface SwitchingFixture {
  adapter: PIAdapter;
  first: PIEngineSession;
  second: PIEngineSession;
  firstRuntime: FakeRuntime;
  sessionDir: string;
}

let counter = 0;

/** One opened PI engine session; `run` is driven off `fixture.engine`, the runtime resolves lazily. */
function openEngine(options: FakeRuntimeFactoryOptions = {}): Fixture {
  const fake = makeFakeRuntimeFactory(options);
  const adapter = new PIAdapter(fake.factory);
  const engine = piPool(adapter).open(engineSpecFixture({
    sessionId: null, sessionKey: `pi-inject-${counter++}`, resume: false,
  }));
  return { adapter, engine, fake };
}

interface OpenTurn {
  run: EngineRun;
  runtime: FakeRuntime;
  events: RunEvent[];
  raw: NormalizedEvent[];
  done: Promise<void>;
}

/**
 * Open a run before the runtime resolves (so `session_started` lands on this run's stream) and wait
 * until its prompt reached PI: injections before that are refused by design. `events` collects the
 * translated RunEvents and `raw` the `onNormalizedEvent` protocol tap, both in the background;
 * `done` resolves when the run stream closes.
 */
async function openTurn(fixture: Fixture, text = 'opening'): Promise<OpenTurn> {
  const raw: NormalizedEvent[] = [];
  const run = fixture.engine.run(
    { text },
    { awaitBackground: 'none', onNormalizedEvent: (event) => raw.push(event) },
  );
  void run.result.catch(() => undefined);
  const events: RunEvent[] = [];
  const done = (async () => { for await (const event of run.events) events.push(event); })();
  const runtime = await fixture.fake.runtime(0);
  await runtime.nextCall('prompt');
  return { run, runtime, events, raw, done };
}

/** Every steering call after the opening prompt: prompt+steer forms and dedicated steers alike. */
function steeringCalls(runtime: FakeRuntime): FakeSessionCall[] {
  return runtime.calls.filter((call) =>
    (call.kind === 'prompt' && call.options?.streamingBehavior === 'steer') || call.kind === 'steer');
}

/** The injection lifecycle events a run's stream carries, in order. */
function injectionAcks(events: RunEvent[]): RunEvent[] {
  return events.filter((event) =>
    event.type === 'injection_delivered' || event.type === 'injection_rejected');
}

/** Flush every microtask queued by an emit before the assertions run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function settleRun(runtime: FakeRuntime, cost: number): void {
  runtime.emitAgentEnd({ usage: { cost: { total: cost } } });
}

async function openSwitchingFixture(): Promise<SwitchingFixture> {
  const sessionDir = mkdtempSync(join(tmpdir(), 'cortex-pi-switch-'));
  writeFileSync(join(sessionDir, 'session-a.jsonl'), '{}\n');
  writeFileSync(join(sessionDir, 'session-b.jsonl'), '{}\n');
  const fake = makeFakeRuntimeFactory({ sessionIds: ['session-a', 'session-b'] });
  const adapter = new PIAdapter(fake.factory, sessionDir);
  const first = piPool(adapter).open(engineSpecFixture({
    sessionId: null, sessionKey: 'pi-switch-first', resume: false,
  }));
  const second = piPool(adapter).open(engineSpecFixture({
    sessionId: null, sessionKey: 'pi-switch-second', resume: false,
  }));
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

test('steer refuses an idle PI session without touching the runtime', async (t) => {
  const fixture = openEngine();
  const runtime = await fixture.fake.runtime(0);
  t.onTestFinished(() => fixture.engine.close());

  assert.equal(fixture.engine.steer({ text: 'steer me' }).accepted, false);
  assert.deepEqual(runtime.calls, []);
});

test('injection refuses while the run is still switching to the target session', async (t) => {
  const fixture = await openSwitchingFixture();
  const { adapter, first, firstRuntime } = fixture;
  t.onTestFinished(() => cleanupSwitchingFixture(fixture));

  assert.deepEqual(await adapter.switchSession('session-b', 'pi-switch-first'), { ok: true, cancelled: false });

  let releaseSwitch = (): void => undefined;
  firstRuntime.switchGate = new Promise<void>((resolve) => { releaseSwitch = resolve; });
  const run = first.run({ text: 'opening after switch-back' }, { awaitBackground: 'none' });
  void run.result.catch(() => undefined);
  await Promise.resolve();
  assert.equal(firstRuntime.calls.at(-1)?.kind, 'switch', 'the turn first switches back to its own transcript');
  assert.equal(first.steer({ text: 'too early' }).accepted, false);

  releaseSwitch();
  await firstRuntime.nextCall('prompt');
  assert.equal(first.steer({ text: 'now safe' }).accepted, true);

  firstRuntime.emitUserMessage('opening after switch-back');
  firstRuntime.emitUserMessage('now safe');
  settleRun(firstRuntime, 0.01);
  await run.result;
});

test('active PI turn injects an attachment-aware prompt with streamingBehavior=steer', async (t) => {
  const fixture = openEngine();
  t.onTestFinished(() => fixture.engine.close());
  const { run, runtime } = await openTurn(fixture);
  runtime.emitAgentStart();

  assert.equal(fixture.engine.steer({
    text: 'inspect this',
    attachments: [{ mimeType: 'image/png', path: '/tmp/frame.png' }],
  }).accepted, true);

  const [call] = steeringCalls(runtime);
  assert.ok(call && call.kind === 'prompt', 'one steering prompt is queued');
  assert.equal(call.options?.streamingBehavior, 'steer');
  assert.match(call.text, /inspect this/);
  assert.match(call.text, /\/tmp\/frame\.png/);

  runtime.emitUserMessage('inspect this');
  settleRun(runtime, 0.01);
  await run.result;
});

test('opening user event is ignored, then steering messages ack FIFO including duplicate text', async (t) => {
  const fixture = openEngine();
  t.onTestFinished(() => fixture.engine.close());
  const { run, runtime, events } = await openTurn(fixture);
  runtime.emit({ type: 'agent_start' });

  fixture.engine.steer({ text: 'same' }, 'inj-same-1');
  fixture.engine.steer({ text: 'same' }, 'inj-same-2');
  runtime.emitUserMessage('opening');
  await tick();
  assert.deepEqual(injectionAcks(events), [], 'the external turn opening prompt is not a steering ack');

  runtime.emitUserMessage('transformed-by-pi');
  runtime.emitUserMessage('transformed-by-pi');
  await tick();
  assert.deepEqual(injectionAcks(events), [
    { type: 'injection_delivered', injectionId: 'inj-same-1', foldedIntoTurn: true },
    { type: 'injection_delivered', injectionId: 'inj-same-2', foldedIntoTurn: true },
  ]);

  settleRun(runtime, 0.01);
  await run.result;
});

test('a later rejected duplicate waits for the earlier duplicate delivery before sealing FIFO', async (t) => {
  const fixture = openEngine();
  t.onTestFinished(() => fixture.engine.close());
  const { run, runtime, events } = await openTurn(fixture);
  runtime.emit({ type: 'agent_start' });

  fixture.engine.steer({ text: 'same' }, 'inj-dup-1');
  runtime.promptRejections.push(new Error('second rejected'));
  fixture.engine.steer({ text: 'same' }, 'inj-dup-2');
  runtime.emitUserMessage('opening');
  await tick();
  assert.deepEqual(injectionAcks(events), [], 'second duplicate cannot seal ahead of the first');

  runtime.emitUserMessage('same');
  await tick();
  assert.deepEqual(injectionAcks(events), [
    { type: 'injection_delivered', injectionId: 'inj-dup-1', foldedIntoTurn: true },
    { type: 'injection_rejected', injectionId: 'inj-dup-2', reason: 'undelivered' },
  ]);
  settleRun(runtime, 0.01);
  await run.result;
});

test('post-run compaction stays active until agent_settled and aggregates both PI runs', async (t) => {
  const fixture = openEngine();
  t.onTestFinished(() => fixture.engine.close());
  const { run, runtime } = await openTurn(fixture);
  let settled = false;
  void run.result.then(() => { settled = true; }, () => { settled = true; });

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
  const result = await run.result;
  assert.equal(result.num_turns, 2);
  assert.equal(result.total_cost_usd, 0.05);
});

test('a failing opening prompt reports every queued steering message as undelivered', async (t) => {
  const fixture = openEngine({ holdPrompts: true });
  t.onTestFinished(() => fixture.engine.close());
  const { run, runtime, events } = await openTurn(fixture);

  assert.equal(fixture.engine.steer({ text: 'one' }, 'inj-fail-1').accepted, true);
  assert.equal(fixture.engine.steer({ text: 'two' }, 'inj-fail-2').accepted, true);
  runtime.heldPrompts[0]!.reject(new Error('backend exited'));

  await assert.rejects(run.result, /backend exited/);
  await tick();
  assert.deepEqual(injectionAcks(events), [
    { type: 'injection_rejected', injectionId: 'inj-fail-1', reason: 'undelivered' },
    { type: 'injection_rejected', injectionId: 'inj-fail-2', reason: 'undelivered' },
  ]);
  assert.equal(fixture.engine.steer({ text: 'after failure' }).accepted, false);
});
