import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSetSelection } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { Session } from '../../../src/store/session-registry-repo.js';

// The handler's whole job: session → channel, one call to the domain rule, and a faithful mapping
// of its refusals onto Result codes. The rule itself is covered in domain/agents/model-selection.

type Outcome = Awaited<ReturnType<NonNullable<UiServiceDeps['applySessionSelection']>>>;
type Request = Parameters<NonNullable<UiServiceDeps['applySessionSelection']>>[0];

const applied = (over: Partial<Outcome> = {}): Outcome => ({
  ok: true, backendChanged: false, profileName: 'opus', backend: 'claude',
  model: 'claude-opus-5', provider: null, thinking: null, mode: 'plan', override: null, ...over,
});

function makeDeps(session: Session | null, outcome: Outcome, sink: Request[]): UiServiceDeps {
  return {
    sessionStore: {
      listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [],
      getById: async () => session,
    },
    applySessionSelection: async (opts: Request) => { sink.push(opts); return outcome; },
  } as unknown as UiServiceDeps;
}

const session = (channel: string): Session => ({
  name: 'cortex-1', sessionId: 'sess-1', projectId: 'general', channel,
  backend: 'claude', kind: 'local', createdAt: '', lastUsedAt: '', label: null, profileName: 'opus',
} as unknown as Session);

test('sessions.setSelection returns not-found when the session does not exist', async () => {
  const sink: Request[] = [];
  const res = await handleSetSelection(makeDeps(null, applied(), sink), {
    sessionId: 'ghost', selection: { model: 'x' },
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.equal(sink.length, 0, 'nothing is applied for a missing session');
});

test('sessions.setSelection forwards the whole request on the session channel', async () => {
  const sink: Request[] = [];
  const outcome = applied({
    profileName: 'ds', backend: 'pi', model: 'deepseek-v4-flash', provider: 'deepseek',
    thinking: 'high', override: { model: 'deepseek-v4-flash', thinking: 'high' }, backendChanged: true,
  });
  const res = await handleSetSelection(makeDeps(session('web:sess-1'), outcome, sink), {
    sessionId: 'sess-1', profileName: 'ds', selection: { model: 'deepseek-v4-flash', thinking: 'high' },
  });
  assert.deepEqual(sink[0], {
    channel: 'web:sess-1', profileName: 'ds', model: 'deepseek-v4-flash',
    provider: null, thinking: 'high', mode: null,
  }, 'a field the client did not state is an explicit "back to the profile"');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.data, {
      profileName: 'ds', backend: 'pi', model: 'deepseek-v4-flash', provider: 'deepseek',
      thinking: 'high', mode: 'plan',
      override: { model: 'deepseek-v4-flash', thinking: 'high' }, backendChanged: true,
    });
  }
});

test('a stated selection replaces the whole override; an absent one leaves it alone', async () => {
  const sink: Request[] = [];
  await handleSetSelection(makeDeps(session('web:sess-1'), applied(), sink), {
    sessionId: 'sess-1', selection: { thinking: 'high' },
  });
  assert.deepEqual(sink[0], {
    channel: 'web:sess-1', profileName: undefined, model: null, provider: null,
    thinking: 'high', mode: null,
  });

  sink.length = 0;
  await handleSetSelection(makeDeps(session('web:sess-1'), applied(), sink), {
    sessionId: 'sess-1', profileName: 'sonnet',
  });
  assert.deepEqual(sink[0], { channel: 'web:sess-1', profileName: 'sonnet' },
    'no selection stated — the profile switch decides what happens to the old one');
});

test('a cross-backend refusal becomes backend-locked (CONFLICT)', async () => {
  const sink: Request[] = [];
  const outcome = applied({
    ok: false, reason: 'cross-backend-live-session', currentBackend: 'claude', targetBackend: 'pi',
  });
  const res = await handleSetSelection(makeDeps(session('web:sess-1'), outcome, sink), {
    sessionId: 'sess-1', profileName: 'ds',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'backend-locked');
    assert.match(res.message, /new session/i);
  }
});

test('an unsupported thinking level becomes invalid-args and names the legal set', async () => {
  const sink: Request[] = [];
  const outcome = applied({ ok: false, reason: 'invalid-thinking', allowed: ['low', 'high'] });
  const res = await handleSetSelection(makeDeps(session('web:sess-1'), outcome, sink), {
    sessionId: 'sess-1', selection: { thinking: 'max' },
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'invalid-args');
    assert.match(res.message, /low, high/);
  }
});
