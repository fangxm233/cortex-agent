// input:  Node test runner + orchestration/mid-turn-inject (all side effects injected)
// output: backend-neutral inject routing + delivered/undelivered pending→committed two-phase commit
// pos:    orch/ mid-turn injection routing tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';

import {
  isInjectableMessage,
  backendSupportsInject,
  tryInjectIntoLiveTurn,
  _test as injectTest,
  type MidTurnInjectDeps,
} from '../../src/orchestration/mid-turn-inject.js';
import { SYNTHETIC_CALLBACK_SENDER } from '../../src/platform/types.js';

// Injection state is per-channel and module-scoped (it outlives a single turn by design), so each
// test starts from a clean registry rather than inheriting the previous test's pending messages.
beforeEach(() => injectTest.reset());

const CHANNEL = 'web:sess-1';
const SESSION = 'track-sess-1';

/** A pooled AgentProcess that accepts injection, capturing the sinks orchestration registers. */
function fakeProcess(opts: { accepts?: boolean; hasMethod?: boolean } = {}) {
  const injected: string[] = [];
  const p: any = {
    injectedTexts: injected,
    ackSink: null as any,
    continuationSink: null as any,
    setInjectionAckSink(sink: any) { p.ackSink = sink; },
    setContinuationSink(sink: any) { p.continuationSink = sink; },
  };
  if (opts.hasMethod !== false) {
    p.injectUserMessage = (m: any) => { injected.push(m.text); return opts.accepts !== false; };
  }
  return p;
}

interface Recorder {
  deps: MidTurnInjectDeps;
  history: any[];
  published: any[];
  delivered: any[];
  status: any[];
  ledger: any[];
  track: number[];
  streamed: string[];
}

function recorder(overrides: Partial<MidTurnInjectDeps> = {}, exec?: any): Recorder {
  const history: any[] = [];
  const published: any[] = [];
  const delivered: any[] = [];
  const status: any[] = [];
  const ledger: any[] = [];
  const track: number[] = [];
  const streamed: string[] = [];
  let clock = 0;
  const deps: MidTurnInjectDeps = {
    getLiveExecutions: () => (exec === undefined ? [] : [exec]),
    getStreamingCallback: () => (text: string) => streamed.push(text),
    appendUser: (sessionId, o) => history.push({ kind: 'user', sessionId, ...o }),
    appendAssistant: (sessionId, o) => history.push({ kind: 'assistant', sessionId, ...o }),
    appendTool: (sessionId, o) => history.push({ kind: 'tool', sessionId, ...o }),
    publishMessage: (ev) => published.push(ev),
    publishDelivered: (ev) => delivered.push(ev),
    publishStatus: (ev) => status.push(ev),
    beginLedgerTurn: (o) => ledger.push(o),
    track: (d) => track.push(d),
    now: () => `2026-07-25T00:00:0${clock++}.000Z`,
    ...overrides,
  };
  return { deps, history, published, delivered, status, ledger, track, streamed };
}

const baseCtx = {
  channel: CHANNEL, sessionId: SESSION, text: 'skip the rest',
  senderId: 'U1', messageId: 'web_1',
};

// --- Pure gate: what may be folded into a turn already in flight ---

test('isInjectableMessage: a plain user message qualifies', () => {
  assert.equal(isInjectableMessage({ text: 'hello', senderId: 'U1' }), true);
});

test('isInjectableMessage: a !command never injects — it carries its own execution semantics', () => {
  assert.equal(isInjectableMessage({ text: '!cancel', senderId: 'U1' }), false);
  assert.equal(isInjectableMessage({ text: '  !thread coder go', senderId: 'U1' }), false);
});

test('isInjectableMessage: a synthetic wake/callback must open its own turn, not fold into one', () => {
  assert.equal(isInjectableMessage({ text: 'a child finished', senderId: SYNTHETIC_CALLBACK_SENDER }), false);
});

test('isInjectableMessage: an empty message is not injectable', () => {
  assert.equal(isInjectableMessage({ text: '   ', senderId: 'U1' }), false);
});

test('backendSupportsInject: Claude and PI declare live-turn injection', () => {
  assert.equal(backendSupportsInject('claude'), true);
  assert.equal(backendSupportsInject('pi'), true);
  assert.equal(backendSupportsInject('codex'), false);
  assert.equal(backendSupportsInject('nonsense'), false);
});

// --- Fallback: everything that must keep today's conduit-queue behaviour ---

test('no live execution on the channel → not injected (falls back to the normal queue)', () => {
  const r = recorder();
  assert.equal(tryInjectIntoLiveTurn(r.deps, baseCtx), false);
  assert.deepEqual(r.published, [], 'nothing surfaced when the message is going to be queued');
  assert.deepEqual(r.track, []);
});

test('live execution on a backend without MidTurnInject → not injected', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'codex', agentProcess: proc });
  assert.equal(tryInjectIntoLiveTurn(r.deps, baseCtx), false);
  assert.deepEqual(proc.injectedTexts, []);
});

test('live claude execution whose process cannot inject (TUI mode) → not injected', () => {
  const proc = fakeProcess({ hasMethod: false });
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  assert.equal(tryInjectIntoLiveTurn(r.deps, baseCtx), false);
});

test('backend refuses the injection (turn already finished) → not injected, no surfacing', () => {
  const proc = fakeProcess({ accepts: false });
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  assert.equal(tryInjectIntoLiveTurn(r.deps, baseCtx), false);
  assert.deepEqual(proc.injectedTexts, ['skip the rest'], 'it was attempted');
  assert.deepEqual(r.published, [], 'a refused injection must not leave a phantom message');
  assert.deepEqual(r.history, []);
  assert.deepEqual(r.track, [], 'no busy-gate leak on the refused path');
});

test('a !command on a busy channel keeps the queue even with an injectable turn live', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  assert.equal(tryInjectIntoLiveTurn(r.deps, { ...baseCtx, text: '!cancel' }), false);
  assert.deepEqual(proc.injectedTexts, []);
});

test('an unresolved session id → not injected (nothing to surface the message against)', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  assert.equal(tryInjectIntoLiveTurn(r.deps, { ...baseCtx, sessionId: null }), false);
});

// --- Phase 1 of the commit: surfaced as PENDING, nothing recorded yet ---

test('injects into the live turn and surfaces the message immediately, marked pending', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });

  assert.equal(tryInjectIntoLiveTurn(r.deps, baseCtx), true);

  assert.deepEqual(proc.injectedTexts, ['skip the rest']);
  assert.equal(r.published.length, 1, 'published straight away — not held until a turn starts');
  assert.equal(r.published[0].role, 'user');
  assert.equal(r.published[0].channel, CHANNEL);
  assert.equal(r.published[0].pending, true, 'the model has not read it yet, and the row must say so');
  assert.deepEqual(r.track, [+1], 'the reply window holds the busy gate');
});

test('writing does not record: no history entry and no ledger turn until the model reads it', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });

  tryInjectIntoLiveTurn(r.deps, baseCtx);

  assert.deepEqual(r.history, [], 'a queued-inside-the-backend message is not part of the record yet');
  assert.deepEqual(r.ledger, [], 'and it owns no turn yet');
});

// --- Phase 2: the echo commits it, at the point the model actually read it ---

test('output written before the model read the message is recorded ABOVE it', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);

  // The turn that was already running keeps writing — it goes through the same history seam. This
  // paragraph was produced without the model ever having seen the injected message.
  r.deps.appendAssistant(SESSION, { text: 'still answering the previous question', ts: r.deps.now() });

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: true });

  assert.deepEqual(
    r.history.map((h) => h.kind), ['assistant', 'user'],
    'the record must not claim the agent replied to something it had not read',
  );
  assert.equal(r.history[1].text, 'skip the rest');
});

test('the committed history record is stamped with the consumption time, not the write time', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);
  const writeTs = r.published[0].ts;

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: true });

  assert.equal(r.history.length, 1);
  assert.notEqual(r.history[0].ts, writeTs, 'the write instant is not when it entered the conversation');
  assert.equal(r.history[0].ts, r.delivered[0].committedTs, 'history and the delivered ack share the commit key');
});

test('the ledger turn opens WITH the history record, so rewind indices stay aligned', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);
  assert.deepEqual(r.ledger, [], 'no turn while the message is still queued inside the backend');

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: true });

  assert.equal(r.ledger.length, 1, 'rewind indexes turns positionally — a user record without its turn misaligns every later edit');
  assert.equal(r.ledger[0].text, 'skip the rest');
  assert.equal(r.ledger[0].messageId, 'web_1');
  assert.equal(r.history.filter((h) => h.kind === 'user').length, 1, 'one user record, one ledger turn');
});

test('attachments ride along to the backend, the pending row, and the committed record', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  const attachments = [{ name: 'a.png', path: 'workspace/attachments/a.png', size: 3, mimeType: 'image/png', type: 'image' as const }];

  assert.equal(tryInjectIntoLiveTurn(r.deps, { ...baseCtx, attachments }), true);
  assert.deepEqual(r.published[0].attachments, attachments);

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: true });
  assert.deepEqual(r.history[0].attachments, attachments);
});

// --- Fold-in, seen from orchestration ---

test('fold-in ack: commits the message and releases the busy gate', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);
  const pendingTs = r.published[0].ts;

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: true });

  assert.equal(r.delivered.length, 1, 'the replay echo commits the pending message');
  assert.equal(r.delivered[0].messageTs, pendingTs, 'carries the pending row key it replaces');
  assert.ok(r.delivered[0].committedTs, 'and the new order key the client re-keys the row to');
  assert.equal(r.delivered[0].sessionId, SESSION);
  assert.deepEqual(r.track, [+1, -1], 'folded in ⇒ the running turn owns the reply, gate released');
});

test('the commit lands before the delivered ack — a refetch triggered by it must find the record', () => {
  const proc = fakeProcess();
  const order: string[] = [];
  const r = recorder({
    appendUser: () => order.push('history'),
    beginLedgerTurn: () => order.push('ledger'),
    publishDelivered: () => order.push('delivered'),
  }, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: true });

  assert.deepEqual(order, ['history', 'ledger', 'delivered']);
});

// --- Post-result, seen from orchestration ---

test('post-result ack holds the gate; the spontaneous turn is streamed and then seals it', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: false });
  assert.equal(r.delivered.length, 1, 'still committed at the echo');
  assert.deepEqual(r.track, [+1], 'gate HELD — the reply has not arrived yet');

  // The CLI's own turn now speaks; the sink registered at inject time captures it.
  proc.continuationSink.onAssistantText('EARLY-STOP');
  assert.deepEqual(r.streamed, ['EARLY-STOP'], 'reply reached the channel output stream');
  const assistantRows = r.history.filter((h) => h.kind === 'assistant');
  assert.equal(assistantRows.length, 1, 'reply persisted to the transcript');
  assert.equal(assistantRows[0].text, 'EARLY-STOP');
  assert.deepEqual(
    r.history.map((h) => h.kind), ['user', 'assistant'],
    'the reply the message actually caused is recorded BELOW it',
  );
  assert.ok(
    r.status.some((s) => s.running === true),
    'the session is re-marked running — a spontaneous turn is real work',
  );

  proc.continuationSink.onResult({ pendingBackgroundTasks: 0 });
  assert.ok(r.status.some((s) => s.running === false), 'sealed idle when the spontaneous turn ends');
  assert.deepEqual(r.track, [+1, -1], 'busy gate released exactly once');
});

test('post-result continuation routes tool calls to the transcript too', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);
  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: false });

  proc.continuationSink.onToolUse('Bash', { command: 'echo hi' });

  const toolRows = r.history.filter((h) => h.kind === 'tool');
  assert.equal(toolRows.length, 1);
  assert.equal(toolRows[0].toolName, 'Bash');
  assert.ok(r.published.some((p) => p.role === 'tool' && p.toolName === 'Bash'));
});

test('busy gate is released exactly once even if ack and continuation result both fire', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: true });
  proc.continuationSink.onResult({ pendingBackgroundTasks: 0 });
  proc.continuationSink.onResult({ pendingBackgroundTasks: 0 });

  assert.deepEqual(r.track, [+1, -1], 'single-fire release — no double decrement');
});

test('a second injection into the same live turn is surfaced and committed independently', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });

  assert.equal(tryInjectIntoLiveTurn(r.deps, baseCtx), true);
  assert.equal(tryInjectIntoLiveTurn(r.deps, { ...baseCtx, text: 'and one more', messageId: 'web_2' }), true);

  assert.deepEqual(proc.injectedTexts, ['skip the rest', 'and one more']);
  const pendingRows = r.published.filter((p) => p.role === 'user');
  assert.equal(pendingRows.length, 2);
  assert.ok(pendingRows.every((p) => p.pending === true), 'both are pending while the model has read neither');
  assert.deepEqual(r.track, [+1, +1]);

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: true });
  proc.ackSink.onDelivered({ text: 'and one more', foldedIntoTurn: true });
  assert.equal(r.delivered.length, 2, 'each injected message gets its own commit');
  assert.deepEqual(
    r.history.map((h) => h.text), ['skip the rest', 'and one more'],
    'committed in the order the model read them',
  );
  assert.notEqual(r.delivered[0].committedTs, r.delivered[1].committedTs, 'each carries its own order key');
  assert.deepEqual(r.track, [+1, +1, -1, -1]);
});

// --- Never consumed: the message must still enter the record, at the point it stopped being pending ---

test('a message the backend never consumed is committed when the injection window closes', () => {
  vi.useFakeTimers();
  try {
    const proc = fakeProcess();
    const r = recorder({ maxWaitMs: 5000 }, { backend: 'claude', agentProcess: proc });
    tryInjectIntoLiveTurn(r.deps, baseCtx);
    const pendingTs = r.published[0].ts;
    assert.deepEqual(r.history, []);

    vi.advanceTimersByTime(5001);

    assert.equal(r.history.length, 1, 'a message the user really sent is never silently lost');
    assert.equal(r.history[0].text, 'skip the rest');
    assert.equal(r.ledger.length, 1, 'and it takes its ledger turn with it');
    assert.equal(r.delivered.length, 1, 'the client is told to stop showing it as pending');
    assert.equal(r.delivered[0].messageTs, pendingTs);
    assert.equal(r.delivered[0].committedTs, r.history[0].ts, 'it enters the record where it stopped being pending');
    assert.deepEqual(r.track, [+1, -1]);
  } finally {
    vi.useRealTimers();
  }
});

test('an adapter undelivered ack commits and releases exactly once', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'pi', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);

  proc.ackSink.onUndelivered({ text: 'skip the rest' });
  proc.ackSink.onUndelivered({ text: 'skip the rest' });

  assert.deepEqual(r.history.map((h) => h.text), ['skip the rest']);
  assert.equal(r.ledger.length, 1, 'the sealed message takes one ledger turn');
  assert.equal(r.delivered.length, 1, 'pending UI row is committed once');
  assert.deepEqual(r.track, [+1, -1], 'undelivered seal cannot leak or double-release the gate');
});

test('a spontaneous turn ending with an injection still outstanding commits it too', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);
  tryInjectIntoLiveTurn(r.deps, { ...baseCtx, text: 'and one more', messageId: 'web_2' });
  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: false });
  assert.equal(r.history.length, 1, 'only the consumed one is committed so far');

  // The turn results with the second message never echoed (process death delivers the same edge).
  proc.continuationSink.onResult({ pendingBackgroundTasks: 0 });

  assert.deepEqual(r.history.map((h) => h.text), ['skip the rest', 'and one more']);
  assert.equal(r.ledger.length, 2, 'ledger turns keep pace with the user records');
  assert.equal(r.delivered.length, 2);
});

test('a committed message is never committed twice, whatever fires afterwards', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: false });
  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: false });
  proc.continuationSink.onResult({ pendingBackgroundTasks: 0 });
  proc.continuationSink.onResult({ pendingBackgroundTasks: 0 });

  assert.equal(r.history.filter((h) => h.kind === 'user').length, 1, 'one send, one record');
  assert.equal(r.ledger.length, 1);
  assert.equal(r.delivered.length, 1);
});
