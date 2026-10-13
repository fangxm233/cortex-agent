import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { mockStartRun } = vi.hoisted(() => ({ mockStartRun: vi.fn() }));

vi.mock('@domain/runs/service.js', () => ({
  startRun: (...args: unknown[]) => mockStartRun(...args),
}));

import type { AgentResult } from '../../src/core/types/agent-types.js';
import type { AgentRun } from '../../src/domain/runs/run.js';
import { Capability } from '../../src/agent-adapter/capabilities.js';
import { openTurn, type TurnInput } from '../../src/orchestration/turn/turn.js';
import { getOrchestrationRuntime, setOrchestrationRuntime } from '../../src/orchestration/runtime.js';
import { sessionHolds } from '../../src/core/session-holds.js';
import { MockAdapter } from '../../src/platform/testing.js';

function agentResult(partial: Partial<AgentResult> = {}): AgentResult {
  return {
    finalOutput: 'the answer', total_cost_usd: 0, num_turns: 1,
    pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0,
    ...partial,
  } as AgentResult;
}

function fakeRun(result: Promise<AgentResult>, capabilities = new Set<Capability>()): AgentRun {
  result.catch(() => {});
  return {
    id: 'run-tc', executionId: 'exec-tc', status: 'running', phase: 'foreground', numTurns: null,
    backendSessionId: 'backend-tc', capabilities, result, settled: result,
    steer: async () => 'refused', respondToDialog: () => false, cancel: () => {},
    subscribe: () => () => {}, backgroundTranscriptOwned: false,
    claimBackgroundTranscript: () => {}, ingestExternal: () => false,
  } as unknown as AgentRun;
}

const FAKE_REQUEST = {
  request: {
    runId: 'run-tc',
    session: { sessionId: 's', backendSessionId: null, engineKey: 'c'},
    profile: {} as any, spec: {} as any, prompt: { text: 'hello', attachments: [] },
    context: { channel: 'c', project: 'general', trigger: 'user' }, policy: {} as any,
  } as any,
  backendPrompt: 'hello',
};

let restoreBus: unknown;
let completed: any[];
const adapter = new MockAdapter();

beforeEach(() => {
  mockStartRun.mockReset();
  completed = [];
  restoreBus = getOrchestrationRuntime().bus;
  setOrchestrationRuntime({ bus: {
    publish: (event: any) => { if (event.type === 'session.turn.completed') completed.push(event); },
    subscribe: () => ({ unsubscribe() {} }),
  } as never });
});

afterEach(() => {
  setOrchestrationRuntime({ bus: restoreBus as never });
  vi.restoreAllMocks();
});

function input(channel: string, overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    channel,
    adapter: adapter as never,
    threadAnchorId: null,
    session: {
      sessionId: `track-${channel}`, backendSessionId: null, projectId: 'general', lease: null,
    },
    user: { text: 'hello' },
    ledger: null,
    trigger: 'user',
    origin: 'team-lead',
    prepareRequest: async () => FAKE_REQUEST,
    ...overrides,
  } as TurnInput;
}

test('a completed turn reports its final output and the origin of its opening message', async () => {
  mockStartRun.mockImplementation(() => fakeRun(Promise.resolve(agentResult())));
  await openTurn(input('web:tc-ok'));
  assert.equal(completed.length, 1);
  assert.deepEqual(
    { ...completed[0] },
    {
      type: 'session.turn.completed', sessionId: 'track-web:tc-ok', channel: 'web:tc-ok',
      status: 'completed', finalOutput: 'the answer', trigger: 'team-lead', executionId: 'exec-tc',
    },
  );
});

test('without an origin the surface trigger stands in', async () => {
  mockStartRun.mockImplementation(() => fakeRun(Promise.resolve(agentResult())));
  await openTurn(input('web:tc-trigger', { origin: undefined, trigger: 'edit-retry' }));
  assert.equal(completed[0].trigger, 'edit-retry');
});

test('a rate-limited turn that will auto-resume publishes nothing', async () => {
  mockStartRun.mockImplementation(() => fakeRun(Promise.resolve(agentResult({
    rateLimited: true, rateLimitProvider: 'anthropic',
  }))));
  await openTurn(input('web:tc-rl'));
  assert.equal(completed.length, 0);
});

test('a failed turn reports failed with the error message', async () => {
  mockStartRun.mockImplementation(() => fakeRun(Promise.reject(new Error('backend exploded'))));
  await openTurn(input('web:tc-fail'));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, 'failed');
  assert.equal(completed[0].finalOutput, 'backend exploded');
});

test('a cancelled turn reports stopped', async () => {
  mockStartRun.mockImplementation(() => fakeRun(
    Promise.reject(Object.assign(new Error('Run cancelled (user)'), { cancelled: true })),
  ));
  await openTurn(input('web:tc-stop'));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, 'stopped');
});

test('a held turn reports when its hold seals, not when the foreground ends', async () => {
  const channel = 'web:tc-hold';
  mockStartRun.mockImplementation(() => fakeRun(
    Promise.resolve(agentResult({ pendingBackgroundTasks: 1 })),
    new Set([Capability.BackgroundContinuation]),
  ));
  await openTurn(input(channel));
  assert.equal(completed.length, 0, 'the hold owns the end of the turn');
  sessionHolds.stopHolds(`track-${channel}`);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, 'stopped');
  assert.equal(completed[0].finalOutput, 'the answer');
  assert.equal(completed[0].executionId, 'exec-tc', 'the seal reports the run it ended');
});
