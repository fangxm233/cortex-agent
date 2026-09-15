import './_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  resolveCommissionCreate,
  enterCommissionDraft,
  leaveCommissionDraft,
} from '../src/domain/commissions/commission-draft.js';

test('new commission creates a draft dir named after the session', async () => {
  const made: string[] = [];
  const fields = await resolveCommissionCreate('cortex-self', 'cortex-a1b2', { mode: 'new' }, {
    resolveRoot: () => '/ctx/cortex-self/commissions',
    mkdir: (dir) => made.push(dir),
  });

  assert.equal(fields.commissionDraft, '_draft-cortex-a1b2');
  assert.equal(fields.commissionId, null);
  assert.equal(made.length, 1);
  // finalize validates the `_draft-*` shape, so the created name must match what it expects.
  assert.ok(made[0].endsWith('/commissions/_draft-cortex-a1b2'), made[0]);
});

test('a failed mkdir aborts creation instead of degrading to an ordinary session', async () => {
  await assert.rejects(
    resolveCommissionCreate('cortex-self', 'cortex-a1b2', { mode: 'new' }, {
      resolveRoot: () => '/ctx/cortex-self/commissions',
      mkdir: () => { throw new Error('EACCES'); },
    }),
    /EACCES/,
  );
});

test('join binds an active commission and creates no draft', async () => {
  const fields = await resolveCommissionCreate('cortex-self', 'cortex-a1b2', { mode: 'join', commissionId: 'c1' }, {
    findCommission: async () => ({ status: 'active' }),
    mkdir: () => { throw new Error('join must not create a directory'); },
  });

  assert.equal(fields.commissionId, 'c1');
  assert.equal(fields.commissionDraft, null);
});

test('new commission fails loudly when the project has no context directory', async () => {
  await assert.rejects(
    resolveCommissionCreate('nowhere', 'cortex-a1b2', { mode: 'new' }, { resolveRoot: () => null }),
    /no context directory/,
  );
});

test('join refuses an unknown or already-closed commission', async () => {
  await assert.rejects(
    resolveCommissionCreate('cortex-self', 'cortex-a1b2', { mode: 'join', commissionId: 'gone' }, {
      findCommission: async () => null,
    }),
    /Unknown commission/,
  );

  await assert.rejects(
    resolveCommissionCreate('cortex-self', 'cortex-a1b2', { mode: 'join', commissionId: 'c1' }, {
      findCommission: async () => ({ status: 'done' }),
    }),
    /is done/,
  );
});

// ---------------------------------------------------------------------------
// enter / leave — the mid-session half of DR-0037 v4. Both entries (the agent's
// cortex_commission_start and the composer switch) land here, so these tests are what keeps the
// two from drifting into different states.
// ---------------------------------------------------------------------------

type StoredSession = {
  projectId?: string | null; name?: string | null;
  commissionId?: string | null; commissionDraft?: string | null;
};

function fakeStore(session: StoredSession | null) {
  const writes: (string | null)[] = [];
  return {
    writes,
    deps: {
      getSession: async () => session,
      setDraft: async (_id: string, value: string | null) => {
        writes.push(value);
        if (session) session.commissionDraft = value;
      },
      resolveRoot: () => '/ctx/cortex-self/commissions',
    },
  };
}

test('enter puts an ordinary session into the drafting phase', async () => {
  const store = fakeStore({ projectId: 'cortex-self', name: 'cortex-a1b2' });
  const made: string[] = [];
  const res = await enterCommissionDraft('sess-1', {
    ...store.deps,
    start: (projectId, sessionName) => {
      made.push(`${projectId}/${sessionName}`);
      return { draftDir: '_draft-cortex-a1b2', dir: '/ctx/cortex-self/commissions/_draft-cortex-a1b2' };
    },
  });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.draftDir, '_draft-cortex-a1b2');
  assert.equal(res.dir, '/ctx/cortex-self/commissions/_draft-cortex-a1b2');
  assert.equal(res.alreadyDrafting, false);
  assert.deepEqual(made, ['cortex-self/cortex-a1b2'], 'the draft is named after the session, not the caller');
  assert.deepEqual(store.writes, ['_draft-cortex-a1b2']);
});

test('entering twice is a no-op the second time — the tool may be called again', async () => {
  const store = fakeStore({ projectId: 'cortex-self', name: 'cortex-a1b2', commissionDraft: '_draft-cortex-a1b2' });
  const res = await enterCommissionDraft('sess-1', {
    ...store.deps,
    start: () => ({ draftDir: '_draft-cortex-a1b2', dir: '/ctx/cortex-self/commissions/_draft-cortex-a1b2' }),
  });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.alreadyDrafting, true, 'the caller can tell it already announced this');
  assert.equal(res.dir, '/ctx/cortex-self/commissions/_draft-cortex-a1b2', 'same directory, so nothing written is lost');
  assert.deepEqual(store.writes, [], 'no redundant registry write');
});

test('enter refuses once the session is bound — one commission per session', async () => {
  const store = fakeStore({ projectId: 'cortex-self', name: 'cortex-a1b2', commissionId: 'c1' });
  const res = await enterCommissionDraft('sess-1', {
    ...store.deps,
    start: () => { throw new Error('must not touch disk for a bound session'); },
  });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /already bound to commission c1/);
  assert.deepEqual(store.writes, []);
});

test('enter reports the failure instead of throwing at the tool/webhook boundary', async () => {
  const missing = await enterCommissionDraft('ghost', { getSession: async () => null });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /unknown session ghost/);

  const store = fakeStore({ projectId: 'nowhere', name: 'cortex-a1b2' });
  const noRoot = await enterCommissionDraft('sess-1', { ...store.deps, resolveRoot: () => null });
  assert.equal(noRoot.ok, false);
  if (!noRoot.ok) assert.match(noRoot.error, /no context directory/);
  assert.deepEqual(store.writes, [], 'the registry is not moved when the directory could not be made');
});

test('leave clears the registry and removes a draft nothing was written into', async () => {
  const store = fakeStore({ projectId: 'cortex-self', name: 'cortex-a1b2', commissionDraft: '_draft-cortex-a1b2' });
  const removed: string[] = [];
  const res = await leaveCommissionDraft('sess-1', {
    ...store.deps,
    readContract: () => null,
    removeDir: (dir) => removed.push(dir),
  });

  assert.deepEqual(res, { ok: true, removed: true });
  assert.deepEqual(store.writes, [null]);
  assert.deepEqual(removed, ['/ctx/cortex-self/commissions/_draft-cortex-a1b2']);
});

test('leave keeps a draft that already holds text — deleting someone\'s writing is never the default', async () => {
  const store = fakeStore({ projectId: 'cortex-self', name: 'cortex-a1b2', commissionDraft: '_draft-cortex-a1b2' });
  const res = await leaveCommissionDraft('sess-1', {
    ...store.deps,
    readContract: () => '# Contract\n\nreal work\n',
    removeDir: () => { throw new Error('must not delete a written contract'); },
  });

  assert.deepEqual(res, { ok: true, removed: false });
  assert.deepEqual(store.writes, [null], 'the session still leaves the mode');
});

test('leave is a no-op for a session that was never drafting, and refuses a bound one', async () => {
  const idle = fakeStore({ projectId: 'cortex-self', name: 'cortex-a1b2' });
  assert.deepEqual(
    await leaveCommissionDraft('sess-1', { ...idle.deps, removeDir: () => { throw new Error('nothing to remove'); } }),
    { ok: true, removed: false },
  );
  assert.deepEqual(idle.writes, []);

  const bound = fakeStore({ projectId: 'cortex-self', name: 'cortex-a1b2', commissionId: 'c1' });
  const res = await leaveCommissionDraft('sess-1', bound.deps);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /bound commission cannot be left/);
  assert.deepEqual(bound.writes, []);
});
