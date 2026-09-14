// input:  openTurn driven directly, with `startRun` as the only faked seam
// output: the four contracts the Turn adds on top of what turn-golden.test.ts already pins —
//         the ledger-less turn, the status prefix, the hold hand-off, and the cleanup when the
//         request cannot even be assembled
// pos:    orchestration/turn — companion to tests/orch/turn-golden.test.ts. That file characterizes
//         the ORDER of a whole turn through `AgentRunner.route`; this one drives `openTurn` the way
//         edit-retry / ask-user-resume do, i.e. with their `TurnInput` differences.

import '../_test-home.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { mockStartRun } = vi.hoisted(() => ({ mockStartRun: vi.fn() }));

vi.mock('@domain/runs/service.js', () => ({
  startRun: (...args: unknown[]) => mockStartRun(...args),
}));

import type { AgentResult } from '../../src/core/types/agent-types.js';
import type { AgentRun } from '../../src/domain/runs/run.js';
import type { RunEvent } from '../../src/domain/runs/events.js';
import type { RunObserver } from '../../src/domain/runs/request.js';
import { Capability } from '../../src/agent-adapter/capabilities.js';
import { openTurn, type TurnInput } from '../../src/orchestration/turn/turn.js';
import { activeTurns } from '../../src/orchestration/turn/active-turns.js';
import { getOrchestrationRuntime, setOrchestrationRuntime } from '../../src/orchestration/runtime.js';
import { conversationLedger } from '../../src/store/conversation-ledger-repo.js';
import { sessionHolds } from '../../src/core/session-holds.js';
import { MockAdapter } from '../../src/platform/testing.js';

function agentResult(partial: Partial<AgentResult> = {}): AgentResult {
  return {
    finalOutput: 'ok', total_cost_usd: 0, num_turns: 1,
    pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0,
    ...partial,
  } as AgentResult;
}

/** The slice of `AgentRun` a turn touches. `capabilities` decides whether a hold is even possible. */
function fakeRun(result: Promise<AgentResult>, capabilities = new Set<Capability>()): AgentRun {
  return {
    id: 'run-turn', executionId: 'exec-turn', status: 'running', phase: 'foreground', numTurns: null,
    backendSessionId: 'backend-turn', capabilities, result, settled: result,
    steer: async () => 'refused', respondToDialog: () => false, cancel: () => {},
    subscribe: () => () => {}, backgroundTranscriptOwned: false,
    claimBackgroundTranscript: () => {}, ingestExternal: () => false,
  } as unknown as AgentRun;
}

const FAKE_REQUEST = {
  request: {
    runId: 'run-turn',
    session: { sessionId: 's', backendSessionId: null, engineKey: 'c', sessionName: 'n' },
    profile: {} as any, spec: {} as any, prompt: { text: 'hello', attachments: [] },
    context: { channel: 'c', project: 'general', trigger: 'user' }, policy: {} as any,
  } as any,
  backendPrompt: 'hello',
};

interface Harness {
  adapter: MockAdapter;
  statuses: Array<{ running: boolean; backgroundRunning?: boolean }>;
  /** Run observers `startRun` was handed — index 0 is the Turn's foreground observer. */
  observers: RunObserver[];
  leaseReleases: number;
}

let restoreBus: unknown;
let restoreDebug: string | undefined;

beforeEach(() => {
  mockStartRun.mockReset();
  // Same pin as turn-golden: an ambient DEBUG adds a fire-and-forget history write.
  restoreDebug = process.env.DEBUG;
  delete process.env.DEBUG;
});

afterEach(() => {
  setOrchestrationRuntime({ bus: restoreBus as never });
  if (restoreDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = restoreDebug;
  vi.restoreAllMocks();
});

function harness(): Harness {
  const h: Harness = { adapter: new MockAdapter(), statuses: [], observers: [], leaseReleases: 0 };
  restoreBus = getOrchestrationRuntime().bus;
  setOrchestrationRuntime({ bus: {
    publish: (event: any) => {
      if (event.type === 'session.status') {
        h.statuses.push({ running: event.running, backgroundRunning: event.backgroundRunning });
      }
    },
    subscribe: () => ({ unsubscribe() {} }),
  } as never });
  return h;
}

function turnInput(h: Harness, channel: string, overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    channel,
    adapter: h.adapter as never,
    threadAnchorId: null,
    session: {
      sessionId: `track-${channel}`, sessionName: `cortex-${channel}`,
      backendSessionId: null, projectId: 'general',
      lease: { release: () => { h.leaseReleases += 1; } },
    },
    user: { text: 'hello' },
    ledger: null,
    trigger: 'user',
    prepareRequest: async () => FAKE_REQUEST,
    ...overrides,
  } as TurnInput;
}

/** Record the observers and hand back the fake run. */
function answerWith(h: Harness, run: () => AgentRun): void {
  mockStartRun.mockImplementation((_request: unknown, observers: RunObserver[]) => {
    h.observers.push(...observers);
    return run();
  });
}

// ── 1. `ledger: null` — the ask-user-resume shape ────────────────────────────

test('a turn with ledger:null opens and completes no conversation-ledger turn', async () => {
  const h = harness();
  const init = vi.spyOn(conversationLedger, 'initAndBeginTurn');
  const complete = vi.spyOn(conversationLedger, 'completeTurn');
  answerWith(h, () => fakeRun(Promise.resolve(agentResult())));

  await openTurn(turnInput(h, 'slack:C-turn-noledger', { ledger: null }));

  assert.equal(init.mock.calls.length, 0, 'no ledger turn is opened');
  assert.equal(complete.mock.calls.length, 0, 'and none is completed');
  // The rest of the turn still happened: status posted + sealed, busy bracket closed, lease dropped.
  assert.equal(h.adapter.posted.length, 1);
  assert.equal(h.adapter.updated.length >= 1, true);
  assert.deepEqual(h.statuses.map((s) => s.running), [true, false]);
  assert.equal(h.leaseReleases, 1, 'the lease is released exactly once');
  assert.equal(activeTurns.has('slack:C-turn-noledger'), false, 'the turn deregistered itself');
});

// ── 2. statusPrefix — the edit-retry shape ───────────────────────────────────

test('statusPrefix rides both the opening status message and every progress rewrite', async () => {
  const h = harness();
  const prefix = '🔁 Retry (edited) | ';
  answerWith(h, () => {
    // Progress arrives while the turn is open, through the foreground observer startRun was given.
    queueMicrotask(() => {
      h.observers[0]?.onEvent({ type: 'turn_progress', numTurns: 2, phase: 'foreground' } as RunEvent);
    });
    return fakeRun(new Promise((resolve) => setTimeout(() => resolve(agentResult()), 10)));
  });

  await openTurn(turnInput(h, 'slack:C-turn-prefix', { statusPrefix: prefix }));

  assert.equal(h.adapter.posted[0].content.text.startsWith(prefix), true, 'opening status carries the prefix');
  const progressWrites = h.adapter.updated.filter((u: any) => typeof u.content.text === 'string' && u.content.text.startsWith(prefix));
  assert.equal(progressWrites.length >= 1, true, 'the progress rewrite carries it too');
});

// ── 3. a background hold takes the session over ──────────────────────────────

test('when a background hold takes over, openTurn resolves and publishes no running:false', async () => {
  const h = harness();
  const channel = 'web:C-turn-hold';
  const sessionId = `track-${channel}`;
  answerWith(h, () => fakeRun(
    Promise.resolve(agentResult({ pendingBackgroundTasks: 1 })),
    new Set([Capability.BackgroundContinuation]),
  ));

  // openTurn resolving at all IS the assertion that the hold does not block the turn.
  await expect(openTurn(turnInput(h, channel))).resolves.toBeUndefined();

  assert.deepEqual(
    h.statuses,
    [{ running: true, backgroundRunning: undefined }, { running: true, backgroundRunning: true }],
    'running:true, then the hold’s running+background — and no idle seal',
  );
  // The hold owns the seal. Firing it (what Stop does) is what ends the session.
  sessionHolds.stopHolds(sessionId);
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
});

// ── 4. prepareRequest throws ─────────────────────────────────────────────────

test('a request that cannot be assembled still releases the lease, seals and publishes running:false', async () => {
  const h = harness();
  await openTurn(turnInput(h, 'slack:C-turn-prepfail', {
    prepareRequest: async () => { throw new Error('prepare exploded'); },
  }));

  assert.equal(mockStartRun.mock.calls.length, 0, 'no run was opened');
  assert.equal(h.leaseReleases, 1, 'the lease is released by the turn’s finally');
  assert.deepEqual(h.statuses.map((s) => s.running), [true, false], 'the busy bracket is closed');
  // handleAgentError seals the status message and posts the error body as a new message.
  assert.equal(h.adapter.updated.length >= 1, true, 'the status message was sealed');
  assert.equal(
    h.adapter.posted.some((p: any) => String(p.content.text).includes('prepare exploded')),
    true,
    'the error body reached the channel',
  );
  assert.equal(activeTurns.has('slack:C-turn-prepfail'), false);
});
