// input:  ClaudeSession lines, cumulative costs, late sinks
// output: continuation routing, cursor, and compaction specs
// pos:    Claude print spontaneous-continuation wiring tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { _test } from '../../src/agent-adapter/claude/adapter.js';
import { waitForBgContinuation } from '../../src/agent-adapter/bg-wait.js';
import { buildContinuationSink } from '../../src/orchestration/bg-continuation.js';
import { MockAdapter, MockOutputStream } from '../../src/platform/testing.js';

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

test('handleLine: one-shot buffers a continuation until its sink is registered', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  s.preserveUnreportedAccounting = true;
  t.onTestFinished(() => s.close());

  s.handleLine(TASK_STARTED);
  s.handleLine(TASK_NOTIFICATION);
  s.handleLine(ASSISTANT_CONT);
  s.handleLine(RESULT_CONT);

  const texts: string[] = [];
  const results: any[] = [];
  s.setContinuationSink({
    onAssistantText: (text: string) => texts.push(text),
    onResult: (result: any) => results.push(result),
  });
  assert.deepEqual(texts, ['Background task done: DONE']);
  assert.equal(results.length, 1);
  assert.equal(results[0].costReported, true);
});

test('handleLine: absent middle cost preserves the cumulative cursor across chained continuations', async (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  s.preserveUnreportedAccounting = true;
  t.onTestFinished(() => s.close());

  const first: { value?: any } = {};
  s.currentTurn = fakeTurn(first);
  s.handleLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'first' }));
  s.handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'test-session',
    total_cost_usd: 0.05, num_turns: 1,
  }));

  const mergedPromise = waitForBgContinuation({
    proc: { setContinuationSink: (sink) => s.setContinuationSink(sink) },
    baseResult: first.value,
    graceMs: 1_000,
    maxWaitMs: 5_000,
  });
  s.handleLine(JSON.stringify({
    type: 'system', subtype: 'task_notification', task_id: 'first', status: 'completed',
  }));
  s.handleLine(ASSISTANT_CONT);
  s.handleLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'second' }));
  s.handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'test-session', num_turns: 1,
  }));
  s.handleLine(JSON.stringify({
    type: 'system', subtype: 'task_notification', task_id: 'second', status: 'completed',
  }));
  s.handleLine(ASSISTANT_CONT);
  s.handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'test-session',
    total_cost_usd: 0.1, num_turns: 1,
  }));

  const merged = await mergedPromise;
  assert.equal(merged.total_cost_usd, 0.1);
  assert.equal(merged.costReported, true);
});

test('handleLine: spontaneous continuation routes assistant text + final result to the sink', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const texts: string[] = [];
  let finalResult: any = null;
  s.setContinuationSink({
    onAssistantText: (txt: string) => texts.push(txt),
    onResult: (r: any) => { finalResult = r; },
  });

  // Background task completes → CLI re-invokes the model with no active turn.
  s.handleLine(TASK_STARTED);
  s.handleLine(TASK_NOTIFICATION);     // arms continuation, pending → 0
  s.handleLine(ASSISTANT_CONT);        // opens a synthetic continuation turn, routes text
  s.handleLine(RESULT_CONT);           // finalizes continuation

  assert.deepEqual(texts, ['Background task done: DONE'], 'assistant text routed to sink');
  assert.ok(finalResult, 'sink received continuation result');
  assert.equal(finalResult.pendingBackgroundTasks, 0, 'no background tasks remain at continuation end');
});

test('handleLine: spontaneous continuation forwards final and reconciled context snapshots', (t) => {
  const s: any = _test.makeSessionForTest('claude-opus-5[1m]');
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const contexts: Array<{ usedTokens: number; contextWindow: number }> = [];
  s.setContinuationSink({
    onAssistantText: () => {},
    onContextUsage: (usage: { usedTokens: number; contextWindow: number }) => contexts.push(usage),
    onResult: () => {},
  });

  s.handleLine(TASK_STARTED);
  s.handleLine(TASK_NOTIFICATION);
  s.handleLine(CONTEXT_START); // seeds the tracker before the synthetic turn opens
  s.handleLine(ASSISTANT_CONT); // opens the synthetic continuation turn
  s.handleLine(CONTEXT_DELTA); // first callback-visible exact boundary
  s.handleLine(RESULT_CONT); // provider-reported window correction

  assert.deepEqual(contexts.map((usage) => [usage.usedTokens, usage.contextWindow]), [
    [500, 1_000_000],
    [500, 900_000],
  ]);
});

test('handleLine: assistant with no active turn and NO continuation armed is dropped (no sink call)', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  let called = false;
  s.setContinuationSink({ onAssistantText: () => { called = true; }, onResult: () => { called = true; } });

  s.handleLine(ASSISTANT_CONT); // no task ever started → not armed
  assert.equal(called, false, 'stray assistant output is not treated as a continuation');
});

test('integration: real captured line sequence merges continuation text + dispatches complete via production sink', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const stream = new MockOutputStream(new MockAdapter(), { type: 'interactive-reply', conduit: 'slack:D1', sessionId: '' });
  let completedWith: any = null;
  let waitingCalls = 0;
  // Wire the adapter session to the PRODUCTION sink builder (orchestration/bg-continuation).
  s.setContinuationSink(buildContinuationSink({
    stream: stream as any,
    onWaiting: () => { waitingCalls++; },
    onComplete: (r: any) => { completedWith = r; },
    onRateLimited: () => {},
  }));

  // Replay the exact event order captured from a real `claude -p` background run.
  s.handleLine(TASK_STARTED);        // pending → 1
  s.handleLine(TASK_NOTIFICATION);   // completion → arms continuation, pending → 0
  s.handleLine(ASSISTANT_CONT);      // continuation text (merged into the reply stream)
  s.handleLine(RESULT_CONT);         // continuation result → onComplete

  // Merge: continuation text went into the SAME output stream (no new root message logic here).
  const text = stream.segments.map((seg: any) => seg.text ?? '').join('');
  assert.match(text, /Background task done: DONE/);
  assert.ok(completedWith, 'production sink dispatched onComplete (seal)');
  assert.equal(completedWith.pendingBackgroundTasks, 0);
  assert.equal(waitingCalls, 0, 'no waiting dispatch when no tasks remain');
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

// F2 (2026-07-10): any process death during the waiting window must notify the sink so the
// held "background task running" status can be sealed instead of waiting forever.
test('handleProcessClose: waiting window (bg pending, no active turn) → sink gets backgroundInterrupted exactly once', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const results: any[] = [];
  s.setContinuationSink({ onAssistantText: () => {}, onResult: (r: any) => results.push(r) });

  s.handleLine(TASK_STARTED); // pending → 1, then the turn ends (no currentTurn: waiting window)
  s.handleProcessClose(1);    // process dies (restart / crash / kill)

  assert.equal(results.length, 1, 'sink notified once');
  assert.equal(results[0].backgroundInterrupted, true, 'result flagged as interrupted');
  assert.equal(s.continuationSink, null, 'sink cleared after notify');

  s.handleProcessClose(1);    // double close must not re-notify
  assert.equal(results.length, 1, 'no double delivery');
});

test('handleProcessClose: nothing pending → sink cleared silently (no interrupted call)', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const results: any[] = [];
  s.setContinuationSink({ onAssistantText: () => {}, onResult: (r: any) => results.push(r) });
  s.handleProcessClose(0);

  assert.equal(results.length, 0, 'no interrupted delivery for a clean close');
  assert.equal(s.continuationSink, null, 'sink still cleared (session is gone)');
});

test('handleProcessClose: crash mid-continuation (spontaneous turn open) → sink gets backgroundInterrupted', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const results: any[] = [];
  s.setContinuationSink({ onAssistantText: () => {}, onResult: (r: any) => results.push(r) });

  s.handleLine(TASK_STARTED);
  s.handleLine(TASK_NOTIFICATION);  // arms continuation
  s.handleLine(ASSISTANT_CONT);     // opens the spontaneous continuation turn
  s.handleProcessClose(1);          // process dies before the continuation result

  assert.equal(results.length, 1, 'sink notified despite the open spontaneous turn');
  assert.equal(results[0].backgroundInterrupted, true);
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

test('setContinuationSink/clearContinuationSink and close clear the sink', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());

  const sink = { onAssistantText: () => {}, onResult: () => {} };
  s.setContinuationSink(sink);
  assert.equal(s.continuationSink, sink);
  s.clearContinuationSink();
  assert.equal(s.continuationSink, null);
});
