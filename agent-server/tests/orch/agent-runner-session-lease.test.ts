// input:  AgentRunner execution seam, session lease, and mutation routing
// output: direct-run lease release coverage for registered and early-failure paths
// pos:    verifies AgentRunner holds session use until execution registration
//
// The seam moved with the turn body: `runConversation` no longer exists, so the two things this
// file used to fake through it are faked one level down — `prepareConversationRequest` (the request
// assembly, which runs while the lease is still held) and `startRun` (the backend). The lease
// contract under test is unchanged: held until the execution is registered, released there, and
// released by the turn's finally when the turn fails before it.

import '../_test-home.js';
import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const mockGetSessionAsync = vi.fn();
const mockSetSessionAsync = vi.fn();
const mockRegisterNamedSession = vi.fn();
const mockPrepareRequest = vi.fn();
const mockStartRun = vi.fn();

vi.mock('@domain/sessions/session.js', () => ({
  getSessionAsync: (...args: unknown[]) => mockGetSessionAsync(...args),
  setSessionAsync: (...args: unknown[]) => mockSetSessionAsync(...args),
}));

vi.mock('@domain/sessions/session-lifecycle.js', () => ({
  registerNamedSession: (...args: unknown[]) => mockRegisterNamedSession(...args),
}));

vi.mock('../../src/orchestration/conversation-request.js', () => ({
  prepareConversationRequest: (...args: unknown[]) => mockPrepareRequest(...args),
}));

vi.mock('@domain/runs/service.js', () => ({
  startRun: (...args: unknown[]) => mockStartRun(...args),
}));

import type { AgentRun } from '../../src/domain/runs/run.js';
import { AgentRunner } from '../../src/orchestration/agent-runner.js';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { sessionUse, activeSessionUseIds } from '../../src/domain/sessions/session-use.js';
import { MockAdapter } from '../../src/platform/testing.js';

function ctx(channel: string) {
  return {
    message: { ref: { conduit: channel, messageId: 'M1', threadId: null }, text: 'hello', isBot: false, files: [] } as any,
    channel,
    adapter: new MockAdapter() as any,
    threadAnchorId: null,
    hasFiles: false,
    userMessage: 'hello',
    agentMessage: 'hello',
  };
}

/** The slice of `AgentRun` a turn touches. `result` is resolved lazily so the test can observe the
 *  lease at the moment the turn awaits it — i.e. AFTER execution registration. */
function fakeRun(resultOf: () => Promise<any>): AgentRun {
  let pending: Promise<any> | null = null;
  const result = () => (pending ??= resultOf());
  return {
    id: 'run-lease', executionId: 'exec-1', status: 'running', phase: 'foreground', numTurns: null,
    backendSessionId: 'backend-lease', capabilities: new Set(),
    get result() { return result(); },
    get settled() { return result(); },
    steer: async () => 'refused', respondToDialog: () => false, cancel: () => {},
    subscribe: () => () => {}, backgroundTranscriptOwned: false,
    claimBackgroundTranscript: () => {}, ingestExternal: () => false,
  } as unknown as AgentRun;
}

const FAKE_REQUEST = {
  request: {
    runId: 'run-lease', session: { sessionId: 'track-live', backendSessionId: null, engineKey: 'c', sessionName: 'cortex-live' },
    profile: {} as any, spec: {} as any, prompt: { text: 'hello', attachments: [] },
    context: { channel: 'c', project: 'proj', trigger: 'user' }, policy: {} as any,
  } as any,
  backendPrompt: 'hello',
};

beforeEach(() => {
  vi.restoreAllMocks();
  mockPrepareRequest.mockReset();
  mockStartRun.mockReset();
  // The use counter now lives in the domain tracker singleton, not the store. Clear it so a
  // dangling lease from a prior test cannot protect this test's session.
  sessionUse._resetForTests();
});

test('AgentRunner holds session use until onExecutionRegistered then releases it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runner-lease-'));
  const repo = new SessionRegistryRepo(path.join(root, 'session-registry.jsonl'));
  await repo.registerSession('cortex-live', {
    sessionId: 'track-live', channel: 'slack:C-live', backend: 'claude', kind: 'local', projectId: 'proj',
  });
  const getByIdSpy = vi.spyOn(sessionStore, 'getById').mockImplementation(repo.getById.bind(repo));
  const touchSpy = vi.spyOn(sessionStore, 'touchSessionUse').mockImplementation(repo.touchSessionUse.bind(repo));
  mockGetSessionAsync.mockResolvedValue('track-live');
  // Request assembly runs while the lease is still held — retention protects the in-use session by
  // unioning `activeSessionUseIds()` into the protected set (the store no longer counts uses).
  mockPrepareRequest.mockImplementation(async () => {
    const pendingBefore = await repo.beginDeleteExpired(new Date('2100-01-01T00:00:00.000Z'), [...activeSessionUseIds()]);
    assert.deepEqual(pendingBefore, []);
    return FAKE_REQUEST;
  });
  // The result is awaited after the execution is registered, which is where the lease is dropped —
  // the session then falls out of `activeSessionUseIds()` and is deletable.
  mockStartRun.mockImplementation(() => fakeRun(async () => {
    const pendingAfter = await repo.beginDeleteExpired(new Date('2100-01-01T00:00:00.000Z'), [...activeSessionUseIds()]);
    assert.deepEqual(pendingAfter.map((entry: any) => entry.session.sessionId), ['track-live']);
    return { total_cost_usd: 0, num_turns: 1, finalOutput: 'ok', pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0 };
  }));

  const runner = new AgentRunner({ tryInject: async () => false, track: () => {} });
  await (runner as any)._executeReal(ctx('slack:C-live'), () => {}, async () => []);

  assert.ok(getByIdSpy.mock.calls.length >= 1);
  assert.ok(touchSpy.mock.calls.length >= 1);
});

test('AgentRunner releases session use when the turn fails before execution registration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runner-lease-fail-'));
  const repo = new SessionRegistryRepo(path.join(root, 'session-registry.jsonl'));
  await repo.registerSession('cortex-fail', {
    sessionId: 'track-fail', channel: 'slack:C-fail', backend: 'claude', kind: 'local', projectId: 'proj',
  });
  vi.spyOn(sessionStore, 'getById').mockImplementation(repo.getById.bind(repo));
  vi.spyOn(sessionStore, 'touchSessionUse').mockImplementation(repo.touchSessionUse.bind(repo));
  mockGetSessionAsync.mockResolvedValue('track-fail');
  mockPrepareRequest.mockRejectedValue(new Error('boom'));

  const runner = new AgentRunner({ tryInject: async () => false, track: () => {} });
  await (runner as any)._executeReal(ctx('slack:C-fail'), () => {}, async () => []);

  // The turn's finally released the lease, so the session is no longer in `activeSessionUseIds()`.
  assert.deepEqual([...activeSessionUseIds()], []);
  const pending = await repo.beginDeleteExpired(new Date('2100-01-01T00:00:00.000Z'), []);
  assert.deepEqual(pending.map((entry) => entry.session.sessionId), ['track-fail']);
});
