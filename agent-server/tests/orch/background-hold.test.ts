import '../_test-home.js'; // MUST be first — isolates store singletons
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { MockAdapter, MockOutputStream } from '../../src/platform/testing.js';
import type { RunEvent } from '../../src/domain/runs/events.js';
import type { RunObserver } from '../../src/domain/runs/request.js';
import { getOrchestrationRuntime, setOrchestrationRuntime } from '../../src/orchestration/runtime.js';
import { sessionHolds } from '../../src/core/session-holds.js';
import { activeTurns } from '../../src/orchestration/turn/active-turns.js';
import { sessionState } from '../../src/core/session-state.js';
import { cancelBgHolds } from '../../src/orchestration/routing/commands/cancel.js';
import {
  holdBackgroundContinuation, holdSession, isBgContinuationEnabled, isInteractiveChannel,
  isWebChannel, shouldHoldForBg,
} from '../../src/orchestration/turn/background-hold.js';
import { platformHoldRenderer } from '../../src/orchestration/turn/hold-render-platform.js';
import { resetSettingsForTests } from '../../src/core/settings.js';


test('isBgContinuationEnabled: default ON, opt-out via CORTEX_BG_CONTINUATION=0/false', async () => {
  const prev = process.env.CORTEX_BG_CONTINUATION;
  try {
    delete process.env.CORTEX_BG_CONTINUATION;
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), true, 'enabled by default when unset');
    process.env.CORTEX_BG_CONTINUATION = '0';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), false, 'disabled by "0"');
    process.env.CORTEX_BG_CONTINUATION = 'false';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), false, 'disabled by "false"');
    process.env.CORTEX_BG_CONTINUATION = 'off';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), false, 'disabled by "off"');
    process.env.CORTEX_BG_CONTINUATION = '1';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), true, 'explicitly enabled');
    process.env.CORTEX_BG_CONTINUATION = 'true';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), true);
    process.env.CORTEX_BG_CONTINUATION = '';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), true, 'empty string is not an opt-out');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_BG_CONTINUATION;
    else process.env.CORTEX_BG_CONTINUATION = prev;
    resetSettingsForTests();
  }
});

test('shouldHoldForBg: hold gates — remaining count, rate limit, channel scope, sink capability, feature flag', async () => {
  const prev = process.env.CORTEX_BG_CONTINUATION;
  try {
    delete process.env.CORTEX_BG_CONTINUATION;
    resetSettingsForTests();
    const base = { pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0, rateLimited: false };
    assert.equal(shouldHoldForBg(base as any, 'slack:D1', true), 'platform', 'running task holds');
    assert.equal(shouldHoldForBg({ ...base, pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 } as any, 'slack:D1', true), 'platform', 'undelivered completion holds (grace watchdog upstream)');
    assert.equal(shouldHoldForBg({ ...base, pendingBackgroundTasks: 0 } as any, 'slack:D1', true), null, 'nothing remaining → no hold');
    assert.equal(shouldHoldForBg({ ...base, rateLimited: true } as any, 'slack:D1', true), null, 'rate-limited turn never holds');
    assert.equal(shouldHoldForBg(base as any, 'thread-abc', true), null, 'non-interactive channel never holds');
    assert.equal(shouldHoldForBg(base as any, 'slack:D1', false), null, 'no sink capability → no hold');
    assert.equal(shouldHoldForBg(null, 'slack:D1', true), null, 'null result → no hold');
    process.env.CORTEX_BG_CONTINUATION = '0';
    resetSettingsForTests();
    assert.equal(shouldHoldForBg(base as any, 'slack:D1', true), null, 'feature flag off → no hold');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_BG_CONTINUATION;
    else process.env.CORTEX_BG_CONTINUATION = prev;
    resetSettingsForTests();
  }
});

test('isInteractiveChannel: only slack/feishu interactive conduits, not thread/dispatch/web', () => {
  assert.equal(isInteractiveChannel('slack:D123'), true);
  assert.equal(isInteractiveChannel('feishu:oc_abc'), true);
  assert.equal(isInteractiveChannel('thread-abc123'), false);
  assert.equal(isInteractiveChannel('dispatch:task-1'), false);
  assert.equal(isInteractiveChannel('web:cortex-abcd'), false, 'web is NOT slack/feishu — held separately');
  assert.equal(isInteractiveChannel(''), false);
});

test('isWebChannel: only the web: conduit', () => {
  assert.equal(isWebChannel('web:cortex-abcd'), true);
  assert.equal(isWebChannel('slack:D123'), false);
  assert.equal(isWebChannel('feishu:oc_abc'), false);
  assert.equal(isWebChannel('thread-abc123'), false);
  assert.equal(isWebChannel(''), false);
});

test('shouldHoldForBg on web: the same gates, answering with the web renderer', async () => {
  const prev = process.env.CORTEX_BG_CONTINUATION;
  try {
    delete process.env.CORTEX_BG_CONTINUATION;
    resetSettingsForTests();
    const base = { pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0, rateLimited: false };
    assert.equal(shouldHoldForBg(base as any, 'web:cortex-abcd', true), 'web', 'running task on web holds');
    assert.equal(shouldHoldForBg({ ...base, pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 } as any, 'web:cortex-abcd', true), 'web', 'undelivered completion holds');
    assert.equal(shouldHoldForBg({ ...base, pendingBackgroundTasks: 0 } as any, 'web:cortex-abcd', true), null, 'nothing remaining → no hold');
    assert.equal(shouldHoldForBg({ ...base, rateLimited: true } as any, 'web:cortex-abcd', true), null, 'rate-limited turn never holds');
    assert.equal(shouldHoldForBg(base as any, 'slack:D1', true), 'platform', 'slack channel is NOT the web hold');
    assert.equal(shouldHoldForBg(base as any, 'web:cortex-abcd', false), null, 'no sink capability → no hold');
    assert.equal(shouldHoldForBg(null, 'web:cortex-abcd', true), null, 'null result → no hold');
    process.env.CORTEX_BG_CONTINUATION = '0';
    resetSettingsForTests();
    assert.equal(shouldHoldForBg(base as any, 'web:cortex-abcd', true), null, 'feature flag off → no hold');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_BG_CONTINUATION;
    else process.env.CORTEX_BG_CONTINUATION = prev;
    resetSettingsForTests();
  }
});


// --- The hold itself. Two of these are NEW coverage (plan §3, behaviour change 3): before T2.2
// the Slack/Feishu hold registered nothing, so `sessionState` reported the session idle while its
// status message still said "Background task running", and Stop had nothing to call.

/** A run reduced to what a hold touches, plus a hand to drive its background phase. */
function fakeHeldRun() {
  let observer: RunObserver | null = null;
  return {
    run: {
      claimBackgroundTranscript(): void {},
      subscribe(o: RunObserver): () => void { observer = o; return () => { observer = null; }; },
    },
    emit: (event: RunEvent): void => {
      assert.ok(observer, 'no observer subscribed — the hold did not install');
      observer!.onEvent(event);
    },
    get subscribed(): boolean { return observer !== null; },
  };
}

let statusSeq = 0;

/** A hold on a Slack channel, rendered through a MockAdapter status message, with the bus wired to
 *  `sessionHolds` exactly as entry/app.ts wires it in production. */
async function platformHold(channel = 'slack:D-hold') {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const statusMsg = { conduit: channel, messageId: `status-hold-${++statusSeq}` };
  const stream = new MockOutputStream(adapter, { type: 'interactive-reply', conduit: channel, sessionId: '' });
  // The turn being held registered this channel's streaming slot (turn.ts step 5a) and deliberately
  // did NOT clear it on the way out — the hold's seal is what releases it.
  const ownedCallback = Object.assign((_t: string) => {}, { stream });
  activeTurns.setStreamingCallback(channel, ownedCallback);
  const sessionId = `sess-hold-${statusSeq}`;
  const statuses: Array<{ running: boolean; backgroundRunning?: boolean }> = [];
  const previousBus = getOrchestrationRuntime().bus;
  setOrchestrationRuntime({ bus: {
    publish: (event: any) => {
      if (event.type !== 'session.status') return;
      statuses.push({ running: event.running, backgroundRunning: event.backgroundRunning });
      sessionHolds.onSessionStatus(event);
    },
    subscribe: () => ({ unsubscribe() {} }),
  } as never });
  const held = fakeHeldRun();
  const hold = await holdBackgroundContinuation({
    run: held.run, channel, sessionId, userMessage: 'run it in background',
    result: { pendingBackgroundTasks: 1, total_cost_usd: 0.02, num_turns: 3 } as any,
    track: () => {},
    renderer: platformHoldRenderer({
      adapter: adapter as any, statusMsg: statusMsg as any, channel, stream, ownedCallback,
      sessionName: 'cortex-test', sessionId: 'backend-1', trackSessionId: sessionId,
      startTime: Date.now(), baseResult: { total_cost_usd: 0.02, num_turns: 3 } as any,
      userMessageTs: null, executionId: `exec-hold-${statusSeq}`, trigger: 'user',
      projectId: 'cortex-self', backend: 'claude',
    }),
  });
  return {
    adapter, channel, sessionId, hold, statuses, emit: held.emit, ownedCallback,
    lastStatus: () => (adapter.updated.at(-1)?.content?.text ?? '') as string,
    restore: () => { setOrchestrationRuntime({ bus: previousBus as never }); sessionHolds.clear(); activeTurns._reset(); },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
}

test('NEW: a platform hold is busy state — sessionState reports backgroundRunning while it is held', async () => {
  const h = await platformHold();
  try {
    assert.ok(h.hold, 'the hold installed');
    assert.match(h.lastStatus(), /Background task running/i, 'status held in waiting state');
    assert.deepEqual(h.statuses, [{ running: true, backgroundRunning: true }],
      'the hold publishes its own held status — the Slack hold used to publish nothing at all');
    assert.deepEqual(sessionState(h.sessionId), {
      running: true, backgroundRunning: true, numTurns: null, executionId: null,
    }, 'sessions.list and the compact gate see a held Slack session, not an idle one');
    assert.deepEqual(sessionHolds.sessionsOnChannel(h.channel), [h.sessionId],
      'and the channel-keyed Stop path can find it');
  } finally {
    h.restore();
  }
});

test('NEW: user Stop seals a platform hold — status sealed, running:false published', async () => {
  const h = await platformHold('slack:D-hold-stop');
  try {
    const killed: string[] = [];
    const cancelled = cancelBgHolds(h.channel, { killPooled: (c) => { killed.push(c); return true; } });

    assert.equal(cancelled, 1, 'Stop reports the hold it ended (it used to find nothing)');
    assert.deepEqual(killed, [h.channel], 'the backend that owns the background task is killed first');
    await waitFor(() => /interrupted/i.test(h.lastStatus()));
    assert.match(h.lastStatus(), /interrupted/i, 'the status message is sealed, not left waiting');
    assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'and the session is idle');
    assert.equal(sessionHolds.has(h.sessionId), false, 'hold cleared');
    assert.equal(h.hold!.released, true);

    // The kill lands moments later as an interrupted continuation; the hold is already over.
    const before = h.statuses.length;
    h.emit({ type: 'background_result', result: { backgroundInterrupted: true } as any });
    assert.equal(h.statuses.length, before, 'no second seal');
  } finally {
    h.restore();
  }
});

test('the seal stays quiet while another owner still holds the session', async () => {
  const h = await platformHold('slack:D-hold-shared');
  try {
    // A backgrounded `agent` run on the same session: it owns WORK, so it outlives the status hold.
    const work = holdSession({
      sessionId: h.sessionId, channel: h.channel, owner: 'agent-run:sa_1',
      handles: { onStop: () => {} }, track: () => {},
    });
    const before = h.statuses.length;

    h.emit({ type: 'background_result', result: { pendingBackgroundTasks: 0 } as any });
    assert.equal(h.statuses.length, before, 'the continuation hold does not seal a session that is still working');

    work.seal();
    assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false },
      'the last hold standing publishes the idle status');
  } finally {
    h.restore();
  }
});


// --- The streaming slot across a seal (T2.2b). The slot is channel-keyed and outlives the turn
// that registered it, so a hold's seal must release only the slot it owns: `supersedeHolds` fires
// the PREVIOUS turn's seal from inside the NEXT turn's `beginForegroundSession`, by which point the
// successor has already registered its own callback.

test('NEW: a platform hold superseded by the next turn leaves the successor\'s streaming slot alone', async () => {
  const h = await platformHold('slack:D-hold-supersede');
  try {
    assert.equal(activeTurns.streamingCallback(h.channel), h.ownedCallback,
      'the held turn still owns the slot while it waits');

    // The next user message arrives: its Turn registers its own streaming callback (turn.ts step
    // 5a) and only then opens the foreground session (step 4), which supersedes the hold.
    const successor = Object.assign((_t: string) => {}, { stream: {} as never });
    activeTurns.setStreamingCallback(h.channel, successor);
    assert.equal(sessionHolds.supersedeHolds(h.sessionId), true, 'the hold heard the takeover');

    await waitFor(() => /interrupted/i.test(h.lastStatus()));
    assert.match(h.lastStatus(), /interrupted/i, 'the superseded turn\'s status is still sealed honestly');
    assert.equal(activeTurns.streamingCallback(h.channel), successor,
      'and the seal did not cut the streaming of the turn that replaced it');
  } finally {
    h.restore();
  }
});

test('NEW: a platform hold sealing normally releases its own streaming slot', async () => {
  const h = await platformHold('slack:D-hold-seal-slot');
  try {
    assert.equal(activeTurns.streamingCallback(h.channel), h.ownedCallback, 'held, still streaming');

    h.emit({ type: 'background_timeout', reason: 'grace' });
    await waitFor(() => /Done/i.test(h.lastStatus()));
    await waitFor(() => activeTurns.streamingCallback(h.channel) === null);
    assert.equal(activeTurns.streamingCallback(h.channel), null,
      'nothing replaced the slot, so the seal tears it down exactly as before');
  } finally {
    h.restore();
  }
});
