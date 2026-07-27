// input:  conversation runner, cancel routing, isolated track/backend session registries
// output: exact assembled-prompt capture plus first-turn interrupt/resume regression coverage
// pos:    orchestration contract for prompt identity and stable tracking across cancellation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, expect, vi } from 'vitest';
import assert from 'node:assert/strict';

const mockRunAgent = vi.fn();

vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    runAgent: (...args: unknown[]) => mockRunAgent(...args),
    getDefaultAgent: () => 'main',
    getActiveProfile: () => 'default',
    getClaudeMode: () => 'api',
    resolveBackendForChannel: () => 'claude',
  };
});

vi.mock('@domain/threads/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    resolveAgentSlotConfigByName: (name: string) => ({
      slotId: name,
      profile: '__active__',
      persistSession: false,
      directive: '',
      systemPrompt: null,
      promptTemplate: '{{input}}',
      claudeAgent: null,
      outputStyle: null,
      tools: null,
      pluginDirs: null,
    }),
  };
});

import { runConversation } from '../../src/orchestration/conversation-runner.js';
import { cancelChannelRuns } from '../../src/orchestration/routing/commands/cancel.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { getSessionAsync, setSessionAsync } from '../../src/domain/sessions/session.js';
import { getActiveBackend } from '../../src/domain/agents/index.js';
import { runningExecutions } from '../../src/core/running-executions.js';

function makeCancelledHandle(backendSessionId: string) {
  const err = Object.assign(new Error('Cancelled'), { cancelled: true });
  const promise = Promise.reject(err);
  promise.catch(() => {}); // avoid unhandled-rejection noise before the test awaits it
  return { promise, kill: () => true, sessionId: backendSessionId, agentProcess: undefined };
}

function baseOpts(overrides: Record<string, unknown>) {
  return {
    adapter: {} as any,
    channel: 'slack:C-interrupt',
    userMessage: 'hello',
    projectId: 'general',
    files: [],
    startTime: Date.now(),
    ...overrides,
  } as any;
}

// ── (1) runConversation persists the backend resume target on settle ────────

test('first-turn kill persists the spawn-time backend session id (resume works on the next message)', async () => {
  await sessionStore.registerSession('cortex-int1', {
    sessionId: 'TRACK-1', channel: 'slack:C-interrupt', backend: 'claude', kind: 'local',
  });
  mockRunAgent.mockReturnValueOnce(makeCancelledHandle('B-claude-1'));

  await expect(runConversation(baseOpts({
    trackSessionId: 'TRACK-1',
    backendSessionId: null, // fresh session — first turn
    sessionName: 'cortex-int1',
  }))).rejects.toMatchObject({ cancelled: true });

  const rec = await sessionStore.getById('TRACK-1');
  assert.equal(rec?.backendSessionId, 'B-claude-1');
});

test('runConversation exposes the exact assembled prompt passed to the agent', async () => {
  let capturedPrompt: string | null = null;
  mockRunAgent.mockReturnValueOnce(makeCancelledHandle('B-prompt'));

  await expect(runConversation(baseOpts({
    trackSessionId: 'TRACK-PROMPT',
    backendSessionId: 'B-existing',
    sessionName: 'cortex-prompt',
    onPromptBuilt: (prompt: string) => { capturedPrompt = prompt; },
  }))).rejects.toMatchObject({ cancelled: true });

  assert.equal(capturedPrompt, mockRunAgent.mock.calls.at(-1)?.[0], 'capture sees byte-for-byte adapter input');
  assert.equal(capturedPrompt, 'hello', 'resumed direct turns send the user text without fresh-session context');
});

test('interrupt on a RESUMED turn leaves the stored backend session id untouched', async () => {
  await sessionStore.registerSession('cortex-int2', {
    sessionId: 'TRACK-2', channel: 'slack:C-interrupt', backend: 'claude', kind: 'local',
    backendSessionId: 'B-old',
  });
  mockRunAgent.mockReturnValueOnce(makeCancelledHandle('B-old'));

  await expect(runConversation(baseOpts({
    trackSessionId: 'TRACK-2',
    backendSessionId: 'B-old', // resumed session
    sessionName: 'cortex-int2',
  }))).rejects.toMatchObject({ cancelled: true });

  const rec = await sessionStore.getById('TRACK-2');
  assert.equal(rec?.backendSessionId, 'B-old');
});

// ── (2) cancelLive must not rebind the channel to the backend id ────────────

test('cancelChannelRuns keeps the channel bound to the stable track id', async () => {
  const backend = getActiveBackend();
  await setSessionAsync('slack:C-keep', 'TRACK-3', backend);
  runningExecutions.register({
    threadId: null,
    channel: 'slack:C-keep',
    agentSlotId: null,
    executionId: null,
    registryKey: 'rk-cancel-test',
    kind: 'local',
    kill: () => true,
    backend,
    agentProcess: undefined,
    sessionId: 'B-backend-uuid', // spawn-time BACKEND id snapshot — must NOT become the binding
  });

  const n = await cancelChannelRuns('slack:C-keep');
  assert.equal(n, 1);
  assert.equal(await getSessionAsync('slack:C-keep', backend), 'TRACK-3');
});
