// input:  a scripted fake `claude` child wrapped in the pooled Claude engine (claudePool.open);
//         protocol lines are fed through the pooled ClaudeSession, exactly as readline would
// output: spec for engine.steer, lossless tool RunEvents, --replay-user-messages injection acks
//         + both landing outcomes (folded into the live turn / spontaneous post-result turn)
// pos:    Claude engine mid-turn injection wiring (RunEvents only; no real child process)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { ClaudeAdapter } from '../../src/agent-adapter/claude/adapter.js';
import type { ClaudeEngineSession } from '../../src/agent-adapter/claude/engine.js';
import type { EngineRun } from '../../src/agent-adapter/types.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';
import { claudePool, type ClaudePool } from './claude-pool-fixture.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

// --- Fixture: a pooled Claude engine over a fake child the test scripts by hand ----------------

/** A fake CLI child: writable stdin (every NDJSON line recorded on `writes`), async-free stdout
 *  that the test bypasses by calling `ClaudeSession.handleLine` directly, and a close emitter. */
function scriptedChild() {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.kill = () => true;
  child.failWrites = false;
  child.writes = [] as string[];
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (...args: any[]) => {
    if (child.failWrites) throw new Error('EPIPE');
    child.writes.push(String(args[0]));
    return write(...args);
  };
  return child;
}

interface ClaudeFixture {
  pool: ClaudePool;
  engine: ClaudeEngineSession;
  /** The pooled `ClaudeSession` inside the engine: `handleLine` scripts it, its fields are read. */
  session: any;
  child: any;
  writes: string[];
}

/** The subset of `ClaudeSession`'s pending turn the guard/state assertions inspect. */
function fakeTurn(capture: { value?: any; error?: any; resolves?: number }) {
  return {
    resolve: (v: any) => { capture.value = v; capture.resolves = (capture.resolves ?? 0) + 1; },
    reject: (e: any) => { capture.error = e; },
    resultData: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    askUserQuestions: [], finalOutput: null, longestOutput: null, turnCount: 0,
    onProgress: null, onAssistantMessage: null, onToolUse: null, onToolResult: null, onCompact: null,
    rawStream: { write() {}, end() {} } as any, txtStream: { write() {}, end() {} } as any, killed: false,
  };
}

/**
 * Open one pooled Claude engine over a fake child. The engine installs the injection-ack and
 * turn sinks in `run()`; the test drives the raw protocol through `session.handleLine`
 * so the echo/ack ordering stays synchronous and every internal counter is still observable.
 */
function openFixture(t: any, key: string, extra: Record<string, unknown> = {}): ClaudeFixture {
  const child = scriptedChild();
  const adapter = new ClaudeAdapter();
  const pool = claudePool(adapter);
  const engine = pool.open(engineSpecFixture({
    sessionId: 'test-session',
    sessionKey: key,
    resume: false,
    captureTranscriptLogs: false,
    processSpawner: (() => ({ process: child })) as any,
    ...extra,
  }));
  const session = pool.getPooledSession(key) as any;
  // Close the session, then let the fake child's 'close' clear the close-grace timer a real child
  // would clear. Without the emit the 30s grace timer would outlive the test.
  t.onTestFinished(() => { void engine.close(); child.emit('close', 0); });
  return { pool, engine, session, child, writes: child.writes };
}

/** A turn the test is not exercising: enough of the real turn shape that the session can still
 *  abort it when the fixture's fake child reports its process closing. */
function stubTurn(): any {
  return { resolve() {}, reject() {}, killed: false, spontaneous: false };
}

/** Consume a run's whole event stream in the background; `done` resolves when the queue closes. */
function collect(run: EngineRun): { events: RunEvent[]; done: Promise<void> } {
  const events: RunEvent[] = [];
  const done = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  return { events, done };
}

/** Flush the microtasks a settled turn queues before asserting on its stream. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Injection lifecycle acks, which replaced the legacy `InjectionAckSink` arrays. */
function injectionEvents(events: RunEvent[]) {
  return events.filter((event): event is Extract<RunEvent, { type: 'injection_delivered' | 'injection_rejected' }> =>
    event.type === 'injection_delivered' || event.type === 'injection_rejected');
}

/** The run stream's terminal results (the engine drops the raw `turn_complete` marker). */
function resultEvents(events: RunEvent[]) {
  return events.filter((event): event is Extract<RunEvent, { type: 'foreground_result' | 'background_result' }> =>
    event.type === 'foreground_result' || event.type === 'background_result');
}

/** Assistant prose the run tagged as belonging to its background phase. */
function backgroundTexts(events: RunEvent[]): string[] {
  return events
    .filter((event): event is Extract<RunEvent, { type: 'assistant_text' }> => event.type === 'assistant_text')
    .filter((event) => event.phase === 'background')
    .map((event) => event.text);
}

/** The one injection text→id pairing the engine must preserve on its ack event. */
function ackFor(events: RunEvent[], injectionId: string | undefined) {
  return injectionEvents(events).find((event) => event.injectionId === injectionId);
}

// --- Real CLI line shapes (captured from a live CLI run) ---

/** The turn's OWN prompt, echoed back by --replay-user-messages. */
const replayEcho = (text: string) => JSON.stringify({
  type: 'user', message: { role: 'user', content: text }, uuid: 'u-1', isReplay: true, session_id: 'test-session',
});
/** Same echo delivered as content blocks (the CLI uses both shapes). */
const replayEchoBlocks = (text: string) => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, uuid: 'u-2', isReplay: true,
});
/** Pre-existing species: a tool_result carrier. Present in print mode TODAY, no isReplay flag. */
const TOOL_RESULT_USER = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: ' M src/app.ts', is_error: false }] },
});
const ASSISTANT_TEXT = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'EARLY-STOP' }] } });
const RESULT_OK = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.02, num_turns: 2, session_id: 'test-session' });
const RESULT_CONT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.03, num_turns: 1, session_id: 'test-session' });

// --- Guard rails: when injection is NOT possible -----------------------------------------------

test('steer: no live process → false, nothing written', (t) => {
  const f = openFixture(t, 'inject-no-process');
  f.session.currentTurn = stubTurn();
  f.session.proc = null;

  assert.equal(f.engine.steer({ text: 'hi' }).accepted, false);
  assert.equal(f.writes.length, 0);
});

test('steer: no turn in flight → false (caller keeps the normal queue)', (t) => {
  const f = openFixture(t, 'inject-no-turn');
  f.session.currentTurn = null;

  assert.equal(f.engine.steer({ text: 'hi' }).accepted, false);
  assert.equal(f.writes.length, 0, 'an idle session must not be written to out of band');
});

test('steer: a failing stdin write is reported as false, not thrown', (t) => {
  const f = openFixture(t, 'inject-epipe');
  const cap: { value?: any; error?: any } = {};
  f.session.currentTurn = fakeTurn(cap);
  f.child.failWrites = true;

  assert.equal(f.engine.steer({ text: 'hi' }).accepted, false);
  assert.ok(cap.error, 'the in-flight turn was failed rather than leaving the write hanging');
});

// --- The write itself: same NDJSON line as a turn, but NO new turn -----------------------------

test('steer: writes the same NDJSON user line as a turn and registers NO new turn', (t) => {
  const f = openFixture(t, 'inject-write');
  const cap: { value?: any; resolves?: number } = {};
  const turn = fakeTurn(cap);
  f.session.currentTurn = turn;
  const writesBefore = f.writes.length;

  const steered = f.engine.steer({ text: 'change of plan' });
  assert.equal(steered.accepted, true);

  assert.equal(f.writes.length - writesBefore, 1, 'exactly one line written');
  const parsed = JSON.parse(f.writes[writesBefore]);
  assert.equal(parsed.type, 'user');
  assert.equal(parsed.message.role, 'user');
  assert.equal(parsed.message.content, 'change of plan');
  assert.equal(parsed.session_id, 'test-session');
  assert.ok(f.writes[writesBefore].endsWith('\n'), 'NDJSON framing preserved');
  assert.equal(f.session.currentTurn, turn, 'the in-flight turn is untouched — no second turn registered');
  assert.equal(cap.resolves ?? 0, 0, 'injection alone resolves nothing');
});

// --- Fold-in: injected message lands on a tool-result boundary → folds into the running turn ---

test('fold-in: echo while the turn is live acks as folded, opens no continuation, single result', async (t) => {
  const f = openFixture(t, 'inject-folded');
  const run = f.engine.run({ text: 'opening' }, { awaitBackground: 'none' });
  const { events, done } = collect(run);

  const steered = f.engine.steer({ text: 'EARLY-STOP please' });
  assert.equal(steered.accepted, true);
  assert.deepEqual(injectionEvents(events), [], 'no ack at write time — the CLI may queue it for seconds');

  f.session.handleLine(TOOL_RESULT_USER);              // the boundary the message lands on
  f.session.handleLine(replayEcho('EARLY-STOP please')); // consumed → ack fires HERE
  f.session.handleLine(ASSISTANT_TEXT);
  f.session.handleLine(RESULT_OK);                      // ONE result for the whole turn

  await run.result;
  await done;

  assert.deepEqual(injectionEvents(events), [
    { type: 'injection_delivered', injectionId: steered.injectionId, foldedIntoTurn: true },
  ], 'acked as folded into the live turn');
  const results = resultEvents(events);
  assert.equal(results.length, 1, 'the already-awaited turn resolves exactly once');
  assert.equal(results[0]!.type, 'foreground_result', 'the reply belongs to the running turn');
  assert.deepEqual(backgroundTexts(events), [], 'no continuation turn');
});

// --- Post-result: injected message lands mid-text-generation → consumed AFTER this turn's result ---

test('post-result: echo after the result opens a spontaneous turn routed to the run stream', async (t) => {
  const f = openFixture(t, 'inject-post-result');
  const run = f.engine.run({ text: 'opening' }, { awaitBackground: 'hold' });
  const { events, done } = collect(run);

  const steered = f.engine.steer({ text: 'TEXT-INTERRUPTED' });
  assert.equal(steered.accepted, true);

  f.session.handleLine(RESULT_OK);                        // the model finished its text first
  await run.result;
  await tick();
  assert.equal(resultEvents(events).filter((event) => event.type === 'foreground_result').length, 1,
    'the original turn resolved on its own result');
  assert.equal(f.session.currentTurn, null);

  f.session.handleLine(replayEcho('TEXT-INTERRUPTED'));   // NOW consumed — the CLI starts a turn of its own
  await tick();
  assert.deepEqual(injectionEvents(events), [
    { type: 'injection_delivered', injectionId: steered.injectionId, foldedIntoTurn: false },
  ], 'acked as a NEW turn, not folded');

  f.session.handleLine(ASSISTANT_TEXT);                   // spontaneous turn's reply
  f.session.handleLine(RESULT_CONT);
  // The run ends by itself: the reply the injection was owed has landed, so nothing is outstanding.
  await run.settled;
  await done;

  assert.deepEqual(backgroundTexts(events), ['EARLY-STOP'], 'the spontaneous reply reached the sink instead of being dropped');
  assert.equal(resultEvents(events).filter((event) => event.type === 'background_result').length, 1,
    'the spontaneous turn result reached the sink');
  assert.equal(resultEvents(events).filter((event) => event.type === 'foreground_result').length, 1,
    'the ORIGINAL turn promise is not resolved a second time');
});

test('post-result: content-block echo shape is recognised the same as string content', async (t) => {
  const f = openFixture(t, 'inject-blocks');
  const run = f.engine.run({ text: 'opening' }, { awaitBackground: 'none' });
  const { events, done } = collect(run);

  const steered = f.engine.steer({ text: 'blocks form' });
  f.session.handleLine(replayEchoBlocks('blocks form'));
  await tick();
  run.cancel();
  await done;

  const ack = ackFor(events, steered.injectionId);
  assert.ok(ack, 'block-shaped echo acked');
  assert.equal(ack.type, 'injection_delivered');
  assert.equal((ack as any).foldedIntoTurn, true);
});

// --- The replay-echo audit: echoes must not corrupt anything else ------------------------------

test('replay echo of the turn OWN prompt does not ack an injection', async (t) => {
  const f = openFixture(t, 'inject-own-echo');
  const run = f.engine.run({ text: 'opening' }, { awaitBackground: 'none' });
  const { events, done } = collect(run);

  // The CLI echoes EVERY user message, starting with the turn's own opening prompt.
  f.session.handleLine(replayEcho('the original turn prompt'));
  await tick();
  assert.deepEqual(injectionEvents(events), [], 'only an injected message may consume an echo');

  const steered = f.engine.steer({ text: 'injected' });
  f.session.handleLine(replayEcho('the original turn prompt')); // still not ours
  await tick();
  assert.deepEqual(injectionEvents(events), [], 'a non-matching echo leaves the pending injection queued');

  f.session.handleLine(replayEcho('injected'));
  await tick();
  const ack = ackFor(events, steered.injectionId);
  assert.ok(ack, 'the matching echo acks');
  run.cancel();
  await done;
});

test('replay echo alone never opens a continuation turn (only the assistant line does)', async (t) => {
  const f = openFixture(t, 'inject-echo-only');
  const run = f.engine.run({ text: 'opening' }, { awaitBackground: 'hold' });
  const { events, done } = collect(run);

  f.engine.steer({ text: 'x' });
  f.session.handleLine(RESULT_OK);
  await run.result;
  f.session.handleLine(replayEcho('x'));
  await tick();

  assert.equal(f.session.currentTurn, null, 'the echo itself does not register a turn');
  assert.deepEqual(backgroundTexts(events), [], 'nothing routed to the sink until the model actually speaks');
  assert.equal(resultEvents(events).filter((event) => event.type === 'background_result').length, 0);
  run.cancel();
  await done;
});

test('replay echo does not increment turn count, finalOutput, or background-task state', async (t) => {
  const f = openFixture(t, 'inject-no-count');
  const run = f.engine.run({ text: 'opening' }, { awaitBackground: 'none' });
  const { done } = collect(run);
  const turn = f.session.currentTurn;

  f.engine.steer({ text: 'do not count me' });
  f.session.handleLine(replayEcho('do not count me'));
  await tick();

  assert.equal(turn.turnCount, 0, 'a user echo is not an assistant turn');
  assert.equal(turn.finalOutput, null, 'the replayed prompt can never become the reply');
  assert.equal(f.session.bgTracker.pendingCount, 0);
  assert.equal(f.session.bgTracker.undeliveredCount, 0);
  assert.equal(f.session.bgTracker.continuationArmed, false, 'an echo cannot arm the background-task path');
  run.cancel();
  await done;
});

test('print stream preserves complete tool input/result data and the real tool-use id', async (t) => {
  const f = openFixture(t, 'inject-tools');
  const run = f.engine.run({ text: 'opening' }, { awaitBackground: 'none' });
  const { events, done } = collect(run);

  f.session.handleLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu-full', name: 'Bash', input: { command: 'echo complete', timeout: 120000 } }] },
  }));
  f.session.handleLine(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-full', content: 'line 1\nline 2', is_error: true }] },
  }));
  const mixedContent = [
    { type: 'text', text: 'caption' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
  ];
  f.session.handleLine(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-mixed', content: mixedContent }] },
  }));
  await tick();
  run.cancel();
  await done;

  // The lossless payload now arrives as RunEvents; `isError` is the RunEvent's `ok` inverse.
  const toolUses = events.filter((event) => event.type === 'tool_use');
  const toolResults = events.filter((event) => event.type === 'tool_result');
  assert.deepEqual(toolUses, [
    { type: 'tool_use', toolUseId: 'toolu-full', name: 'Bash', input: { command: 'echo complete', timeout: 120000 }, phase: 'foreground' },
  ]);
  assert.deepEqual(toolResults, [
    { type: 'tool_result', toolUseId: 'toolu-full', ok: false, content: 'line 1\nline 2', phase: 'foreground' },
    { type: 'tool_result', toolUseId: 'toolu-mixed', ok: true, content: JSON.stringify(mixedContent), phase: 'foreground' },
  ]);
});

test('pre-existing tool_result user lines are unaffected by the replay handling', async (t) => {
  const f = openFixture(t, 'inject-toolresult');
  const run = f.engine.run({ text: 'opening' }, { awaitBackground: 'none' });
  const { events, done } = collect(run);
  const turn = f.session.currentTurn;

  f.engine.steer({ text: 'pending' });
  f.session.handleLine(TOOL_RESULT_USER);  // no isReplay → must not be treated as an ack
  await tick();

  assert.deepEqual(injectionEvents(events), [], 'a tool_result carrier is not a delivery ack');
  assert.equal(turn.turnCount, 0);
  run.cancel();
  await done;
});

// --- Liveness: an undelivered injection must not be silently swallowed -------------------------

test('handleProcessClose with an injection still pending notifies the sink (seals, never hangs)', async (t) => {
  const f = openFixture(t, 'inject-close');
  const run = f.engine.run({ text: 'opening' }, { awaitBackground: 'hold' });
  const { events, done } = collect(run);

  // Turn ended, injection consumed post-result, spontaneous turn armed — then the process dies.
  f.engine.steer({ text: 'orphan' });
  f.session.handleLine(RESULT_OK);
  await run.result;
  f.session.handleLine(replayEcho('orphan'));
  await tick();
  f.child.emit('close', 1);

  await done;

  const interrupted = resultEvents(events).filter((event) => event.type === 'background_result');
  assert.equal(interrupted.length, 1, 'the held state is sealed rather than waiting forever');
  assert.equal((interrupted[0] as any).result.backgroundInterrupted, true);
});
