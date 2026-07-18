import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleRewindSession } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { Session } from '../../../src/store/session-registry-repo.js';

interface RewindCall { sessionId: string; channel: string; turnIndex: number; text: string }

function makeDeps(session: Session | null, sink: RewindCall[], outcome: { ok: true } | { ok: false; reason: 'running' | 'not-found' } = { ok: true }): UiServiceDeps {
  return {
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => session },
    rewindSession: async (opts: RewindCall) => { sink.push(opts); return outcome; },
  } as unknown as UiServiceDeps;
}

const session = (channel: string): Session => ({
  name: 'cortex-1', sessionId: 'sess-1', projectId: 'general', channel,
  backend: 'claude', kind: 'local', createdAt: '', lastUsedAt: '', label: null,
} as unknown as Session);

test('sessions.rewind returns not-found for an unknown session', async () => {
  const sink: RewindCall[] = [];
  const res = await handleRewindSession(makeDeps(null, sink), { sessionId: 'ghost', turnIndex: 0, text: 'x' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.equal(sink.length, 0);
});

test('sessions.rewind rejects empty text', async () => {
  const sink: RewindCall[] = [];
  const res = await handleRewindSession(makeDeps(session('web:sess-1'), sink), { sessionId: 'sess-1', turnIndex: 0, text: '   ' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'invalid-args');
  assert.equal(sink.length, 0);
});

test('sessions.rewind resolves session→channel and delegates to the injected rewindSession dep', async () => {
  const sink: RewindCall[] = [];
  const res = await handleRewindSession(makeDeps(session('web:sess-1'), sink), { sessionId: 'sess-1', turnIndex: 2, text: 'edited' });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data, { accepted: true });
  assert.deepEqual(sink, [{ sessionId: 'sess-1', channel: 'web:sess-1', turnIndex: 2, text: 'edited' }]);
});

test('sessions.rewind maps a running session to code session-running (CONFLICT)', async () => {
  const sink: RewindCall[] = [];
  const res = await handleRewindSession(makeDeps(session('web:sess-1'), sink, { ok: false, reason: 'running' }), { sessionId: 'sess-1', turnIndex: 1, text: 'edited' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'session-running');
});

test('sessions.rewind maps an unknown turn to not-found', async () => {
  const sink: RewindCall[] = [];
  const res = await handleRewindSession(makeDeps(session('web:sess-1'), sink, { ok: false, reason: 'not-found' }), { sessionId: 'sess-1', turnIndex: 99, text: 'edited' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
});

test('sessions.rewind returns not-available when the dep is not wired', async () => {
  const deps = {
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => session('web:sess-1') },
  } as unknown as UiServiceDeps;
  const res = await handleRewindSession(deps, { sessionId: 'sess-1', turnIndex: 0, text: 'x' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-available');
});
