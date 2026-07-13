import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCancelSession } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { Session } from '../../../src/store/session-registry-repo.js';

interface CancelCall { channel: string }

function makeDeps(session: Session | null, sink: CancelCall[], killed: number): UiServiceDeps {
  return {
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => session },
    cancelSessionRun: async (opts: { channel: string }) => { sink.push(opts); return killed; },
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
  } as unknown as UiServiceDeps;
}

const session = (channel: string): Session => ({
  name: 'cortex-1', sessionId: 'sess-1', projectId: 'general', channel,
  backend: 'claude', kind: 'local', createdAt: '', lastUsedAt: '', label: null,
} as unknown as Session);

test('sessions.cancel returns not-found when the session does not exist', async () => {
  const sink: CancelCall[] = [];
  const res = await handleCancelSession(makeDeps(null, sink, 0), { sessionId: 'ghost' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.equal(sink.length, 0, 'no cancel is dispatched for a missing session');
});

test('sessions.cancel resolves session→channel and reports what was cancelled', async () => {
  const sink: CancelCall[] = [];
  const res = await handleCancelSession(makeDeps(session('C123'), sink, 2), { sessionId: 'sess-1' });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data, { cancelled: true, count: 2 });
  assert.equal(sink.length, 1);
  assert.deepEqual(sink[0], { channel: 'C123' });
});

test('sessions.cancel reports cancelled:false when nothing was running', async () => {
  const sink: CancelCall[] = [];
  const res = await handleCancelSession(makeDeps(session('C123'), sink, 0), { sessionId: 'sess-1' });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data, { cancelled: false, count: 0 });
  assert.equal(sink.length, 1);
});
