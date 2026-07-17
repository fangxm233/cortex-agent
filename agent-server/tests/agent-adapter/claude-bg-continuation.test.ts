// input:  Node test runner + ClaudeSession handleLine wiring (_test.makeSessionForTest)
// output: spec for background-task pending-count on result + spontaneous continuation routing + compact_boundary → onCompact
// pos:    CC backend background-task continuation wiring tests (no child process)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { _test } from '../../src/agent-adapter/claude/adapter.js';
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
const RESULT_CONT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, origin: { kind: 'task-notification' }, total_cost_usd: 0.01, num_turns: 1, session_id: 'test-session' });

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
