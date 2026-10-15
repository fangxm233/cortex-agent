import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCreateAndSend, handleCreateSession } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { EngineSelection, UiServiceDeps } from '../../../src/domain/ui-service/types.js';

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
// Apply the draft's complete engine choice before the first turn.
interface CreateAndSendCall { selection?: EngineSelection }

test('sessions.createAndSend forwards an optional complete engine choice', async () => {
  const calls: CreateAndSendCall[] = [];
  const deps = {
    createDirectSession: async (opts: CreateAndSendCall) => {
      calls.push(opts);
      return { sessionId: 'sess-cs', channel: 'web:sess-cs' };
    },
    sendSessionMessage: () => {},
  } as unknown as UiServiceDeps;

  const bare = await handleCreateAndSend(deps, { projectId: 'nimbus', text: 'hi' });
  assert.equal(bare.ok, true);
  assert.equal(calls[0]?.selection, undefined, 'omission lets the lifecycle materialize its default');

  const selection: EngineSelection = { backend: 'claude', provider: null, model: 'claude-sonnet-5', thinking: null, mode: 'plan' };
  await handleCreateAndSend(deps, { projectId: 'nimbus', selection, text: 'hi' });
  assert.deepEqual(calls[1]?.selection, selection);
});
