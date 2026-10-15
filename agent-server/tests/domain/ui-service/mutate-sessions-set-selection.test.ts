import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSetSelection } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { EngineSelection, UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { Session } from '../../../src/store/session-registry-repo.js';
import { makeUiDeps } from './ui-deps-fixture.js';

type Outcome = Awaited<ReturnType<UiServiceDeps['applySessionSelection']>>;
type Request = Parameters<UiServiceDeps['applySessionSelection']>[0];
const selection: EngineSelection = { backend: 'claude', model: 'opus', provider: null, thinking: null, mode: 'plan' };
const applied = (over: Partial<Outcome> = {}): Outcome => ({
  ...selection, ok: true, backendChanged: false, ...over,
});
const session = { sessionId: 'sess-1', channel: 'web:sess-1', selection } as Session;
function deps(record: Session | null, outcome: Outcome, sink: Request[]): UiServiceDeps {
  return makeUiDeps({
    sessionStore: { getById: async () => record },
    applySessionSelection: async (opts) => { sink.push(opts); return outcome; },
  });
}

test('setSelection returns not-found without invoking the domain rule', async () => {
  const sink: Request[] = [];
  const res = await handleSetSelection(deps(null, applied(), sink), { sessionId: 'ghost', selection });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.deepEqual(sink, []);
});

test('setSelection forwards the complete choice and returns only public fields', async () => {
  const sink: Request[] = [];
  const next: EngineSelection = { backend: 'pi', provider: 'deepseek', model: 'flash', thinking: 'high', mode: 'deepseek' };
  const outcome = applied({ ...next, backendChanged: true, allowed: ['high'] });
  const res = await handleSetSelection(deps(session, outcome, sink), { sessionId: 'sess-1', selection: next });
  assert.deepEqual(sink, [{ channel: 'web:sess-1', ...next }]);
  assert.deepEqual(res, { ok: true, data: { ...next, backendChanged: true } });
});

test('setSelection preserves explicit null thinking and provider', async () => {
  const sink: Request[] = [];
  await handleSetSelection(deps(session, applied(), sink), { sessionId: 'sess-1', selection });
  assert.deepEqual(sink, [{ channel: 'web:sess-1', ...selection }]);
});

test('a cross-backend refusal becomes backend-locked (CONFLICT)', async () => {
  const outcome = applied({ ok: false, reason: 'cross-backend-live-session', currentBackend: 'claude', targetBackend: 'pi' });
  const res = await handleSetSelection(deps(session, outcome, []), { sessionId: 'sess-1', selection });
  assert.equal(res.ok, false);
  if (!res.ok) { assert.equal(res.code, 'backend-locked'); assert.match(res.message, /new session/i); }
});

test('invalid thinking names the legal levels', async () => {
  const outcome = applied({ ok: false, reason: 'invalid-thinking', allowed: ['low', 'high'] });
  const res = await handleSetSelection(deps(session, outcome, []), { sessionId: 'sess-1', selection: { ...selection, thinking: 'max' } });
  assert.equal(res.ok, false);
  if (!res.ok) { assert.equal(res.code, 'invalid-args'); assert.match(res.message, /low, high/); }
});

test('invalid route names the legal routes', async () => {
  const outcome = applied({ ok: false, reason: 'invalid-mode', allowed: ['plan', 'api'] });
  const res = await handleSetSelection(deps(session, outcome, []), { sessionId: 'sess-1', selection: { ...selection, mode: 'wrong' } });
  assert.equal(res.ok, false);
  if (!res.ok) { assert.equal(res.code, 'invalid-args'); assert.match(res.message, /plan, api/); }
});

test('provider and other domain refusals map to invalid-args', async () => {
  for (const reason of ['provider-not-supported', 'invalid-model']) {
    const res = await handleSetSelection(deps(session, applied({ ok: false, reason }), []), { sessionId: 'sess-1', selection });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'invalid-args');
  }
});
