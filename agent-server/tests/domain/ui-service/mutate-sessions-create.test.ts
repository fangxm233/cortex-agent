import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCreateSession } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

interface CreateCall {
  projectId: string;
  browser?: { device: string } | null;
  commission?: { mode: 'new' } | { mode: 'join'; commissionId: string } | null;
}

function makeDeps(sink: CreateCall[], sessionId = 'sess-new'): UiServiceDeps {
  return {
    projectStore: { getDefault: () => ({ id: 'general', name: 'general', kind: 'general', contextDir: '/g' }) },
    createDirectSession: async (opts: CreateCall) => {
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
  // browser/commission null is the default — a session gets either mode only when it asks.
  assert.deepEqual(sink, [{ projectId: 'nimbus', browser: null, commission: null }], 'creates under the requested project');
});

test('sessions.create falls back to the default project when projectId is omitted', async () => {
  const sink: CreateCall[] = [];
  const res = await handleCreateSession(makeDeps(sink), {});
  assert.equal(res.ok, true);
  assert.deepEqual(sink, [{ projectId: 'general', browser: null, commission: null }], 'uses the default project id');
});

test('sessions.create forwards an explicit browser opt-in', async () => {
  const sink: CreateCall[] = [];
  await handleCreateSession(makeDeps(sink), { projectId: 'nimbus', browser: { device: 'server' } });
  assert.deepEqual(sink, [{ projectId: 'nimbus', browser: { device: 'server' }, commission: null }]);
});

test('sessions.create forwards a commission opt-in, both new and join', async () => {
  const fresh: CreateCall[] = [];
  await handleCreateSession(makeDeps(fresh), { projectId: 'nimbus', commission: { mode: 'new' } });
  assert.deepEqual(fresh, [{ projectId: 'nimbus', browser: null, commission: { mode: 'new' } }]);

  const join: CreateCall[] = [];
  await handleCreateSession(makeDeps(join), { projectId: 'nimbus', commission: { mode: 'join', commissionId: 'cm_1' } });
  assert.deepEqual(join, [{ projectId: 'nimbus', browser: null, commission: { mode: 'join', commissionId: 'cm_1' } }]);
});

test('sessions.create propagates a creation failure as an Err', async () => {
  const deps = {
    projectStore: { getDefault: () => ({ id: 'general' }) },
    createDirectSession: async () => { throw new Error('boom'); },
  } as unknown as UiServiceDeps;
  await assert.rejects(() => handleCreateSession(deps, { projectId: 'p' }), /boom/);
});
