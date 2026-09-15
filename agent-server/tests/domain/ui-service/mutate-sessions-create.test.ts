import '../../_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCreateAndSend, handleCreateSession } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { resetSettingsForTests } from '../../../src/core/settings.js';

/** settings.commissionEnabled is the feature's kill switch and defaults to ON (DR-0037 v4). Both
 *  helpers set it explicitly the way an operator would, so neither test depends on the default. */
async function withCommission(value: '1' | '0', fn: () => Promise<void>): Promise<void> {
  process.env.CORTEX_COMMISSION_ENABLED = value;
  resetSettingsForTests();
  try {
    await fn();
  } finally {
    delete process.env.CORTEX_COMMISSION_ENABLED;
    resetSettingsForTests();
  }
}
const withCommissionEnabled = (fn: () => Promise<void>) => withCommission('1', fn);
const withCommissionDisabled = (fn: () => Promise<void>) => withCommission('0', fn);

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
  await withCommissionEnabled(async () => {
    const fresh: CreateCall[] = [];
    await handleCreateSession(makeDeps(fresh), { projectId: 'nimbus', commission: { mode: 'new' } });
    assert.deepEqual(fresh, [{ projectId: 'nimbus', browser: null, commission: { mode: 'new' } }]);

    const join: CreateCall[] = [];
    await handleCreateSession(makeDeps(join), { projectId: 'nimbus', commission: { mode: 'join', commissionId: 'cm_1' } });
    assert.deepEqual(join, [{ projectId: 'nimbus', browser: null, commission: { mode: 'join', commissionId: 'cm_1' } }]);
  });
});

test('sessions.create refuses a commission opt-in while the feature switch is off', async () => {
  await withCommissionDisabled(async () => {
    const sink: CreateCall[] = [];
    const res = await handleCreateSession(makeDeps(sink), { projectId: 'nimbus', commission: { mode: 'new' } });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'invalid-args');
    assert.deepEqual(sink, [], 'no session is created — a refused commission must not degrade to an ordinary one');
  });
});

test('sessions.create is unaffected by the commission switch when no commission is asked for', async () => {
  await withCommissionDisabled(async () => {
    const sink: CreateCall[] = [];
    const res = await handleCreateSession(makeDeps(sink), { projectId: 'nimbus' });
    assert.equal(res.ok, true);
    assert.deepEqual(sink, [{ projectId: 'nimbus', browser: null, commission: null }]);
  });
});

test('sessions.create propagates a creation failure as an Err', async () => {
  const deps = {
    projectStore: { getDefault: () => ({ id: 'general' }) },
    createDirectSession: async () => { throw new Error('boom'); },
  } as unknown as UiServiceDeps;
  await assert.rejects(() => handleCreateSession(deps, { projectId: 'p' }), /boom/);
});

// ── sessions.createAndSend ──────────────────────────────────────
// The draft composer is the only create path with a user's engine pick behind it, so what it states
// is also what the NEXT new conversation opens on. An absent selection is that statement too —
// "follow the profile" — and has to reach the domain rule, or a model taken back in a draft is
// re-offered by every draft after it.

interface CreateAndSendCall { profileName: string | null; selection: unknown }

test('sessions.createAndSend states the composer selection, empty when nothing is overridden', async () => {
  const calls: CreateAndSendCall[] = [];
  const deps = {
    createDirectSession: async (opts: CreateAndSendCall) => {
      calls.push(opts);
      return { sessionId: 'sess-cs', sessionName: 'cortex-new', channel: 'web:sess-cs' };
    },
    sendSessionMessage: () => {},
  } as unknown as UiServiceDeps;

  const bare = await handleCreateAndSend(deps, { projectId: 'nimbus', profileName: 'opus', text: 'hi' });
  assert.equal(bare.ok, true);
  assert.deepEqual(calls[0]?.selection, {}, 'a composer overriding nothing still states the empty selection');

  await handleCreateAndSend(deps, {
    projectId: 'nimbus', profileName: 'opus', selection: { model: 'claude-sonnet-5' }, text: 'hi',
  });
  assert.deepEqual(calls[1]?.selection, { model: 'claude-sonnet-5' }, 'a stated override is passed through as-is');
});
