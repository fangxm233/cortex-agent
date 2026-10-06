import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  finalizeCommission,
  validateCommissionFinalize,
  type CommissionFinalizeDeps,
} from '../../../src/domain/commissions/commission-finalize.js';
import type { CommissionRecord } from '../../../src/store/commission-repo.js';

let tmpDir = '';
let n = 0;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cortex-commission-finalize-'));
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

interface Harness {
  root: string;
  contractPath: string;
  deps: CommissionFinalizeDeps;
  added: CommissionRecord[];
  bound: Array<{ sessionId: string; commissionId: string }>;
}

async function harness(opts: {
  draftName?: string;
  existingSlug?: string;
  /** Overrides the session's commission state; default is "drafting this harness's draft dir". */
  session?: { projectId?: string; commissionId?: string | null; commissionDraft?: string | null };
} = {}): Promise<Harness> {
  const root = path.join(tmpDir, `commissions-${n++}`);
  const draftName = opts.draftName ?? '_draft-cortex-abc';
  const draft = path.join(root, draftName);
  await fsp.mkdir(draft, { recursive: true });
  const contractPath = path.join(draft, 'contract.md');
  await fsp.writeFile(contractPath, '# Contract\n');
  const added: CommissionRecord[] = [];
  const bound: Array<{ sessionId: string; commissionId: string }> = [];
  return {
    root, contractPath, added, bound,
    deps: {
      getSession: async () => ({
        projectId: 'proj', commissionId: null, commissionDraft: draftName, ...opts.session,
      }),
      resolveRoot: () => root,
      findBySlug: async (_p, slug) => (slug === opts.existingSlug ? { id: 'old' } : null),
      addCommission: async (r) => { added.push(r); },
      bindSession: async (sessionId, commissionId) => { bound.push({ sessionId, commissionId }); },
      now: () => 12345,
    },
  };
}

test('finalize renames the draft, scaffolds, registers, and binds the session', async () => {
  const h = await harness();
  const result = await finalizeCommission(
    { sessionId: 'sess-1', name: 'Ship The Parser', contractPath: h.contractPath },
    h.deps,
  );
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.slug, 'ship-the-parser');
  assert.equal(result.dir, path.join(h.root, 'ship-the-parser'));
  assert.ok(fs.existsSync(path.join(result.dir, 'contract.md')), 'contract moved with the dir');
  assert.ok(fs.existsSync(path.join(result.dir, 'assets')), 'assets/ scaffolded');
  assert.ok(fs.existsSync(path.join(result.dir, 'decisions.jsonl')), 'decisions.jsonl scaffolded');
  assert.ok(!fs.existsSync(path.dirname(h.contractPath)), 'draft dir is gone');
  assert.equal(h.added[0].slug, 'ship-the-parser');
  assert.equal(h.added[0].title, 'Ship The Parser');
  assert.equal(h.added[0].status, 'active');
  assert.equal(h.added[0].createdAt, 12345);
  assert.deepEqual(h.bound, [{ sessionId: 'sess-1', commissionId: h.added[0].id }]);
});

test('validate rejects bad names, non-draft dirs, missing contracts and collisions', async () => {
  const h = await harness();
  const base = { sessionId: 'sess-1', contractPath: h.contractPath };
  assert.match((await validateCommissionFinalize({ ...base, name: '任务' }, h.deps) as any).error, /slug-safe/);
  assert.match((await validateCommissionFinalize({ sessionId: null, name: 'x', contractPath: h.contractPath }, h.deps) as any).error, /session id/);

  const nonDraft = await harness({ draftName: 'not-a-draft' });
  assert.match((await validateCommissionFinalize({ ...base, name: 'x', contractPath: nonDraft.contractPath }, nonDraft.deps) as any).error, /_draft-/);

  const missing = await harness();
  await fsp.rm(missing.contractPath);
  assert.match((await validateCommissionFinalize({ ...base, name: 'x', contractPath: missing.contractPath }, missing.deps) as any).error, /not found/);

  const dirCollision = await harness();
  await fsp.mkdir(path.join(dirCollision.root, 'taken'), { recursive: true });
  assert.match((await validateCommissionFinalize({ sessionId: 's', name: 'taken', contractPath: dirCollision.contractPath }, dirCollision.deps) as any).error, /already exists/);

  const slugCollision = await harness({ existingSlug: 'reserved' });
  assert.match((await validateCommissionFinalize({ sessionId: 's', name: 'reserved', contractPath: slugCollision.contractPath }, slugCollision.deps) as any).error, /already registered/);
});

test('a contract nested deeper than commissions/<dir>/ is rejected', async () => {
  const h = await harness();
  const nested = path.join(path.dirname(h.contractPath), 'sub');
  await fsp.mkdir(nested);
  await fsp.writeFile(path.join(nested, 'contract.md'), 'x');
  const result = await validateCommissionFinalize(
    { sessionId: 's', name: 'x', contractPath: path.join(nested, 'contract.md') },
    h.deps,
  );
  assert.match((result as any).error, /directly under/);
});

// --- DR-0037 v4: the state check that replaced tool visibility ---------------------------------

test('refuses a submit from a session that never entered commission mode', async () => {
  // The v3 guard was "an ordinary session does not have the tool". That was never true on the
  // Claude backend (`--tools` cannot filter MCP tools), and one such session did land a commission.
  const h = await harness({ session: { commissionDraft: null } });
  const result = await validateCommissionFinalize(
    { sessionId: 'sess-1', name: 'Ship It', contractPath: h.contractPath },
    h.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /not drafting a commission/);
});

test('refuses a second commission from a session already bound to one', async () => {
  const h = await harness({ session: { commissionId: 'dc44f400' } });
  const result = await validateCommissionFinalize(
    { sessionId: 'sess-1', name: 'Ship It', contractPath: h.contractPath },
    h.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /already bound to commission dc44f400/);
});

test('refuses a contract from another session\'s draft directory', async () => {
  // The path-shape check accepts any `_draft-*` under the project, so without this a session could
  // submit a neighbour's contract and rename the directory out from under it.
  const h = await harness({ session: { commissionDraft: '_draft-cortex-other' } });
  const result = await validateCommissionFinalize(
    { sessionId: 'sess-1', name: 'Ship It', contractPath: h.contractPath },
    h.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /this session drafts in _draft-cortex-other/);
});

// --- a registration failure after the rename -----------------------------------------------------

test('a failed registration puts the draft back so the same submit can be retried', async () => {
  const h = await harness();
  let fail = true;
  const deps: CommissionFinalizeDeps = {
    ...h.deps,
    addCommission: async (r) => { if (fail) throw new Error('registry write failed'); h.added.push(r); },
  };
  const args = { sessionId: 'sess-1', name: 'Ship It', contractPath: h.contractPath };

  const first = await finalizeCommission(args, deps);
  assert.equal(first.ok, false);
  assert.match((first as any).error, /registry write failed/);
  assert.match((first as any).error, /back at .*_draft-cortex-abc.*retried/);
  assert.ok(fs.existsSync(h.contractPath), 'the draft is where the session expects it');
  assert.ok(!fs.existsSync(path.join(h.root, 'ship-it')));
  assert.deepEqual(h.bound, []);

  fail = false;
  const second = await finalizeCommission(args, deps);
  assert.ok(second.ok, JSON.stringify(second));
});

test('a failed bind withdraws the record it just added before putting the draft back', async () => {
  const h = await harness();
  const removed: string[] = [];
  const deps: CommissionFinalizeDeps = {
    ...h.deps,
    bindSession: async () => { throw new Error('session store busy'); },
    removeCommission: async (id) => { removed.push(id); },
  };
  const result = await finalizeCommission({ sessionId: 'sess-1', name: 'Ship It', contractPath: h.contractPath }, deps);
  assert.equal(result.ok, false);
  assert.match((result as any).error, /session store busy/);
  assert.deepEqual(removed, [h.added[0].id], 'no half-registered commission is left behind');
  assert.ok(fs.existsSync(h.contractPath));
});

test('a rollback that cannot withdraw the record says where the commission now lives', async () => {
  const h = await harness();
  const deps: CommissionFinalizeDeps = {
    ...h.deps,
    bindSession: async () => { throw new Error('session store busy'); },
    removeCommission: async () => { throw new Error('registry gone'); },
  };
  const result = await finalizeCommission({ sessionId: 'sess-1', name: 'Ship It', contractPath: h.contractPath }, deps);
  assert.equal(result.ok, false);
  assert.match((result as any).error, /could not be withdrawn.*ship-it.*commission board/);
  assert.ok(fs.existsSync(path.join(h.root, 'ship-it', 'contract.md')), 'left where the record points');
});
