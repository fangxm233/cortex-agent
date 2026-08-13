// input:  lifecycle continuation entry points and session registry admission
// output: ask/retry lease handoff coverage around execution registration
// pos:    Guards retention from deleting sessions while lifecycle continuations start

import '../_test-home.js';
import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const mockRunAgent = vi.fn();

vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    runAgent: (...args: unknown[]) => mockRunAgent(...args),
    getClaudeMode: () => 'api',
    getActiveProfile: () => 'default',
    resolveBackendForChannel: () => 'claude',
  };
});

import { resumeAskUserQuestionGroup, runRetryAgent } from '../../src/orchestration/lifecycle.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { MockAdapter } from '../../src/platform/testing.js';
import * as executionRegistry from '../../src/domain/executions/registry.js';
import { runningExecutions } from '../../src/core/running-executions.js';

beforeEach(() => {
  vi.restoreAllMocks();
  mockRunAgent.mockReset();
});

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
  vi.spyOn(runningExecutions, 'register').mockImplementation(() => { events.push('register'); return `rk-${trackSessionId}`; });
  vi.spyOn(runningExecutions, 'complete').mockImplementation(() => true);
}

test('AskUserQuestion resume hands its session lease to the registered execution without a gap', async () => {
  const events: string[] = [];
  installLeaseOrder('track-ask', events);
  mockRunAgent.mockImplementation(() => {
    events.push('run');
    return {
      promise: Promise.reject(new Error('stop after registration')),
      kill: () => true,
      sessionId: 'backend-track-ask',
    };
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
  mockRunAgent.mockImplementation(() => {
    events.push('run');
    return {
      promise: Promise.resolve({ rateLimited: true, total_cost_usd: 0, num_turns: 1 }),
      kill: () => true,
      sessionId: 'backend-track-retry',
    };
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
