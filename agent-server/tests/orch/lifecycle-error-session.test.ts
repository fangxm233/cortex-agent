import '../_test-home.js'; // MUST be first — isolates store singletons
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { handleAgentError } from '../../src/orchestration/lifecycle.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { getSessionAsync, setSessionAsync } from '../../src/domain/sessions/session.js';
import { resolveBackendForChannel } from '../../src/domain/agents/index.js';
import { MockAdapter } from '../../src/platform/testing.js';

function errorArgs(adapter: MockAdapter, channel: string, overrides: Record<string, unknown>) {
  return {
    error: { message: 'boom' },
    channel,
    adapter: adapter as any,
    statusMsg: { conduit: channel, messageId: 's1' } as any,
    startTime: Date.now(),
    executionId: null,
    userMessageTs: null,
    userMessage: null,
    ...overrides,
  } as any;
}

test('a failed turn records the backend id as the resume target, not as an identity', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const channel = 'C-err-1';
  const backend = resolveBackendForChannel(channel);
  await sessionStore.registerSession('cortex-err1', {
    sessionId: 'TRACK-E1', channel, backend, kind: 'local',
  });
  await setSessionAsync(channel, 'TRACK-E1', backend);

  await handleAgentError(errorArgs(adapter, channel, {
    sessionName: 'cortex-err1',
    sessionId: 'TRACK-E1',          // track id — the session's identity
    effectiveSessionId: 'B-ERR-1',  // backend id — only a resume target
  }));

  assert.equal(await getSessionAsync(channel, backend), 'TRACK-E1', 'channel stays on the track id');
  const rec = await sessionStore.getById('TRACK-E1');
  assert.equal(rec?.backendSessionId, 'B-ERR-1', 'the resume target is stored on the track record');
  assert.equal(await sessionStore.getById('B-ERR-1'), null, 'no ghost record keyed by the backend id');
  assert.equal(await sessionStore.lookupBySessionId('B-ERR-1'), null);
});

test('the error body is addressed by the track id (the TUI routes replies with it)', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const channel = 'C-err-2';
  const backend = resolveBackendForChannel(channel);
  await sessionStore.registerSession('cortex-err2', {
    sessionId: 'TRACK-E2', channel, backend, kind: 'local',
  });

  await handleAgentError(errorArgs(adapter, channel, {
    sessionName: 'cortex-err2', sessionId: 'TRACK-E2', effectiveSessionId: 'B-ERR-2',
  }));

  const body = adapter.posted.find((p) => p.destination.type === 'interactive-reply');
  assert.ok(body, 'the error body was posted');
  assert.equal((body!.destination as { sessionId?: string }).sessionId, 'TRACK-E2');
});

test('a turn that never reached a backend still registers its session under the track id', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const channel = 'C-err-3';
  const backend = resolveBackendForChannel(channel);

  await handleAgentError(errorArgs(adapter, channel, {
    sessionName: 'cortex-err3',
    sessionId: 'TRACK-E3',
    effectiveSessionId: null, // the ordinary interactive path passes no backend id
  }));

  const rec = await sessionStore.getById('TRACK-E3');
  assert.equal(rec?.name, 'cortex-err3', 'the missing record is backfilled');
  assert.equal(rec?.backendSessionId, null);
  assert.equal(await getSessionAsync(channel, backend), 'TRACK-E3');
});

test('a caller with no track id binds nothing (it cannot name the session)', async () => {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const channel = 'C-err-4';
  const backend = resolveBackendForChannel(channel);
  await setSessionAsync(channel, 'TRACK-E4', backend);

  await handleAgentError(errorArgs(adapter, channel, {
    sessionName: null, sessionId: null, effectiveSessionId: 'B-ERR-4',
  }));

  assert.equal(await getSessionAsync(channel, backend), 'TRACK-E4', 'binding untouched by the backend id');
  assert.equal(await sessionStore.lookupBySessionId('B-ERR-4'), null);
});
