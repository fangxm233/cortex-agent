// input:  conversation runner, cancellation, session registries
// output: backend prompt capture and interrupt/resume regressions
// pos:    Prompt identity and cancellation orchestration tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, expect, vi } from 'vitest';
import assert from 'node:assert/strict';

const { mockStartAttempt } = vi.hoisted(() => ({
  mockStartAttempt: vi.fn<(input: StartAttemptInput) => RunAttempt>(),
}));

// `startRun` opens the attempt chain through `startAttempt`; mocking that one entry point returns a
// synthetic `RunAttempt` so this orchestration suite observes the request/config the run assembles
// without ever spawning a backend. (The facade this used to intercept is gone.)
vi.mock('@domain/runs/attempt.js', () => ({
  startAttempt: (...args: unknown[]) => mockStartAttempt(...args as [StartAttemptInput]),
}));

vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
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

import type { RunAttempt, StartAttemptInput } from '../../src/domain/runs/attempt.js';
import { runConversation } from '../../src/orchestration/conversation-runner.js';
import { cancelChannelRuns } from '../../src/orchestration/routing/commands/cancel.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { getSessionAsync, setSessionAsync } from '../../src/domain/sessions/session.js';
import { resolveRunBackend } from '../../src/domain/runs/config-resolver.js';
import { runRegistry } from '../../src/core/run-registry.js';

/** The synthetic attempt shape `startAttempt` hands the run; only the fields the run reads. */
function makeSyntheticAttempt(opts: {
  backendSessionId: string | null;
  foreground: Promise<unknown>;
  backend?: string;
}): RunAttempt {
  return {
    engine: {} as any,
    engineRun: {} as any,
    spec: {} as any,
    backend: (opts.backend ?? 'claude') as any,
    identity: null,
    foreground: opts.foreground as Promise<any>,
    settled: opts.foreground as Promise<any>,
    backendSessionId: opts.backendSessionId,
    kill: () => true,
  };
}

function makeCancelledAttempt(backendSessionId: string): RunAttempt {
  const err = Object.assign(new Error('Cancelled'), { cancelled: true });
  const promise = Promise.reject(err);
  promise.catch(() => {}); // avoid unhandled-rejection noise before the test awaits it
  return makeSyntheticAttempt({ backendSessionId, foreground: promise });
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
  mockStartAttempt.mockReturnValueOnce(makeCancelledAttempt('B-claude-1'));

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
  mockStartAttempt.mockReturnValueOnce(makeCancelledAttempt('B-prompt'));

  await expect(runConversation(baseOpts({
    trackSessionId: 'TRACK-PROMPT',
    backendSessionId: 'B-existing',
    sessionName: 'cortex-prompt',
    onPromptBuilt: (prompt: string) => { capturedPrompt = prompt; },
  }))).rejects.toMatchObject({ cancelled: true });

  assert.equal(
    capturedPrompt,
    mockStartAttempt.mock.calls.at(-1)?.[0]?.request.prompt.text,
    'capture sees byte-for-byte adapter input',
  );
  assert.equal(capturedPrompt, 'hello', 'resumed direct turns send the user text without fresh-session context');
});

test('runConversation DEBUG prompt includes the image path sent through the adapter', async () => {
  let capturedPrompt: string | null = null;
  mockStartAttempt.mockReturnValueOnce(makeCancelledAttempt('B-image-prompt'));

  await expect(runConversation(baseOpts({
    trackSessionId: 'TRACK-IMAGE-PROMPT',
    backendSessionId: 'B-existing',
    sessionName: 'cortex-image-prompt',
    files: [{ localPath: '/tmp/cortex-image.png', mimetype: 'image/png', name: 'cortex-image.png' }],
    onPromptBuilt: (prompt: string) => { capturedPrompt = prompt; },
  }))).rejects.toMatchObject({ cancelled: true });

  assert.equal(
    capturedPrompt,
    '[User sent 1 image(s). Read these files to view them:\n/tmp/cortex-image.png\n]\n\nhello',
  );
});

test('interrupt on a RESUMED turn leaves the stored backend session id untouched', async () => {
  await sessionStore.registerSession('cortex-int2', {
    sessionId: 'TRACK-2', channel: 'slack:C-interrupt', backend: 'claude', kind: 'local',
    backendSessionId: 'B-old',
  });
  mockStartAttempt.mockReturnValueOnce(makeCancelledAttempt('B-old'));

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
  const backend = resolveRunBackend({ channel: 'slack:C-keep' });
  await setSessionAsync('slack:C-keep', 'TRACK-3', backend);
  runRegistry.register({
    threadId: null,
    channel: 'slack:C-keep',
    agentSlotId: null,
    executionId: null,
    registryKey: 'rk-cancel-test',
    kind: 'local',
    kill: () => true,
    backend,
    sessionId: 'B-backend-uuid', // spawn-time BACKEND id snapshot — must NOT become the binding
  });

  const n = await cancelChannelRuns('slack:C-keep');
  assert.equal(n, 1);
  assert.equal(await getSessionAsync('slack:C-keep', backend), 'TRACK-3');
});

test('runConversation registers both track and backend ids on the live execution handle', async () => {
  mockStartAttempt.mockReturnValueOnce(makeCancelledAttempt('B-live-1'));
  const before = new Set(runRegistry.getAll().map((entry) => entry.registryKey));
  const pending = runConversation(baseOpts({
    trackSessionId: 'TRACK-LIVE',
    backendSessionId: 'B-prev',
    sessionName: 'cortex-live',
  }));
  await Promise.resolve();
  const live = runRegistry.getAll().find((entry) => !before.has(entry.registryKey));
  assert.equal(live?.trackSessionId, 'TRACK-LIVE');
  assert.equal(live?.backendSessionId, 'B-live-1');
  await expect(pending).rejects.toMatchObject({ cancelled: true });
});
