// input:  Node test runner + orchestration/mid-turn-inject (all side effects injected)
// output: spec for the route() inject-vs-queue branch + immediate surfacing + delivery ack
// pos:    orch/ mid-turn injection routing tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeEach } from 'vitest';
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

test('backendSupportsInject: claude only', () => {
  assert.equal(backendSupportsInject('claude'), true);
  assert.equal(backendSupportsInject('pi'), false);
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
  const r = recorder({}, { backend: 'pi', agentProcess: proc });
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

// --- The happy path: injected + surfaced immediately ---

test('injects into the live turn and surfaces the message immediately, sharing one ts', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });

  assert.equal(tryInjectIntoLiveTurn(r.deps, baseCtx), true);

  assert.deepEqual(proc.injectedTexts, ['skip the rest']);
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].kind, 'user');
  assert.equal(r.history[0].text, 'skip the rest');
  assert.equal(r.published.length, 1, 'published straight away — not held until a turn starts');
  assert.equal(r.published[0].role, 'user');
  assert.equal(r.published[0].channel, CHANNEL);
  assert.equal(
    r.published[0].ts, r.history[0].ts,
    'history and bus event share one ts so the web content de-dup keys match',
  );
  assert.deepEqual(r.track, [+1], 'the reply window holds the busy gate');
});

test('records a ledger turn so history user-records and ledger turns stay index-aligned', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });

  tryInjectIntoLiveTurn(r.deps, baseCtx);

  assert.equal(r.ledger.length, 1, 'rewind indexes ledger turns positionally — a skipped turn would misalign every later edit');
  assert.equal(r.ledger[0].text, 'skip the rest');
  assert.equal(r.ledger[0].messageId, 'web_1');
});

test('attachments ride along to the backend and into the surfaced message', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  const attachments = [{ name: 'a.png', path: 'workspace/attachments/a.png', size: 3, mimeType: 'image/png', type: 'image' as const }];

  assert.equal(tryInjectIntoLiveTurn(r.deps, { ...baseCtx, attachments }), true);
  assert.deepEqual(r.published[0].attachments, attachments);
  assert.deepEqual(r.history[0].attachments, attachments);
});

// --- Fold-in, seen from orchestration ---

test('fold-in ack: flips the message to delivered and releases the busy gate', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);
  const userTs = r.published[0].ts;

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: true });

  assert.equal(r.delivered.length, 1, 'the replay echo flips the pending message to delivered');
  assert.equal(r.delivered[0].messageTs, userTs, 'keyed to the message it acks');
  assert.equal(r.delivered[0].sessionId, SESSION);
  assert.deepEqual(r.track, [+1, -1], 'folded in ⇒ the running turn owns the reply, gate released');
});

// --- Post-result, seen from orchestration ---

test('post-result ack holds the gate; the spontaneous turn is streamed and then seals it', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });
  tryInjectIntoLiveTurn(r.deps, baseCtx);

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: false });
  assert.equal(r.delivered.length, 1, 'still acked as delivered');
  assert.deepEqual(r.track, [+1], 'gate HELD — the reply has not arrived yet');

  // The CLI's own turn now speaks; the sink registered at inject time captures it.
  proc.continuationSink.onAssistantText('EARLY-STOP');
  assert.deepEqual(r.streamed, ['EARLY-STOP'], 'reply reached the channel output stream');
  const assistantRows = r.history.filter((h) => h.kind === 'assistant');
  assert.equal(assistantRows.length, 1, 'reply persisted to the transcript');
  assert.equal(assistantRows[0].text, 'EARLY-STOP');
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

test('a second injection into the same live turn is surfaced and acked independently', () => {
  const proc = fakeProcess();
  const r = recorder({}, { backend: 'claude', agentProcess: proc });

  assert.equal(tryInjectIntoLiveTurn(r.deps, baseCtx), true);
  assert.equal(tryInjectIntoLiveTurn(r.deps, { ...baseCtx, text: 'and one more', messageId: 'web_2' }), true);

  assert.deepEqual(proc.injectedTexts, ['skip the rest', 'and one more']);
  assert.equal(r.published.filter((p) => p.role === 'user').length, 2);
  assert.deepEqual(r.track, [+1, +1]);

  proc.ackSink.onDelivered({ text: 'skip the rest', foldedIntoTurn: true });
  proc.ackSink.onDelivered({ text: 'and one more', foldedIntoTurn: true });
  assert.equal(r.delivered.length, 2, 'each injected message gets its own delivery ack');
  assert.deepEqual(r.track, [+1, +1, -1, -1]);
});
