// input:  ClaudeSession lines, costs, rate limits, late sinks; the engine-run seam
// output: continuation routing, cursor, limit, compaction and interruption specs on RunEvents
// pos:    Claude run-phase wiring tests (engine-owned background phase, no process surface)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { _test } from '../../src/agent-adapter/claude/adapter.js';
import { openClaudeTestEngine, collectRun, tick } from './replay-harness.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';

const FAKE_STREAM = { write() {}, end() {} } as any;

function fakeTurn(capture: { value?: any; error?: any }) {
  return {
    resolve: (v: any) => { capture.value = v; },
    reject: (e: any) => { capture.error = e; },
    resultData: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    askUserQuestions: [], finalOutput: null, longestOutput: null, turnCount: 0,
    onProgress: null, onAssistantMessage: null, onToolUse: null, onCompact: null,
    rawStream: FAKE_STREAM, txtStream: FAKE_STREAM, killed: false,
  };
}

const TASK_STARTED = JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'b6vp8rywx', task_type: 'local_bash' });
const TASK_UPDATED_DONE = JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 'b6vp8rywx', patch: { status: 'completed' } });
const TASK_NOTIFICATION = JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'b6vp8rywx', status: 'completed', summary: 'done' });
const RESULT_FIRST = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.02, num_turns: 2, session_id: 'test-session' });
const ASSISTANT_CONT = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Background task done: DONE' }] } });
const CONTEXT_START = JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300 } } } });
const CONTEXT_DELTA = JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 80 } } });
const RESULT_CONT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, origin: { kind: 'task-notification' }, total_cost_usd: 0.01, num_turns: 1, session_id: 'test-session', usage: { iterations: [{ input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 80 }] }, modelUsage: { 'claude-opus-5[1m]': { canonicalModel: 'claude-opus-5', contextWindow: 900000 } } });
const RATE_LIMIT_MESSAGE = "API Error: Server is temporarily limiting requests (not your usage limit) · This request would exceed your account's rate limit. Please try again later.";
const ASSISTANT_RATE_LIMIT = JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: RATE_LIMIT_MESSAGE }] } });
const RESULT_CONT_RATE_LIMIT = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: RATE_LIMIT_MESSAGE, session_id: 'test-session', total_cost_usd: 0, num_turns: 1 });

type BackgroundResult = Extract<RunEvent, { type: 'background_result' }>;
function backgroundResults(events: RunEvent[]): BackgroundResult[] {
  return events.filter((event): event is BackgroundResult => event.type === 'background_result');
}

/**
 * Open one run over a fresh pooled engine and feed the session raw CLI lines. This is the seam the
 * old `setBackgroundTurnSink`/`waitForBgContinuation` tests move onto: the run's own policy
 * (`awaitBackground`) decides what the phase does, and the run stream carries the background events.
 */
function engineRun(
  t: { onTestFinished: (fn: () => void) => void },
  opts: {
    awaitBackground?: 'none' | 'hold' | 'inline' | 'completion-only';
    model?: string | null;
    preserveUnreportedAccounting?: boolean;
  } = {},
) {
  const { engine, session, close } = openClaudeTestEngine({
    model: opts.model,
    preserveUnreportedAccounting: opts.preserveUnreportedAccounting,
  });
  t.onTestFinished(close);
  const run = engine.run({ text: 'go' }, { awaitBackground: opts.awaitBackground ?? 'hold' });
  const { events, done } = collectRun(run);
  return { engine, session, run, events, done };
}

test('handleLine: normal turn result carries pendingBackgroundTasks count', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const cap: { value?: any } = {};
  s.currentTurn = fakeTurn(cap);

  s.handleLine(TASK_STARTED);   // background task launched (pending → 1)
  s.handleLine(RESULT_FIRST);   // turn ends while it is still running

  assert.ok(cap.value, 'turn resolved');
  assert.equal(cap.value.pendingBackgroundTasks, 1, 'result reports 1 pending background task');
});

// The engine installs its own background-turn sink when `run()` opens, but a one-shot CLI can deliver
// a continuation before that: the session buffers it (`preserveUnreportedAccounting`) and the phase
// replays it once it starts. This is the same fact the old `setBackgroundTurnSink` buffering test
// asserted, observed through the run stream the engine actually installs.
test('run: one-shot buffers a continuation until the run installs its sink', async (t) => {
  const { engine, session, close } = openClaudeTestEngine({ preserveUnreportedAccounting: true });
  t.onTestFinished(close);

  // The continuation lands before `run()`: text and result are buffered on the session.
  session.handleLine(TASK_STARTED);
  session.handleLine(TASK_NOTIFICATION);
  session.handleLine(ASSISTANT_CONT);
  session.handleLine(RESULT_CONT);
  // A second task keeps the run's background phase open so the buffered result is replayed.
  session.handleLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'second' }));

  const run = engine.run({ text: 'go' }, { awaitBackground: 'hold' });
  const { events, done } = collectRun(run);
  session.handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'test-session',
    total_cost_usd: 0.05, num_turns: 1,
  }));

  const settled = await run.settled;
  await done;
  assert.equal(settled.costReported, true);
  const texts = events
    .filter((e): e is Extract<RunEvent, { type: 'assistant_text' }> => e.type === 'assistant_text')
    .map((e) => e.text);
  assert.deepEqual(texts, ['Background task done: DONE'], 'the buffered continuation text is delivered');
  const results = backgroundResults(events);
  assert.equal(results.length, 1, 'the buffered continuation result is delivered');
  assert.equal(results[0].result.costReported, true);
});

test('run: absent middle cost preserves the cumulative cursor across chained continuations', async (t) => {
  const { session, run } = engineRun(t, {
    awaitBackground: 'hold', preserveUnreportedAccounting: true,
  });

  session.handleLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'first' }));
  session.handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'test-session',
    total_cost_usd: 0.05, num_turns: 1,
  }));
  await tick(); // let the foreground result settle and the phase start

  session.handleLine(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'first', status: 'completed' }));
  session.handleLine(ASSISTANT_CONT);
  session.handleLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'second' }));
  session.handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'test-session', num_turns: 1,
  }));
  session.handleLine(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'second', status: 'completed' }));
  session.handleLine(ASSISTANT_CONT);
  session.handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'test-session',
    total_cost_usd: 0.1, num_turns: 1,
  }));

  const merged = await run.settled;
  assert.equal(merged.total_cost_usd, 0.1);
  assert.equal(merged.costReported, true);
});

test('run: spontaneous continuation routes assistant text + final result to the background stream', async (t) => {
  const { session, run, events, done } = engineRun(t, { awaitBackground: 'hold' });

  // Background task completes → CLI re-invokes the model with no active turn.
  session.handleLine(TASK_STARTED);
  session.handleLine(RESULT_FIRST);
  await tick();
  session.handleLine(TASK_NOTIFICATION);     // arms continuation, pending → 0
  session.handleLine(ASSISTANT_CONT);        // opens a synthetic continuation turn, routes text
  session.handleLine(RESULT_CONT);           // finalizes continuation

  await run.settled;
  await done;

  const texts = events.filter((e) => e.type === 'assistant_text').map((e) => e.text);
  assert.deepEqual(texts, ['Background task done: DONE'], 'assistant text routed to the background stream');
  const results = backgroundResults(events);
  assert.equal(results.length, 1, 'the run stream received the continuation result');
  assert.equal(results[0].result.pendingBackgroundTasks, 0, 'no background tasks remain at continuation end');
});

test('run: spontaneous continuation normalizes a temporary 429 into a rate-limited background result', async (t) => {
  const { session, run, events, done } = engineRun(t, { awaitBackground: 'hold' });

  session.handleLine(TASK_STARTED);
  session.handleLine(RESULT_FIRST);
  await tick();
  session.handleLine(TASK_NOTIFICATION);
  session.handleLine(ASSISTANT_RATE_LIMIT);
  session.handleLine(RESULT_CONT_RATE_LIMIT);

  await run.settled;
  await done;

  const texts = events.filter((e) => e.type === 'assistant_text').map((e) => e.text);
  assert.deepEqual(texts, [RATE_LIMIT_MESSAGE]);
  const results = backgroundResults(events);
  assert.equal(results.length, 1, 'rate-limited continuation reaches the run stream');
  assert.equal(results[0].result.rateLimited, true);
  assert.equal(results[0].result.rateLimitMessage, RATE_LIMIT_MESSAGE);
});

test('run: spontaneous continuation forwards final and reconciled context snapshots', async (t) => {
  const { session, run, events, done } = engineRun(t, {
    awaitBackground: 'hold', model: 'claude-opus-5[1m]',
  });

  session.handleLine(TASK_STARTED);
  session.handleLine(RESULT_FIRST);
  await tick();
  session.handleLine(TASK_NOTIFICATION);
  session.handleLine(CONTEXT_START); // seeds the tracker before the synthetic turn opens
  session.handleLine(ASSISTANT_CONT); // opens the synthetic continuation turn
  session.handleLine(CONTEXT_DELTA); // first callback-visible exact boundary
  session.handleLine(RESULT_CONT); // provider-reported window correction

  await run.settled;
  await done;

  const contexts = events
    .filter((e): e is Extract<RunEvent, { type: 'context_usage' }> => e.type === 'context_usage')
    .filter((e) => e.phase === 'background')
    .map((e) => [e.usedTokens, e.contextWindow]);
  assert.deepEqual(contexts, [
    [500, 1_000_000],
    [500, 900_000],
  ]);
});

test('run: assistant with no active turn and NO continuation armed is dropped (no background event)', async (t) => {
  const { session, events, done } = engineRun(t, { awaitBackground: 'hold' });

  session.handleLine(RESULT_FIRST);   // closes the foreground with nothing owed
  await tick();
  session.handleLine(ASSISTANT_CONT); // no task ever started → not armed
  await tick();

  assert.equal(
    events.some((e) => e.type === 'assistant_text' || e.type === 'background_result'),
    false,
    'stray assistant output is not treated as a continuation',
  );
  await done;
});

test('integration: real captured line sequence becomes the background RunEvents a run fans out', async (t) => {
  const { session, run, events, done } = engineRun(t, { awaitBackground: 'hold' });

  // The engine owns the PRODUCTION translation every background surface subscribes to, so
  // asserting the run stream asserts what all of them see.
  // Replay the exact event order captured from a real `claude -p` background run.
  session.handleLine(TASK_STARTED);        // pending → 1
  session.handleLine(RESULT_FIRST);
  await tick();
  session.handleLine(TASK_NOTIFICATION);   // completion → arms continuation, pending → 0
  session.handleLine(ASSISTANT_CONT);      // continuation text
  session.handleLine(RESULT_CONT);         // continuation result → background_result

  await run.settled;
  await done;

  const text = events
    .filter((e): e is Extract<RunEvent, { type: 'assistant_text' }> => e.type === 'assistant_text')
    .map((e) => e.text).join('');
  assert.match(text, /Background task done: DONE/);
  const continuation = events.filter((e) => 'phase' in e && e.phase === 'background');
  assert.ok(continuation.some((e) => e.type === 'assistant_text'), 'the continuation text is background');
  // `background_result` is the run's own terminal kind and carries no `phase` tag — the type
  // itself is the phase, so it is asserted on the whole stream, not the phased subset.
  assert.ok(events.some((e) => e.type === 'background_result'), 'the terminal result is background');
  const settled = backgroundResults(events);
  assert.equal(settled.length, 1, 'exactly one terminal background result');
  assert.equal(settled[0].result.pendingBackgroundTasks, 0, 'no work left — the surfaces seal');
  assert.equal(settled[0].result.undeliveredBackgroundTasks ?? 0, 0, 'nothing left unnotified either');
});

// 2026-07-10 investigation: CC does not always deliver task_notification (old-CLI same-turn
// completions never notify; TaskStop-killed tasks never notify). The result snapshot therefore
// distinguishes truly-running tasks (pendingBackgroundTasks) from work-done-but-unnotified
// tasks (undeliveredBackgroundTasks) so orchestration can arm a grace watchdog for the latter.
test('handleLine: task completed without notification → undelivered, not pending, on result', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const cap: { value?: any } = {};
  s.currentTurn = fakeTurn(cap);

  s.handleLine(TASK_STARTED);       // background task launched
  s.handleLine(TASK_UPDATED_DONE);  // work finished mid-turn — no notification yet
  s.handleLine(RESULT_FIRST);       // turn ends

  assert.ok(cap.value, 'turn resolved');
  assert.equal(cap.value.pendingBackgroundTasks, 0, 'not counted as still running');
  assert.equal(cap.value.undeliveredBackgroundTasks, 1, 'reported as undelivered completion');
});

// F2 (2026-07-10): any process death during the waiting window must notify the run stream so the
// held "background task running" status can be sealed instead of waiting forever.
test('handleProcessClose: waiting window (bg pending, no active turn) → one backgroundInterrupted result', async (t) => {
  const { session, events, done } = engineRun(t, { awaitBackground: 'hold' });

  session.handleLine(TASK_STARTED); // pending → 1, then the turn ends (waiting window)
  session.handleLine(RESULT_FIRST);
  await tick();
  session.handleProcessClose(1);    // process dies (restart / crash / kill)
  await tick();

  const results = backgroundResults(events);
  assert.equal(results.length, 1, 'run stream notified once');
  assert.equal(results[0].result.backgroundInterrupted, true, 'result flagged as interrupted');
  assert.equal(session.backgroundTurnSink, null, 'the engine sink is released after the notify');

  session.handleProcessClose(1);    // double close must not re-notify
  await tick();
  assert.equal(backgroundResults(events).length, 1, 'no double delivery');
  await done;
});

test('handleProcessClose: nothing pending → sink released silently (no interrupted result)', async (t) => {
  const { session, events, done } = engineRun(t, { awaitBackground: 'none' });

  session.handleLine(RESULT_FIRST);
  await tick();
  await done;
  session.handleProcessClose(0);
  await tick();

  assert.equal(backgroundResults(events).length, 0, 'no interrupted delivery for a clean close');
  assert.equal(session.backgroundTurnSink, null, 'sink still released (session is gone)');
});

test('handleProcessClose: crash mid-continuation (spontaneous turn open) → backgroundInterrupted result', async (t) => {
  const { session, events, done } = engineRun(t, { awaitBackground: 'hold' });

  session.handleLine(TASK_STARTED);
  session.handleLine(RESULT_FIRST);
  await tick();
  session.handleLine(TASK_NOTIFICATION);  // arms continuation
  session.handleLine(ASSISTANT_CONT);     // opens the spontaneous continuation turn
  session.handleProcessClose(1);          // process dies before the continuation result
  await tick();

  const results = backgroundResults(events);
  assert.equal(results.length, 1, 'run stream notified despite the open spontaneous turn');
  assert.equal(results[0].result.backgroundInterrupted, true);
  await done;
});

// 2026-09-06 investigation (cortex-self K-070): on `--resume` with background work orphaned by
// the previous process, the CLI emits the orphan notifications, `init`, and a 0-turn
// result{origin:task-notification} BEFORE reading the prompt on stdin. Treating that result as
// the user turn's resolved it empty in ~2s; the minutes of real work that followed were dropped.
test('handleLine: notification-turn result on resume does not settle the user turn', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const cap: { value?: any } = {};
  const texts: string[] = [];
  const turn: any = fakeTurn(cap);
  turn.onAssistantMessage = (text: string) => texts.push(text);
  s.currentTurn = turn;

  for (const id of ['bk8lu504b', 'bgacwz2nc', 'bzxqeqq9u']) {
    s.handleLine(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: id, status: 'stopped', output_file: '', summary: 'Orphaned by a previous Claude Code process exit and reported in an aggregate summary.' }));
  }
  s.handleLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-session' }));
  s.handleLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, duration_ms: 59, result: '', total_cost_usd: 0, origin: { kind: 'task-notification' }, session_id: 'test-session' }));
  assert.equal(cap.value, undefined, 'user turn still open after the notification-turn result');

  s.handleLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '转换完成，两棵树都提交了' }] } }));
  s.handleLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 12, result: '转换完成，两棵树都提交了', total_cost_usd: 0.9, session_id: 'test-session' }));

  assert.ok(cap.value, 'user turn resolved by its own result');
  assert.equal(cap.value.finalOutput, '转换完成，两棵树都提交了');
  assert.equal(cap.value.num_turns, 12);
  assert.deepEqual(texts, ['转换完成，两棵树都提交了'], 'the real reply reached the turn callbacks');
  assert.equal(cap.value.undeliveredBackgroundTasks, 0, 'orphan notices owe no continuation');
});

test('run: a spontaneous turn is still settled by its notification-turn result', async (t) => {
  const { session, run, events, done } = engineRun(t, { awaitBackground: 'hold' });

  session.handleLine(TASK_STARTED);
  session.handleLine(RESULT_FIRST);
  await tick();
  session.handleLine(TASK_NOTIFICATION);
  session.handleLine(ASSISTANT_CONT);
  session.handleLine(RESULT_CONT);

  await run.settled;
  await done;
  assert.equal(backgroundResults(events).length, 1, 'continuation result delivered');
});

// Two background completions seconds apart: A's notification opens turn A; B's lands while the
// model is producing turn A's final text, so the CLI queues turn B. At turn A's result both
// notifications have been observed (counts 0) — the hold used to seal idle there, and turn B
// (93 minutes, 114 turns on 2026-09-06) streamed into an "idle" session.
test('run: notification observed mid-turn without its own turn yet → result owes one delivery', async (t) => {
  const { session, run, events, done } = engineRun(t, { awaitBackground: 'hold' });

  session.handleLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'a', is_backgrounded: true, task_type: 'local_agent' }));
  session.handleLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'b', is_backgrounded: true, task_type: 'local_agent' }));
  session.handleLine(RESULT_FIRST);
  await tick();
  session.handleLine(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'a', status: 'completed' }));
  session.handleLine(ASSISTANT_CONT); // turn A opens
  session.handleLine(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'b', status: 'completed' }));
  session.handleLine(RESULT_CONT);    // turn A ends; turn B is queued inside the CLI
  await tick();

  const results = backgroundResults(events);
  assert.equal(results.length, 1);
  assert.equal(results[0].result.pendingBackgroundTasks, 0);
  assert.equal(results[0].result.undeliveredBackgroundTasks, 1, "B's turn has not opened yet — hold must wait");

  session.handleLine(ASSISTANT_CONT); // turn B opens
  session.handleLine(RESULT_CONT);
  await run.settled;
  await done;
  // `backgroundResults` is a filtered snapshot, so it has to be re-read after turn B lands.
  const allResults = backgroundResults(events);
  assert.equal(allResults.length, 2);
  assert.equal(allResults[1].result.undeliveredBackgroundTasks, 0, 'nothing owed after turn B');
});

test('handleLine: notification folded into the active turn (replay echo) owes nothing at result', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const cap: { value?: any } = {};
  s.currentTurn = fakeTurn(cap);
  s.handleLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'bg', is_backgrounded: true }));
  s.handleLine(JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 'bg', patch: { status: 'completed' } }));
  s.handleLine(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'bg', status: 'completed' }));
  s.handleLine(JSON.stringify({ type: 'user', isReplay: true, message: { role: 'user', content: '<task-notification>\n<task-id>bg</task-id>\n<status>completed</status>\n</task-notification>' } }));
  s.handleLine(RESULT_FIRST);
  assert.ok(cap.value);
  assert.equal(cap.value.undeliveredBackgroundTasks, 0, 'folded notification was delivered inside the turn');
});

test('handleLine: compact_boundary fires onCompact with trigger + preTokens', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const cap: { value?: any } = {};
  const turn: any = fakeTurn(cap);
  const compactCalls: Array<{ trigger: string; preTokens?: number }> = [];
  turn.onCompact = (info: { trigger: string; preTokens?: number }) => compactCalls.push(info);
  s.currentTurn = turn;

  s.handleLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 37418 } }));

  assert.deepEqual(compactCalls, [{ trigger: 'auto', preTokens: 37418 }]);
});

test('handleLine: compact_boundary with no active turn is a no-op', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  // No currentTurn set — must not throw.
  assert.doesNotThrow(() =>
    s.handleLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } })),
  );
});

// The old `setBackgroundTurnSink/clearBackgroundTurnSink and close clear the sink` test drove a surface
// that no longer exists: the engine installs and releases the sink itself as part of `run()`, which
// the interruption tests above already exercise.
