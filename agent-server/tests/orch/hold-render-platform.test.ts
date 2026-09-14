// The Slack/Feishu rendering of a held turn. Migrated from `lifecycle-bg-hold.test.ts` when the
// hold moved out of `handleAgentSuccess` (T2.2): the five verdict assertions below are unchanged,
// only the way they are driven is — `holdBackgroundContinuation` + `platformHoldRenderer` instead
// of the terminal handler, which now only decides that the turn MAY be held.
import '../_test-home.js'; // MUST be first — isolates store singletons
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { holdBackgroundContinuation } from '../../src/orchestration/turn/background-hold.js';
import { platformHoldRenderer } from '../../src/orchestration/turn/hold-render-platform.js';
import { sessionHolds } from '../../src/core/session-holds.js';
import { MockAdapter, MockOutputStream } from '../../src/platform/testing.js';
import type { RunEvent } from '../../src/domain/runs/events.js';
import type { RunObserver } from '../../src/domain/runs/request.js';
import { costRepo } from '../../src/domain/costs/cost-tracker.js';

beforeEach(() => sessionHolds.clear());

function baseResult(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-bg-1', total_cost_usd: 0.02, num_turns: 3,
    rateLimited: false, rateLimitMessage: null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    finalOutput: 'ok',
    ...overrides,
  };
}

let statusSeq = 0;

function harness() {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  // Unique per test: writeStatus/sealStatus state is keyed by message ref and a sealed
  // status message rejects further writes — reusing an id would leak state across tests.
  const statusMsg = { conduit: 'slack:D1', messageId: `status-${++statusSeq}` };
  const stream = new MockOutputStream(adapter, { type: 'interactive-reply', conduit: 'slack:D1', sessionId: '' });
  const onAssistantMessage = Object.assign((_t: string) => {}, { stream });
  // The hold subscribes to the RUN now, so the test drives it with the same RunEvents production
  // emits. Which bound the run arms (and pausing them while a continuation streams) is pinned in
  // tests/runs/service.test.ts; here we deliver the run's verdict directly, so these tests depend
  // on no wall-clock timer at all.
  let observer: RunObserver | null = null;
  let claimed = false;
  const backgroundRun = {
    claimBackgroundTranscript(): void { claimed = true; },
    subscribe(o: RunObserver): () => void { observer = o; return () => { observer = null; }; },
  };
  const emit = (event: RunEvent): void => {
    assert.ok(observer, 'no observer subscribed — the hold did not install');
    observer!.onEvent(event);
  };
  const contexts: number[] = [];
  const args = {
    channel: 'slack:D1', executionId: `exec-bg-${statusSeq}`,
    trackSessionId: `session-bg-${statusSeq}`,
  };
  /** Open the hold the way the Turn does: one lifecycle, this surface's renderer. */
  const hold = (result: Record<string, unknown>) => holdBackgroundContinuation({
    run: backgroundRun, result: result as any, channel: args.channel,
    sessionId: args.trackSessionId, userMessage: 'run it in background',
    executionId: args.executionId,
    // The busy bracket itself is `background-hold.test.ts`'s; muted here so the status rendering
    // does not signal the supervisor over IPC.
    track: () => {},
    renderer: platformHoldRenderer({
      adapter: adapter as any, statusMsg: statusMsg as any, channel: args.channel, stream,
      sessionName: 'cortex-test', sessionId: (result.sessionId as string) ?? null,
      trackSessionId: args.trackSessionId, startTime: Date.now(), baseResult: result as any,
      userMessageTs: null, executionId: args.executionId, trigger: 'user',
      projectId: 'cortex-self', backend: 'claude',
      onToolUse: null, onToolResult: null,
      onContextUsage: (usage: { contextWindow: number }) => contexts.push(usage.contextWindow),
    }),
  });
  const lastStatus = () => (adapter.updated.at(-1)?.content?.text ?? '') as string;
  return {
    adapter, args, contexts, lastStatus, stream, emit, hold,
    held: () => observer !== null,
    claimedTranscript: () => claimed,
    result: (r: Record<string, unknown>) => emit({ type: 'background_result', result: r as any }),
    grace: () => emit({ type: 'background_timeout', reason: 'grace' }),
    maxWait: () => emit({ type: 'background_timeout', reason: 'max-wait' }),
  };
}

// The verdicts are delivered synchronously; what is still asynchronous is the promise chain each
// one kicks off (seal, cost, ledger). Poll for the observable status instead of sleeping fixed
// padding. Returns quietly on timeout — the caller's assertion then fails with its own message.
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond()) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
}

test('undelivered-only completions hold the status waiting and subscribe to the run; continuation completes → sealed done', async () => {
  const h = harness();

  await h.hold(baseResult({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 }));

  assert.ok(h.held(), 'hold subscribed to the run for an undelivered-only result');
  assert.ok(h.claimedTranscript(), 'the hold claims the background transcript so nothing double-writes it');
  assert.match(h.lastStatus(), /Background task running/i, 'status held in waiting state');
  h.emit({
    type: 'context_usage', phase: 'background',
    usedTokens: 500, contextWindow: 1_000_000, percent: 0.05, accuracy: 'exact',
  });
  assert.deepEqual(h.contexts, [1_000_000], 'continuation context reaches the turn\'s persistence callback');

  // The (late) notification arrives and the continuation turn completes.
  h.result(baseResult({
    pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0,
    total_cost_usd: 0.01, costReported: true, num_turns: 1,
    reportedAccounting: {
      usageReported: true, inputTokens: 0, outputTokens: 2,
      cacheReadTokens: 0, cacheCreationTokens: 3,
      promptTokens: 3, cachedTokens: 0, model: 'claude-fixture',
    },
  }));
  await waitFor(() => /Done/i.test(h.lastStatus()));
  assert.match(h.lastStatus(), /Done/i, 'status sealed done after continuation');
  // The cost row is written AFTER the seal, on the same detached promise chain, so poll for it
  // rather than assuming the seal implies it.
  const readRows = async (): Promise<Array<Record<string, any>>> => {
    await costRepo.flush();
    return (await costRepo.readCosts()).entries
      .filter(entry => entry.execution_id === h.args.executionId) as Array<Record<string, any>>;
  };
  let rows = await readRows();
  await waitFor(async () => (rows = await readRows()).length > 0);
  assert.equal(rows.length, 1);
  assert.deepEqual({
    session: rows[0].session_id, input: rows[0].input_tokens,
    output: rows[0].output_tokens, cacheRead: rows[0].cache_read_tokens,
    cacheCreation: rows[0].cache_creation_tokens, requests: rows[0].provider_requests,
  }, {
    session: h.args.trackSessionId, input: 0, output: 2,
    cacheRead: 0, cacheCreation: 3, requests: 1,
  });
});

test('background prose merges into the originating reply; a subagent\'s notes and foreground events do not', async () => {
  const h = harness();
  await h.hold(baseResult({ pendingBackgroundTasks: 1 }));

  h.emit({ type: 'assistant_text', phase: 'background', text: 'the build finished' });
  h.emit({ type: 'assistant_text', phase: 'background', text: 'inner working notes', subagent: { id: 's1', name: 'explore' } as any });
  h.emit({ type: 'assistant_text', phase: 'foreground', text: 'this belongs to the turn that already ended' });

  const merged = h.adapter.posted.map(m => (m.content as any)?.text ?? '').join('\n');
  assert.match(merged, /the build finished/, 'the continuation answer merges into the same reply');
  assert.doesNotMatch(merged, /inner working notes/, "a subagent's prose stays out of the chat reply");
  assert.doesNotMatch(merged, /already ended/, 'foreground-phase events are not the hold\'s business');
});

test('grace watchdog: no notification within grace → auto-finalized (status sealed, no hang)', async () => {
  const h = harness();

  await h.hold(baseResult({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 }));
  assert.match(h.lastStatus(), /Background task running/i, 'initially waiting');

  h.grace();
  await waitFor(() => /Done/i.test(h.lastStatus()));
  assert.match(h.lastStatus(), /Done/i, 'grace timeout sealed the turn instead of waiting forever');
});

test('interrupted continuation (process death) → sealed with interruption note, not done', async () => {
  const h = harness();

  await h.hold(baseResult({ pendingBackgroundTasks: 1 }));
  assert.ok(h.held(), 'hold subscribed for a running task');
  assert.match(h.lastStatus(), /Background task running/i);

  h.result({ ...baseResult({ pendingBackgroundTasks: 0 }), backgroundInterrupted: true });
  await waitFor(() => /interrupted/i.test(h.lastStatus()));
  assert.match(h.lastStatus(), /interrupted/i, 'sealed with the interruption note');
  assert.doesNotMatch(h.lastStatus(), /Background task running/i, 'no longer waiting');
});

test('max-wait cap: long-running task exceeds cap → status sealed as still-running, subscription kept for late merge', async () => {
  const h = harness();

  await h.hold(baseResult({ pendingBackgroundTasks: 1 }));
  assert.ok(h.held(), 'hold subscribed');

  h.maxWait();
  await waitFor(() => /still running/i.test(h.lastStatus()));
  assert.match(h.lastStatus(), /still running/i, 'cap sealed the status with a still-running note');

  // A very late continuation still finalizes cleanly (the subscription was kept).
  h.result(baseResult({ pendingBackgroundTasks: 0, total_cost_usd: 0.01, num_turns: 1 }));
  await waitFor(() => /Done/i.test(h.lastStatus()));
  assert.match(h.lastStatus(), /Done/i, 'late continuation sealed done after the cap');
});
