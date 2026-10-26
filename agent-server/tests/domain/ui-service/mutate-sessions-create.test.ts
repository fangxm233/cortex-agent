import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCreateAndSend, handleCreateSession } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { EngineSelection, UiServiceDeps } from '../../../src/domain/ui-service/types.js';

interface CreateCall {
  projectId: string;
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
  assert.deepEqual(sink, [{ projectId: 'nimbus' }], 'creates under the requested project');
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

test('sessions.createAndSend forwards clean mode only when asked', async () => {
  const calls: Array<{ clean?: boolean }> = [];
  const deps = {
    createDirectSession: async (opts: { clean?: boolean }) => {
      calls.push(opts);
      return { sessionId: 'sess-cl', channel: 'web:sess-cl' };
    },
    sendSessionMessage: () => {},
  } as unknown as UiServiceDeps;

  await handleCreateAndSend(deps, { projectId: 'nimbus', text: 'hi', clean: true });
  await handleCreateAndSend(deps, { projectId: 'nimbus', text: 'hi', clean: false });
  assert.equal(calls[0]?.clean, true);
  assert.equal('clean' in calls[1]!, false);
});
