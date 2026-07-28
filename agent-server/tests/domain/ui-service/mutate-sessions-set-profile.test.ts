import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSetProfile } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { Session } from '../../../src/store/session-registry-repo.js';

type SwitchOutcome = Awaited<ReturnType<UiServiceDeps['switchSessionProfile']>>;

function makeDeps(session: Session | null, outcome: SwitchOutcome, sink: Array<{ channel: string; name: string }>): UiServiceDeps {
  return {
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => session },
    switchSessionProfile: async (opts) => { sink.push(opts); return outcome; },
  } as unknown as UiServiceDeps;
}

const session = (channel: string): Session => ({
  name: 'cortex-1', sessionId: 'sess-1', projectId: 'general', channel,
  backend: 'claude', kind: 'local', createdAt: '', lastUsedAt: '', label: null, profileName: 'plan',
} as unknown as Session);

const ok = (name: string, backendChanged: boolean): SwitchOutcome => ({ ok: true, name, currentBackend: 'claude', targetBackend: 'claude', backendChanged });

test('sessions.setProfile returns not-found when the session does not exist', async () => {
  const sink: Array<{ channel: string; name: string }> = [];
  const res = await handleSetProfile(makeDeps(null, ok('execute', false), sink), { sessionId: 'ghost', profileName: 'execute' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.equal(sink.length, 0, 'no switch is attempted for a missing session');
});

test('sessions.setProfile resolves session→channel and applies the switch', async () => {
  const sink: Array<{ channel: string; name: string }> = [];
  const res = await handleSetProfile(makeDeps(session('web:sess-1'), ok('execute', false), sink), { sessionId: 'sess-1', profileName: 'execute' });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data, { profileName: 'execute', backendChanged: false });
  assert.deepEqual(sink[0], { channel: 'web:sess-1', name: 'execute' });
});

test('sessions.setProfile maps unknown-profile to invalid-args', async () => {
  const sink: Array<{ channel: string; name: string }> = [];
  const outcome: SwitchOutcome = { ok: false, name: 'nope', currentBackend: '', targetBackend: '', backendChanged: false, reason: 'unknown-profile' };
  const res = await handleSetProfile(makeDeps(session('web:sess-1'), outcome, sink), { sessionId: 'sess-1', profileName: 'nope' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'invalid-args');
});

test('sessions.setProfile maps a cross-backend block to backend-locked (CONFLICT)', async () => {
  const sink: Array<{ channel: string; name: string }> = [];
  const outcome: SwitchOutcome = { ok: false, name: 'execute', currentBackend: 'claude', targetBackend: 'pi', backendChanged: true, reason: 'cross-backend-live-session' };
  const res = await handleSetProfile(makeDeps(session('web:sess-1'), outcome, sink), { sessionId: 'sess-1', profileName: 'execute' });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'backend-locked');
    assert.match(res.message, /new session/i);
  }
});
