// input:  lifecycle continuation entry points and session registry admission
// output: ask/retry lease handoff coverage around execution registration
// pos:    Guards retention from deleting sessions while lifecycle continuations start

import '../_test-home.js';
import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { mockStartAttempt } = vi.hoisted(() => ({
  mockStartAttempt: vi.fn<(input: StartAttemptInput) => RunAttempt>(),
}));

// The continuation paths now go through startRun -> domain/runs -> startAttempt, so the attempt
// chain is intercepted there. Returning a synthetic RunAttempt keeps the test about the lease
// handoff around execution registration, not about a spawned backend.
vi.mock('@domain/runs/attempt.js', () => ({
  startAttempt: (...args: unknown[]) => mockStartAttempt(...args as [StartAttemptInput]),
}));

vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getClaudeMode: () => 'api',
    getActiveProfile: () => 'default',
    resolveBackendForChannel: () => 'claude',
  };
});

import type { RunAttempt, StartAttemptInput } from '../../src/domain/runs/attempt.js';
import { resumeAskUserQuestionGroup } from '../../src/orchestration/interactions/ask-user-resume.js';
import { runRetryAgent } from '../../src/orchestration/edit-retry.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { MockAdapter } from '../../src/platform/testing.js';
import * as executionRegistry from '../../src/domain/executions/registry.js';
import { runRegistry } from '../../src/core/run-registry.js';

beforeEach(() => {
  vi.restoreAllMocks();
  mockStartAttempt.mockReset();
});

/** The synthetic attempt shape `startAttempt` hands the run; only the fields the run reads. */
function makeSyntheticAttempt(opts: {
  backendSessionId: string | null;
  foreground: Promise<unknown>;
}): RunAttempt {
  return {
    engine: {} as any,
    engineRun: {} as any,
    spec: {} as any,
    backend: 'claude' as any,
    identity: null,
    foreground: opts.foreground as Promise<any>,
    settled: opts.foreground as Promise<any>,
    backendSessionId: opts.backendSessionId,
    kill: () => true,
  };
}

function rejectedAttempt(backendSessionId: string, error: Error): RunAttempt {
  const promise = Promise.reject(error);
  promise.catch(() => {}); // avoid unhandled-rejection noise before the test awaits it
  return makeSyntheticAttempt({ backendSessionId, foreground: promise });
}

function installLeaseOrder(trackSessionId: string, events: string[]): void {
  vi.spyOn(sessionStore, 'acquireSessionUse').mockImplementation(async (id) => {
    assert.equal(id, trackSessionId);
    events.push('acquire');
    return () => { events.push('release'); };
  });
  vi.spyOn(sessionStore, 'getById').mockResolvedValue({
    name: `cortex-${trackSessionId}`, sessionId: trackSessionId, projectId: 'proj',
    channel: `web:${trackSessionId}`, backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
    label: null, profileName: null, backendSessionId: `backend-${trackSessionId}`,
  });
  vi.spyOn(executionRegistry, 'startLocalExecution').mockReturnValue({ id: `exec-${trackSessionId}` } as any);
  vi.spyOn(runRegistry, 'register').mockImplementation(() => { events.push('register'); return `rk-${trackSessionId}`; });
  vi.spyOn(runRegistry, 'complete').mockImplementation(() => true);
}

test('AskUserQuestion resume hands its session lease to the registered execution without a gap', async () => {
  const events: string[] = [];
  installLeaseOrder('track-ask', events);
  mockStartAttempt.mockImplementation(() => {
    events.push('run');
    return rejectedAttempt('backend-track-ask', new Error('stop after registration'));
  });

  await resumeAskUserQuestionGroup({
    adapter: new MockAdapter() as any,
    group: { channel: 'web:track-ask', sessionId: 'track-ask', groupId: 'group-ask' },
    responseText: 'answer',
  });

  assert.deepEqual(events.slice(0, 4), ['acquire', 'run', 'register', 'release']);
});

test('edit retry hands its session lease to the registered execution without a gap', async () => {
  const events: string[] = [];
  installLeaseOrder('track-retry', events);
  mockStartAttempt.mockImplementation(() => {
    events.push('run');
    return makeSyntheticAttempt({
      backendSessionId: 'backend-track-retry',
      foreground: Promise.resolve({ rateLimited: true, total_cost_usd: 0, num_turns: 1 }),
    });
  });

  await runRetryAgent({
    channel: 'web:track-retry', text: 'edited', adapter: new MockAdapter() as any,
    statusMsg: { conduit: 'web:track-retry', messageId: 'status' }, startTime: Date.now(),
    sessionId: 'track-retry', backendSessionId: 'backend-track-retry', sessionName: 'cortex-track-retry',
    projectId: 'proj', userMessageTs: 'M1', retryPrefix: '', onMessagePosted: () => {},
    retryDest: { type: 'interactive-reply', conduit: 'web:track-retry', sessionId: 'track-retry' },
    turnTrackingToken: 'token' as any,
  });

  assert.deepEqual(events.slice(0, 4), ['acquire', 'run', 'register', 'release']);
});
