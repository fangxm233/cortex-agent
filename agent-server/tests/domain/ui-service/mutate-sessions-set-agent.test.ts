import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSetAgent } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { Session } from '../../../src/store/session-registry-repo.js';
import { makeUiDeps } from './ui-deps-fixture.js';

type Outcome = Awaited<ReturnType<UiServiceDeps['switchSessionAgent']>>;
type Call = { channel: string; name: string | null };
const session = { sessionId: 's', channel: 'web:s', backend: 'claude' } as Session;
function deps(record: Session | null, outcome: Outcome, sink: Call[]): UiServiceDeps {
  return makeUiDeps({
    sessionStore: { getById: async () => record },
    switchSessionAgent: async (opts) => { sink.push(opts); return outcome; },
    applySessionSelection: async () => { throw new Error('agent changes must not change engines'); },
  });
}

test('setAgent returns not-found without invoking the domain rule', async () => {
  const sink: Call[] = [];
  const res = await handleSetAgent(deps(null, { ok: true, agentName: 'nimbus' }, sink), { sessionId: 'ghost', agentName: 'nimbus' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.deepEqual(sink, []);
});

test('setAgent resolves the session channel and changes only the environment', async () => {
  const sink: Call[] = [];
  const res = await handleSetAgent(deps(session, { ok: true, agentName: 'nimbus' }, sink), { sessionId: 's', agentName: 'nimbus' });
  assert.deepEqual(res, { ok: true, data: { agentName: 'nimbus' } });
  assert.deepEqual(sink, [{ channel: 'web:s', name: 'nimbus' }]);
});

test('null and absent agentName both follow the default environment', async () => {
  const sink: Call[] = [];
  const d = deps(session, { ok: true, agentName: null }, sink);
  assert.deepEqual(await handleSetAgent(d, { sessionId: 's', agentName: null }), { ok: true, data: { agentName: null } });
  assert.deepEqual(await handleSetAgent(d, { sessionId: 's' }), { ok: true, data: { agentName: null } });
  assert.deepEqual(sink, [{ channel: 'web:s', name: null }, { channel: 'web:s', name: null }]);
});

test('unknown environments map to invalid-args', async () => {
  const res = await handleSetAgent(deps(session, { ok: false, agentName: null, reason: 'unknown-agent' }, []), { sessionId: 's', agentName: 'nope' });
  assert.equal(res.ok, false);
  if (!res.ok) { assert.equal(res.code, 'invalid-args'); assert.equal(res.message, 'Unknown environment: nope'); }
});
