// input:  UI send admission, AgentRunner, web rewind
// output: send-first rejection and rewind-first ordering regressions
// pos:    Verifies send and rewind mutation admission
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSendSession } from '../../src/domain/ui-service/mutate/sessions.js';
import { AgentRunner } from '../../src/orchestration/agent-runner.js';
import { rewindWebSession, type RewindDeps } from '../../src/orchestration/session-rewind.js';
import { sendWebUserMessage } from '../../src/orchestration/session-send.js';
import { tryAcquireTurnMutationLock } from '../../src/orchestration/turn-mutation-lock.js';
import { MockAdapter } from '../../src/platform/testing.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function conversation(channel: string) {
  return {
    sessionId: 'track-race', sessionName: 'cortex-race', backend: 'claude', profileName: null,
    turns: [{
      turnIndex: 0, userMessageTs: 'm0', userMessageText: 'original', statusMessageTs: null,
      responseMessageTimestamps: [], executionId: null, backupPath: null,
      status: 'completed' as const, createdAt: '', updatedAt: '',
    }],
    updatedAt: '', channel,
  };
}

function makeRewindDeps(channel: string, overrides: Partial<RewindDeps> = {}): RewindDeps {
  const conv = conversation(channel);
  return {
    activeAgents: { hasChannel: () => false },
    snapshotPending: () => false,
    tryAcquireMutation: tryAcquireTurnMutationLock,
    ledger: {
      getConversation: async () => conv,
      rollbackTo: async () => ({ supersededTurns: conv.turns, conversation: conv }),
      truncateTurns: async () => {},
    },
    history: {
      truncateFromTurn: async () => ({ text: 'original', ts: 'm0' }),
      appendEditMarker: async () => {},
    },
    sessionStore: {
      getById: async () => ({
        name: 'cortex-race', sessionId: 'track-race', backendSessionId: 'backend-race',
        channel, backend: 'claude',
      } as any),
      updateSession: async () => {},
    },
    backup: {
      restoreBackup: async () => false,
      cleanupBackupsAfter: () => {},
      cleanupAllBackups: () => {},
      findPISessionFile: async () => null,
      restoreSessionFile: async () => false,
      restoreSessionBackup: async () => false,
      sessionFileFromBackupPath: () => null,
      cleanupBackupsForFile: () => {},
      cleanupAllBackupsForFile: () => {},
    },
    resolveBackend: () => 'claude',
    registerPISessionPath: () => {},
    closePooledSession: () => {},
    send: (opts) => { opts.mutationRelease?.(); },
    publishRewound: () => {},
    ...overrides,
  };
}

function acceptSend(channel: string, text: string, adapter: MockAdapter, runner: AgentRunner) {
  return handleSendSession({
    sessionStore: { getById: async () => ({ channel }) },
    sendSessionMessage: (opts: { channel: string; text: string }) => {
      sendWebUserMessage({
        channel: opts.channel, text: opts.text, adapter,
        route: (ctx) => runner.route(ctx),
      });
    },
  } as any, { sessionId: 'track-race', text } as any);
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
}

test('an accepted send reserves mutation admission before its first asynchronous gate', async () => {
  const channel = `web:send-first-${Date.now()}`;
  const injection = deferred<boolean>();
  const runner = new AgentRunner({
    tryInject: async () => injection.promise,
    track: () => {},
    execute: async () => {},
  });
  const adapter = new MockAdapter();

  assert.deepEqual(await acceptSend(channel, 'ordinary', adapter, runner), {
    ok: true, data: { accepted: true },
  });
  const rewind = await rewindWebSession(
    { sessionId: 'track-race', channel, turnIndex: 0, text: 'edited', adapter: adapter as any },
    makeRewindDeps(channel),
  );

  injection.resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rewind, { ok: false, reason: 'running' });
});

test('a rewind transfers its admission to the edited resend ahead of waiting sends', async () => {
  const channel = `web:rewind-first-${Date.now()}`;
  const markerEntered = deferred<void>();
  const releaseMarker = deferred<void>();
  const executions: string[] = [];
  const adapter = new MockAdapter();
  const runner = new AgentRunner({
    tryInject: async () => false,
    track: () => {},
    execute: async (ctx) => { executions.push(ctx.userMessage); },
  });
  const base = makeRewindDeps(channel);
  const deps = makeRewindDeps(channel, {
    history: {
      ...base.history,
      appendEditMarker: async () => {
        markerEntered.resolve();
        await releaseMarker.promise;
      },
    },
    send: (opts) => {
      sendWebUserMessage({
        channel: opts.channel, text: opts.text, adapter,
        mutationRelease: opts.mutationRelease,
        route: (ctx) => runner.route(ctx),
      });
    },
  });

  const rewind = rewindWebSession(
    { sessionId: 'track-race', channel, turnIndex: 0, text: 'edited', adapter: adapter as any },
    deps,
  );
  await markerEntered.promise;
  assert.deepEqual(await acceptSend(channel, 'ordinary', adapter, runner), {
    ok: true, data: { accepted: true },
  });
  releaseMarker.resolve();

  assert.deepEqual(await rewind, { ok: true });
  await waitFor(() => executions.length === 2);
  assert.deepEqual(executions, ['edited', 'ordinary']);
});
