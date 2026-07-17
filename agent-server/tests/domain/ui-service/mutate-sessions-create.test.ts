import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCreateSession } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

interface CreateCall { projectId: string }

function makeDeps(sink: CreateCall[], sessionId = 'sess-new'): UiServiceDeps {
  return {
    projectStore: { getDefault: () => ({ id: 'general', name: 'general', kind: 'general', contextDir: '/g' }) },
    createDirectSession: async (opts: { projectId: string }) => {
      sink.push(opts);
      return { sessionId, sessionName: 'cortex-new', channel: `web:${sessionId}` };
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

test('sessions.create falls back to the default project when projectId is omitted', async () => {
  const sink: CreateCall[] = [];
  const res = await handleCreateSession(makeDeps(sink), {});
  assert.equal(res.ok, true);
  assert.deepEqual(sink, [{ projectId: 'general' }], 'uses the default project id');
});

test('sessions.create propagates a creation failure as an Err', async () => {
  const deps = {
    projectStore: { getDefault: () => ({ id: 'general' }) },
    createDirectSession: async () => { throw new Error('boom'); },
  } as unknown as UiServiceDeps;
  await assert.rejects(() => handleCreateSession(deps, { projectId: 'p' }), /boom/);
});
