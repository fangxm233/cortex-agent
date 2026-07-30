// input:  lifecycle success handler with mock output/context sink
// output: background hold, context, grace, interruption, and cap regressions
// pos:    Lifecycle background-continuation integration tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import '../_test-home.js'; // MUST be first — isolates store singletons
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleAgentSuccess } from '../../src/orchestration/lifecycle.js';
import { MockAdapter, MockOutputStream } from '../../src/platform/testing.js';
import type { ContinuationSink } from '../../src/agent-adapter/types.js';

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
  let sink: ContinuationSink | null = null;
  const contexts: number[] = [];
  const args = {
    channel: 'slack:D1', adapter: adapter as any, statusMsg: statusMsg as any,
    startTime: Date.now(), userMessage: 'run it in background', executionId: null,
    trigger: 'user', sessionName: 'cortex-test', threadAnchorId: null, userMessageTs: null,
    onAssistantMessage: onAssistantMessage as any, onToolUse: null,
    onContextUsage: (usage: { contextWindow: number }) => contexts.push(usage.contextWindow),
    registerContinuationSink: (s: ContinuationSink) => { sink = s; },
  };
  const lastStatus = () => (adapter.updated.at(-1)?.content?.text ?? '') as string;
  return { adapter, args, contexts, lastStatus, getSink: () => sink };
}

// The guard's grace/cap timers are env-injected to tiny values (50ms) and the rest is
// real promise-chain settling, so fake timers buy nothing here. Poll for the observable
// status instead of sleeping fixed padding. Returns quietly on timeout — the caller's
// assertion then fails with its own message.
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
}

function withEnv(t: any, key: string, value: string | undefined) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.onTestFinished(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; });
}

test('undelivered-only completions hold the status waiting and register a sink; continuation completes → sealed done', async (t) => {
  withEnv(t, 'CORTEX_BG_GRACE_S', '600'); // long grace — must NOT fire during this test
  const h = harness();

  await handleAgentSuccess({ ...h.args, result: baseResult({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 }) } as any);

  const sink = h.getSink();
  assert.ok(sink, 'continuation sink registered for undelivered-only hold');
  assert.match(h.lastStatus(), /Background task running/i, 'status held in waiting state');
  sink!.onContextUsage?.({
    usedTokens: 500, contextWindow: 1_000_000, percent: 0.05, accuracy: 'exact',
  });
  assert.deepEqual(h.contexts, [1_000_000], 'continuation context reaches the lifecycle callback');

  // The (late) notification arrives and the continuation turn completes.
  sink!.onResult(baseResult({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0, total_cost_usd: 0.01, num_turns: 1 }) as any);
  await waitFor(() => /Done/i.test(h.lastStatus()));
  assert.match(h.lastStatus(), /Done/i, 'status sealed done after continuation');
});

test('grace watchdog: no notification within grace → auto-finalized (status sealed, no hang)', async (t) => {
  withEnv(t, 'CORTEX_BG_GRACE_S', '0.05'); // 50ms grace
  const h = harness();

  await handleAgentSuccess({ ...h.args, result: baseResult({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 }) } as any);
  assert.match(h.lastStatus(), /Background task running/i, 'initially waiting');

  await waitFor(() => /Done/i.test(h.lastStatus())); // 50ms grace + settle
  assert.match(h.lastStatus(), /Done/i, 'grace timeout sealed the turn instead of waiting forever');
});

test('interrupted continuation (process death) → sealed with interruption note, not done', async (t) => {
  withEnv(t, 'CORTEX_BG_GRACE_S', '600');
  const h = harness();

  await handleAgentSuccess({ ...h.args, result: baseResult({ pendingBackgroundTasks: 1 }) } as any);
  const sink = h.getSink();
  assert.ok(sink, 'sink registered for running task');
  assert.match(h.lastStatus(), /Background task running/i);

  sink!.onResult({ ...baseResult({ pendingBackgroundTasks: 0 }), backgroundInterrupted: true } as any);
  await waitFor(() => /interrupted/i.test(h.lastStatus()));
  assert.match(h.lastStatus(), /interrupted/i, 'sealed with the interruption note');
  assert.doesNotMatch(h.lastStatus(), /Background task running/i, 'no longer waiting');
});

test('max-wait cap: long-running task exceeds cap → status sealed as still-running, sink kept for late merge', async (t) => {
  withEnv(t, 'CORTEX_BG_WAIT_MAX_S', '0.05'); // 50ms cap
  withEnv(t, 'CORTEX_BG_GRACE_S', '600');
  const h = harness();

  await handleAgentSuccess({ ...h.args, result: baseResult({ pendingBackgroundTasks: 1 }) } as any);
  assert.ok(h.getSink(), 'sink registered');

  await waitFor(() => /still running/i.test(h.lastStatus())); // 50ms cap + settle
  assert.match(h.lastStatus(), /still running/i, 'cap sealed the status with a still-running note');

  // A very late continuation still finalizes cleanly (sink was kept).
  h.getSink()!.onResult(baseResult({ pendingBackgroundTasks: 0, total_cost_usd: 0.01, num_turns: 1 }) as any);
  await waitFor(() => /Done/i.test(h.lastStatus()));
  assert.match(h.lastStatus(), /Done/i, 'late continuation sealed done after the cap');
});
