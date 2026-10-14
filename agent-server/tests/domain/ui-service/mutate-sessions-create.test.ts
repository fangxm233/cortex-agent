import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCreateAndSend, handleCreateSession } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

interface CreateCall {
  projectId: string;
  browser?: { device: string } | null;
}

function makeDeps(sink: CreateCall[], sessionId = 'sess-new'): UiServiceDeps {
  return {
    projectStore: { getDefault: () => ({ id: 'general', name: 'general', kind: 'general', contextDir: '/g' }) },
    createDirectSession: async (opts: CreateCall) => {
      sink.push(opts);
      return { sessionId, channel: `web:${sessionId}` };
    },
  } as unknown as UiServiceDeps;
}

test('sessions.create returns the new session id', async () => {
  const sink: CreateCall[] = [];
  const res = await handleCreateSession(makeDeps(sink), { projectId: 'nimbus' });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data, { sessionId: 'sess-new' });
  // browser null is the default — a session gets browser tools only when it asks.
  assert.deepEqual(sink, [{ projectId: 'nimbus', browser: null }], 'creates under the requested project');
});

// ── sessions.createAndSend ──────────────────────────────────────
// The draft composer is the only create path with a user's engine pick behind it, so what it states
// is also what the NEXT new conversation opens on. An absent selection is that statement too —
// "follow the profile" — and has to reach the domain rule, or a model taken back in a draft is
// re-offered by every draft after it.

interface CreateAndSendCall { profileName: string | null; selection: unknown }

test('sessions.createAndSend states the composer selection, empty when nothing is overridden', async () => {
  const calls: CreateAndSendCall[] = [];
  const deps = {
    createDirectSession: async (opts: CreateAndSendCall) => {
      calls.push(opts);
      return { sessionId: 'sess-cs', channel: 'web:sess-cs' };
    },
    sendSessionMessage: () => {},
  } as unknown as UiServiceDeps;

  const bare = await handleCreateAndSend(deps, { projectId: 'nimbus', profileName: 'opus', text: 'hi' });
  assert.equal(bare.ok, true);
  assert.deepEqual(calls[0]?.selection, {}, 'a composer overriding nothing still states the empty selection');

  await handleCreateAndSend(deps, {
    projectId: 'nimbus', profileName: 'opus', selection: { model: 'claude-sonnet-5' }, text: 'hi',
  });
  assert.deepEqual(calls[1]?.selection, { model: 'claude-sonnet-5' }, 'a stated override is passed through as-is');
});
