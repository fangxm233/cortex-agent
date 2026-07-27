// input:  Node test runner + ClaudeSession inject/replay wiring (_test.makeSessionForTest)
// output: spec for injectUserMessage, lossless tool callbacks, --replay-user-messages ack + both landing outcomes
// pos:    CC backend print-stream and mid-turn injection wiring tests (no child process)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { _test } from '../../src/agent-adapter/claude/adapter.js';

const FAKE_STREAM = { write() {}, end() {} } as any;

function fakeTurn(capture: { value?: any; error?: any; resolves?: number }) {
  return {
    resolve: (v: any) => { capture.value = v; capture.resolves = (capture.resolves ?? 0) + 1; },
    reject: (e: any) => { capture.error = e; },
    resultData: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    askUserQuestions: [], finalOutput: null, longestOutput: null, turnCount: 0,
    onProgress: null, onAssistantMessage: null, onToolUse: null, onToolResult: null, onCompact: null,
    rawStream: FAKE_STREAM, txtStream: FAKE_STREAM, killed: false,
  };
}

/** Session wired with a writable fake stdin; `writes` records every NDJSON line sent to the CLI. */
function sessionWithStdin(t: any): { s: any; writes: string[] } {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  const writes: string[] = [];
  s.proc = {
    stdin: { write: (line: string) => { writes.push(line); return true; }, end() {} },
    on() {}, kill() {}, exitCode: null,
  };
  t.onTestFinished(() => s.close());
  return { s, writes };
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

// --- Guard rails: when injection is NOT possible ---

test('injectUserMessage: no live process → false, nothing written', (t) => {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());
  s.currentTurn = fakeTurn({});
  s.proc = null;

  assert.equal(s.injectUserMessage({ text: 'hi' }), false);
});

test('injectUserMessage: process not alive → false', (t) => {
  const { s, writes } = sessionWithStdin(t);
  s.currentTurn = fakeTurn({});
  s.alive = false;

  assert.equal(s.injectUserMessage({ text: 'hi' }), false);
  assert.equal(writes.length, 0, 'nothing written to a dead process');
});

test('injectUserMessage: no turn in flight → false (caller keeps the normal queue)', (t) => {
  const { s, writes } = sessionWithStdin(t);
  s.currentTurn = null;

  assert.equal(s.injectUserMessage({ text: 'hi' }), false);
  assert.equal(writes.length, 0, 'an idle session must not be written to out of band');
});

test('injectUserMessage: a failing stdin write is reported as false, not thrown', (t) => {
  const { s } = sessionWithStdin(t);
  const cap: { value?: any; error?: any } = {};
  s.currentTurn = fakeTurn(cap);
  s.proc = { stdin: { write: () => { throw new Error('EPIPE'); } } };

  assert.equal(s.injectUserMessage({ text: 'hi' }), false);
});

// --- The write itself: same NDJSON line as a turn, but NO new turn ---

test('injectUserMessage: writes the same NDJSON user line as a turn and registers NO new turn', (t) => {
  const { s, writes } = sessionWithStdin(t);
  const cap: { value?: any; resolves?: number } = {};
  const turn = fakeTurn(cap);
  s.currentTurn = turn;

  assert.equal(s.injectUserMessage({ text: 'change of plan' }), true);

  assert.equal(writes.length, 1, 'exactly one line written');
  const parsed = JSON.parse(writes[0]);
  assert.equal(parsed.type, 'user');
  assert.equal(parsed.message.role, 'user');
  assert.equal(parsed.message.content, 'change of plan');
  assert.equal(parsed.session_id, 'test-session');
  assert.ok(writes[0].endsWith('\n'), 'NDJSON framing preserved');
  assert.equal(s.currentTurn, turn, 'the in-flight turn is untouched — no second turn registered');
  assert.equal(cap.resolves ?? 0, 0, 'injection alone resolves nothing');
});

// --- Fold-in: injected message lands on a tool-result boundary → folds into the running turn ---

test('fold-in: echo while the turn is live acks as folded, opens no continuation, single result', (t) => {
  const { s } = sessionWithStdin(t);
  const cap: { value?: any; resolves?: number } = {};
  s.currentTurn = fakeTurn(cap);

  const acks: Array<{ text: string; foldedIntoTurn: boolean }> = [];
  s.setInjectionAckSink({ onDelivered: (m: any) => acks.push(m) });
  const contTexts: string[] = [];
  s.setContinuationSink({ onAssistantText: (x: string) => contTexts.push(x), onResult: () => {} });

  assert.equal(s.injectUserMessage({ text: 'EARLY-STOP please' }), true);
  assert.deepEqual(acks, [], 'no ack at write time — the CLI may queue it for seconds');

  s.handleLine(TOOL_RESULT_USER);              // the boundary the message lands on
  s.handleLine(replayEcho('EARLY-STOP please')); // consumed → ack fires HERE
  s.handleLine(ASSISTANT_TEXT);
  s.handleLine(RESULT_OK);                      // ONE result for the whole turn

  assert.deepEqual(acks, [{ text: 'EARLY-STOP please', foldedIntoTurn: true }], 'acked as folded into the live turn');
  assert.equal(cap.resolves, 1, 'the already-awaited turn promise resolves exactly once');
  assert.deepEqual(contTexts, [], 'no continuation turn — the reply belongs to the running turn');
});

// --- Post-result: injected message lands mid-text-generation → consumed AFTER this turn's result ---

test('post-result: echo after the result opens a spontaneous turn routed to the continuation sink', (t) => {
  const { s } = sessionWithStdin(t);
  const cap: { value?: any; resolves?: number } = {};
  s.currentTurn = fakeTurn(cap);

  const acks: Array<{ text: string; foldedIntoTurn: boolean }> = [];
  s.setInjectionAckSink({ onDelivered: (m: any) => acks.push(m) });
  const contTexts: string[] = [];
  let contResult: any = null;
  s.setContinuationSink({
    onAssistantText: (x: string) => contTexts.push(x),
    onResult: (r: any) => { contResult = r; },
  });

  assert.equal(s.injectUserMessage({ text: 'TEXT-INTERRUPTED' }), true);

  s.handleLine(RESULT_OK);                        // the model finished its text first
  assert.equal(cap.resolves, 1, 'the original turn resolved on its own result');
  assert.equal(s.currentTurn, null);

  s.handleLine(replayEcho('TEXT-INTERRUPTED'));   // NOW consumed — the CLI starts a turn of its own
  assert.deepEqual(acks, [{ text: 'TEXT-INTERRUPTED', foldedIntoTurn: false }], 'acked as a NEW turn, not folded');

  s.handleLine(ASSISTANT_TEXT);                   // spontaneous turn's reply
  s.handleLine(RESULT_CONT);

  assert.deepEqual(contTexts, ['EARLY-STOP'], 'the spontaneous reply reached the sink instead of being dropped');
  assert.ok(contResult, 'the spontaneous turn result reached the sink');
  assert.equal(cap.resolves, 1, 'the ORIGINAL turn promise is not resolved a second time');
});

test('post-result: content-block echo shape is recognised the same as string content', (t) => {
  const { s } = sessionWithStdin(t);
  s.currentTurn = fakeTurn({});
  const acks: any[] = [];
  s.setInjectionAckSink({ onDelivered: (m: any) => acks.push(m) });

  s.injectUserMessage({ text: 'blocks form' });
  s.handleLine(replayEchoBlocks('blocks form'));

  assert.equal(acks.length, 1, 'block-shaped echo acked');
});

// --- The replay-echo audit: echoes must not corrupt anything else ---

test('replay echo of the turn OWN prompt does not ack an injection', (t) => {
  const { s } = sessionWithStdin(t);
  s.currentTurn = fakeTurn({});
  const acks: any[] = [];
  s.setInjectionAckSink({ onDelivered: (m: any) => acks.push(m) });

  // The CLI echoes EVERY user message, starting with the turn's own opening prompt.
  s.handleLine(replayEcho('the original turn prompt'));
  assert.deepEqual(acks, [], 'only an injected message may consume an echo');

  s.injectUserMessage({ text: 'injected' });
  s.handleLine(replayEcho('the original turn prompt')); // still not ours
  assert.deepEqual(acks, [], 'a non-matching echo leaves the pending injection queued');

  s.handleLine(replayEcho('injected'));
  assert.equal(acks.length, 1, 'the matching echo acks');
});

test('replay echo alone never opens a continuation turn (only the assistant line does)', (t) => {
  const { s } = sessionWithStdin(t);
  s.currentTurn = fakeTurn({});
  let opened = false;
  s.setContinuationSink({ onAssistantText: () => { opened = true; }, onResult: () => { opened = true; } });

  s.injectUserMessage({ text: 'x' });
  s.handleLine(RESULT_OK);
  s.handleLine(replayEcho('x'));

  assert.equal(s.currentTurn, null, 'the echo itself does not register a turn');
  assert.equal(opened, false, 'nothing routed to the sink until the model actually speaks');
});

test('replay echo does not increment turn count, finalOutput, or background-task state', (t) => {
  const { s } = sessionWithStdin(t);
  const cap: { value?: any } = {};
  const turn = fakeTurn(cap);
  s.currentTurn = turn;

  s.injectUserMessage({ text: 'do not count me' });
  s.handleLine(replayEcho('do not count me'));

  assert.equal(turn.turnCount, 0, 'a user echo is not an assistant turn');
  assert.equal(turn.finalOutput, null, 'the replayed prompt can never become the reply');
  assert.equal(s.bgTracker.pendingCount, 0);
  assert.equal(s.bgTracker.undeliveredCount, 0);
  assert.equal(s.bgTracker.continuationArmed, false, 'an echo cannot arm the background-task path');
});

test('print stream preserves complete tool input/result data and the real tool-use id', (t) => {
  const { s } = sessionWithStdin(t);
  const turn = fakeTurn({});
  const toolUses: any[] = [];
  const toolResults: any[] = [];
  turn.onToolUse = (name: string, input: any, toolUseId: string) => toolUses.push({ name, input, toolUseId });
  turn.onToolResult = (toolUseId: string, content: string, isError: boolean) => toolResults.push({ toolUseId, content, isError });
  s.currentTurn = turn;

  s.handleLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu-full', name: 'Bash', input: { command: 'echo complete', timeout: 120000 } }] },
  }));
  s.handleLine(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-full', content: 'line 1\nline 2', is_error: true }] },
  }));
  const mixedContent = [
    { type: 'text', text: 'caption' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
  ];
  s.handleLine(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-mixed', content: mixedContent }] },
  }));

  assert.deepEqual(toolUses, [{ name: 'Bash', input: { command: 'echo complete', timeout: 120000 }, toolUseId: 'toolu-full' }]);
  assert.deepEqual(toolResults, [
    { toolUseId: 'toolu-full', content: 'line 1\nline 2', isError: true },
    { toolUseId: 'toolu-mixed', content: JSON.stringify(mixedContent), isError: false },
  ]);
});

test('pre-existing tool_result user lines are unaffected by the replay handling', (t) => {
  const { s } = sessionWithStdin(t);
  const cap: { value?: any } = {};
  const turn = fakeTurn(cap);
  s.currentTurn = turn;
  const acks: any[] = [];
  s.setInjectionAckSink({ onDelivered: (m: any) => acks.push(m) });

  s.injectUserMessage({ text: 'pending' });
  s.handleLine(TOOL_RESULT_USER);  // no isReplay → must not be treated as an ack

  assert.deepEqual(acks, [], 'a tool_result carrier is not a delivery ack');
  assert.equal(turn.turnCount, 0);
});

// --- Liveness: an undelivered injection must not be silently swallowed ---

test('handleProcessClose with an injection still pending notifies the sink (seals, never hangs)', (t) => {
  const { s } = sessionWithStdin(t);
  s.currentTurn = null;
  const results: any[] = [];
  s.setContinuationSink({ onAssistantText: () => {}, onResult: (r: any) => results.push(r) });

  // Turn ended, injection consumed post-result, spontaneous turn armed — then the process dies.
  s.currentTurn = fakeTurn({});
  s.injectUserMessage({ text: 'orphan' });
  s.handleLine(RESULT_OK);
  s.handleLine(replayEcho('orphan'));
  s.handleProcessClose(1);

  assert.equal(results.length, 1, 'the held state is sealed rather than waiting forever');
  assert.equal(results[0].backgroundInterrupted, true);
});
