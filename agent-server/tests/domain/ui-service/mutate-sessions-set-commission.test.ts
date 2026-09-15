// input:  handleSetCommission + a real (isolated) session registry and commissions dir
// output: the state-machine table of DR-0037 v4's user entry — none → draft → (bound), the
//         idempotent repeats, the refusals, and which live event each transition publishes
// pos:    guards sessions.setCommission, the user's half of "either side may start a commission"
import '../../_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleSetCommission } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { resetSettingsForTests } from '../../../src/core/settings.js';
import { sessionStore } from '../../../src/store/session-registry-repo.js';
import { commissionsRoot } from '../../../src/domain/commissions/commission-paths.js';
import { projectStore } from '../../../src/domain/projects/project-store.js';

// The store caches its scan at boot; this test home was created after that, so rescan. `general`
// is synthesized rather than read off disk, and enterCommissionDraft mkdir -p's the rest.
projectStore.refresh();
const PROJECT = projectStore.getDefault().id;

/** settings.commissionEnabled is the feature's kill switch (on by default since DR-0037 v4). Set
 *  it explicitly either way, so these tests state what they exercise instead of riding the default. */
function setCommissions(value: '1' | '0'): () => void {
  process.env.CORTEX_COMMISSION_ENABLED = value;
  resetSettingsForTests();
  return () => {
    delete process.env.CORTEX_COMMISSION_ENABLED;
    resetSettingsForTests();
  };
}
const enableCommissions = () => setCommissions('1');

let seq = 0;
async function liveSession(fields: { commissionId?: string | null; commissionDraft?: string | null } = {}) {
  seq += 1;
  const name = `cortex-set${seq}`;
  const sessionId = `sess-set${seq}`;
  await sessionStore.registerSession(name, {
    sessionId, channel: `web:${sessionId}`, backend: 'claude', kind: 'local', projectId: PROJECT,
    commissionId: fields.commissionId ?? null, commissionDraft: fields.commissionDraft ?? null,
  });
  return { name, sessionId, channel: `web:${sessionId}` };
}

function makeDeps(published: any[], commissions: { id: string; projectId: string; status: string }[] = []) {
  return {
    sessionStore: { getById: (id: string) => sessionStore.getById(id) },
    commissionStore: { find: async (id: string) => commissions.find((c) => c.id === id) ?? null },
    bus: { publish: (event: any) => published.push(event) },
  } as unknown as UiServiceDeps;
}

function draftDirOf(name: string): string {
  return path.join(commissionsRoot(PROJECT)!, `_draft-${name}`);
}

test('new puts a live session into the drafting phase and announces it on its channel', async () => {
  const restore = enableCommissions();
  try {
    const published: any[] = [];
    const s = await liveSession();
    const res = await handleSetCommission(makeDeps(published), { sessionId: s.sessionId, commission: { mode: 'new' } });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.data, { phase: 'draft', commissionId: null, commissionDraft: `_draft-${s.name}` });
    assert.ok(fs.existsSync(draftDirOf(s.name)), 'the server owns the directory, not the agent');
    assert.equal((await sessionStore.getById(s.sessionId))?.commissionDraft, `_draft-${s.name}`);
    // session.commission, not commission.updated: there is no commission record yet to name.
    assert.deepEqual(published, [{ type: 'session.commission', sessionId: s.sessionId, channel: s.channel }]);
  } finally { restore(); }
});

test('repeating new is idempotent and stays quiet the second time', async () => {
  const restore = enableCommissions();
  try {
    const published: any[] = [];
    const s = await liveSession();
    const deps = makeDeps(published);
    const first = await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'new' } });
    const again = await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'new' } });

    assert.deepEqual(again, first, 'same draft, so a double click costs nothing');
    assert.equal(published.length, 1, 'only the transition is announced');
  } finally { restore(); }
});

test('off leaves the drafting phase and reclaims a draft nothing was written into', async () => {
  const restore = enableCommissions();
  try {
    const published: any[] = [];
    const s = await liveSession();
    const deps = makeDeps(published);
    await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'new' } });
    const res = await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'off' } });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.data, { phase: 'none', commissionId: null, commissionDraft: null, removedDraftDir: true });
    assert.equal(fs.existsSync(draftDirOf(s.name)), false);
    assert.equal((await sessionStore.getById(s.sessionId))?.commissionDraft, null);
    assert.equal(published.length, 2, 'leaving is a binding change the UI has to see too');
  } finally { restore(); }
});

test('off keeps a contract that already holds text', async () => {
  const restore = enableCommissions();
  try {
    const published: any[] = [];
    const s = await liveSession();
    const deps = makeDeps(published);
    await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'new' } });
    fs.writeFileSync(path.join(draftDirOf(s.name), 'contract.md'), '# Ship it\n\nreal drilling\n');

    const res = await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'off' } });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.data.removedDraftDir, false);
    assert.ok(fs.existsSync(draftDirOf(s.name)), 'the user can still read what was drilled');
    assert.equal((await sessionStore.getById(s.sessionId))?.commissionDraft, null, 'but the session is out of the mode');
  } finally { restore(); }
});

test('join binds an active commission mid-conversation', async () => {
  const restore = enableCommissions();
  try {
    const published: any[] = [];
    const s = await liveSession();
    const deps = makeDeps(published, [{ id: 'c1', projectId: PROJECT, status: 'active' }]);
    const res = await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'join', commissionId: 'c1' } });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.data, { phase: 'active', commissionId: 'c1', commissionDraft: null });
    assert.equal((await sessionStore.getById(s.sessionId))?.commissionId, 'c1');
    assert.deepEqual(published, [{ type: 'commission.updated', commissionId: 'c1', projectId: PROJECT }]);
  } finally { restore(); }
});

test('join refuses an unknown or already-closed commission and changes nothing', async () => {
  const restore = enableCommissions();
  try {
    const published: any[] = [];
    const s = await liveSession();
    const deps = makeDeps(published, [{ id: 'c-done', projectId: PROJECT, status: 'done' }]);

    const missing = await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'join', commissionId: 'ghost' } });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'not-found');

    const closed = await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'join', commissionId: 'c-done' } });
    assert.equal(closed.ok, false);
    if (!closed.ok) assert.match(closed.message, /is done/);

    assert.equal((await sessionStore.getById(s.sessionId))?.commissionId, null);
    assert.deepEqual(published, []);
  } finally { restore(); }
});

test('a bound session refuses every transition — one commission per session, and bound is terminal', async () => {
  const restore = enableCommissions();
  try {
    const published: any[] = [];
    const s = await liveSession({ commissionId: 'c1' });
    const deps = makeDeps(published, [{ id: 'c2', projectId: PROJECT, status: 'active' }]);

    for (const commission of [{ mode: 'new' as const }, { mode: 'off' as const }, { mode: 'join' as const, commissionId: 'c2' }]) {
      const res = await handleSetCommission(deps, { sessionId: s.sessionId, commission });
      assert.equal(res.ok, false, `${commission.mode} must be refused`);
      if (!res.ok) assert.match(res.message, /already bound to a commission/);
    }
    assert.equal((await sessionStore.getById(s.sessionId))?.commissionId, 'c1', 'the first contract is never orphaned');
    assert.deepEqual(published, []);
  } finally { restore(); }
});

test('a missing session is not-found', async () => {
  const restore = enableCommissions();
  try {
    const res = await handleSetCommission(makeDeps([]), { sessionId: 'ghost', commission: { mode: 'new' } });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'not-found');
  } finally { restore(); }
});

test('with the feature switched off, entering is refused but leaving still works', async () => {
  const restore = enableCommissions();
  const s = await liveSession();
  const published: any[] = [];
  const deps = makeDeps(published);
  await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'new' } });
  restore();
  const restoreOff = setCommissions('0');

  // A session left drafting when an operator flips the switch must still be able to get out.
  const entering = await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'new' } });
  assert.equal(entering.ok, false);
  if (!entering.ok) assert.match(entering.message, /Commission mode is disabled/);

  const leaving = await handleSetCommission(deps, { sessionId: s.sessionId, commission: { mode: 'off' } });
  assert.equal(leaving.ok, true);
  assert.equal((await sessionStore.getById(s.sessionId))?.commissionDraft, null);
  restoreOff();
});
