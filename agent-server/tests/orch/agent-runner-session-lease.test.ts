// input:  AgentRunner execution seam, session lease, and mutation routing
// output: direct-run lease release coverage for registered and early-failure paths
// pos:    verifies AgentRunner holds session use until execution registration

import '../_test-home.js';
import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const mockGetSessionAsync = vi.fn();
const mockSetSessionAsync = vi.fn();
const mockRegisterNamedSession = vi.fn();
const mockRunConversation = vi.fn();

vi.mock('@domain/sessions/session.js', () => ({
  getSessionAsync: (...args: unknown[]) => mockGetSessionAsync(...args),
  setSessionAsync: (...args: unknown[]) => mockSetSessionAsync(...args),
}));

vi.mock('@domain/sessions/session-lifecycle.js', () => ({
  registerNamedSession: (...args: unknown[]) => mockRegisterNamedSession(...args),
}));

vi.mock('../../src/orchestration/conversation-runner.js', () => ({
  runConversation: (...args: unknown[]) => mockRunConversation(...args),
}));

import { AgentRunner } from '../../src/orchestration/agent-runner.js';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
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

beforeEach(() => {
  vi.restoreAllMocks();
});

test('AgentRunner holds session use until onExecutionRegistered then releases it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runner-lease-'));
  const repo = new SessionRegistryRepo(path.join(root, 'session-registry.jsonl'));
  await repo.registerSession('cortex-live', {
    sessionId: 'track-live', channel: 'slack:C-live', backend: 'claude', kind: 'local', projectId: 'proj',
  });
  const getByIdSpy = vi.spyOn(sessionStore, 'getById').mockImplementation(repo.getById.bind(repo));
  const acquireSpy = vi.spyOn(sessionStore, 'acquireSessionUse').mockImplementation(repo.acquireSessionUse.bind(repo));
  mockGetSessionAsync.mockResolvedValue('track-live');
  mockRunConversation.mockImplementation(async (opts: any) => {
    const pendingBefore = await repo.beginDeleteExpired(new Date('2100-01-01T00:00:00.000Z'), []);
    assert.deepEqual(pendingBefore, []);
    opts.onExecutionRegistered?.();
    const pendingAfter = await repo.beginDeleteExpired(new Date('2100-01-01T00:00:00.000Z'), []);
    assert.deepEqual(pendingAfter.map((entry: any) => entry.session.sessionId), ['track-live']);
    return {
      result: { total_cost_usd: 0, num_turns: 1, finalOutput: 'ok', pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0 },
      executionId: 'exec-1',
      agentProcess: undefined,
    };
  });

  const runner = new AgentRunner({ tryInject: async () => false, track: () => {} });
  await (runner as any)._executeReal(ctx('slack:C-live'), () => {}, async () => []);

  assert.ok(getByIdSpy.mock.calls.length >= 1);
  assert.ok(acquireSpy.mock.calls.length >= 1);
});

test('AgentRunner releases session use when runConversation fails before execution registration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runner-lease-fail-'));
  const repo = new SessionRegistryRepo(path.join(root, 'session-registry.jsonl'));
  await repo.registerSession('cortex-fail', {
    sessionId: 'track-fail', channel: 'slack:C-fail', backend: 'claude', kind: 'local', projectId: 'proj',
  });
  vi.spyOn(sessionStore, 'getById').mockImplementation(repo.getById.bind(repo));
  vi.spyOn(sessionStore, 'acquireSessionUse').mockImplementation(repo.acquireSessionUse.bind(repo));
  mockGetSessionAsync.mockResolvedValue('track-fail');
  mockRunConversation.mockRejectedValue(new Error('boom'));

  const runner = new AgentRunner({ tryInject: async () => false, track: () => {} });
  await (runner as any)._executeReal(ctx('slack:C-fail'), () => {}, async () => []);

  const pending = await repo.beginDeleteExpired(new Date('2100-01-01T00:00:00.000Z'), []);
  assert.deepEqual(pending.map((entry) => entry.session.sessionId), ['track-fail']);
});
