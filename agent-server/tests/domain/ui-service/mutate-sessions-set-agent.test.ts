import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSetAgent } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { Session } from '../../../src/store/session-registry-repo.js';

// The web twin of `!agent <name>`: resolve session→channel, delegate to the ONE switch rule, and
// map its refusals the way `sessions.setProfile` maps its own.

type SwitchOutcome = Awaited<ReturnType<NonNullable<UiServiceDeps['switchSessionAgent']>>>;
type SwitchCall = { channel: string; name: string | null };

function makeDeps(session: Session | null, outcome: SwitchOutcome, sink: SwitchCall[]): UiServiceDeps {
  return {
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => session },
    switchSessionAgent: async (opts: SwitchCall) => { sink.push(opts); return outcome; },
  } as unknown as UiServiceDeps;
}

const session = (channel: string): Session => ({
  name: 'cortex-1', sessionId: 'sess-1', projectId: 'general', channel,
  backend: 'claude', kind: 'local', createdAt: '', lastUsedAt: '', label: null, profileName: 'plan',
} as unknown as Session);

const ok = (agentName: string | null, effectiveProfile: string): SwitchOutcome =>
  ({ ok: true, agentName, effectiveProfile, backendChanged: false });

test('sessions.setAgent returns not-found when the session does not exist', async () => {
  const sink: SwitchCall[] = [];
  const res = await handleSetAgent(makeDeps(null, ok('nimbus', 'plan'), sink), { sessionId: 'ghost', agentName: 'nimbus' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.equal(sink.length, 0, 'no switch is attempted for a missing session');
});

test('sessions.setAgent resolves session→channel and reports the profile the agent runs under', async () => {
  const sink: SwitchCall[] = [];
  const res = await handleSetAgent(
    makeDeps(session('web:sess-1'), ok('nimbus', 'execute'), sink),
    { sessionId: 'sess-1', agentName: 'nimbus' },
  );
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data, { agentName: 'nimbus', profileName: 'execute', backendChanged: false });
  assert.deepEqual(sink[0], { channel: 'web:sess-1', name: 'nimbus' });
});

test('sessions.setAgent passes a null name through as "follow the global default"', async () => {
  const sink: SwitchCall[] = [];
  const res = await handleSetAgent(
    makeDeps(session('web:sess-1'), ok(null, 'plan'), sink),
    { sessionId: 'sess-1', agentName: null },
  );
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.data.agentName, null);
  assert.deepEqual(sink[0], { channel: 'web:sess-1', name: null });
});

test('sessions.setAgent maps unknown-agent to invalid-args', async () => {
  const sink: SwitchCall[] = [];
  const outcome: SwitchOutcome = { ok: false, agentName: null, effectiveProfile: '', backendChanged: false, reason: 'unknown-agent' };
  const res = await handleSetAgent(makeDeps(session('web:sess-1'), outcome, sink), { sessionId: 'sess-1', agentName: 'nope' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'invalid-args');
});

test('sessions.setAgent maps a cross-backend block to backend-locked (CONFLICT)', async () => {
  const sink: SwitchCall[] = [];
  const outcome: SwitchOutcome = {
    ok: false, agentName: null, effectiveProfile: '', backendChanged: false,
    reason: 'cross-backend-live-session', currentBackend: 'claude', targetBackend: 'pi',
  };
  const res = await handleSetAgent(makeDeps(session('web:sess-1'), outcome, sink), { sessionId: 'sess-1', agentName: 'atlas' });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'backend-locked');
    assert.match(res.message, /new session/i);
  }
});

test('a server without the agent-switch dependency says so rather than failing silently', async () => {
  const deps = {
    sessionStore: { getById: async () => session('web:sess-1') },
  } as unknown as UiServiceDeps;
  const res = await handleSetAgent(deps, { sessionId: 'sess-1', agentName: 'nimbus' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-available');
});
