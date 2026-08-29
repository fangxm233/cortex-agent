// input:  ../../_test-home, vitest, tmp fs, commission-finalize with store seams
// output: draft rename, scaffold, registration, bind and rejection tests
// pos:    Commission approval-time landing contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js';
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

async function harness(opts: { draftName?: string; existingSlug?: string } = {}): Promise<Harness> {
  const root = path.join(tmpDir, `commissions-${n++}`);
  const draft = path.join(root, opts.draftName ?? '_draft-cortex-abc');
  await fsp.mkdir(draft, { recursive: true });
  const contractPath = path.join(draft, 'contract.md');
  await fsp.writeFile(contractPath, '# Contract\n');
  const added: CommissionRecord[] = [];
  const bound: Array<{ sessionId: string; commissionId: string }> = [];
  return {
    root, contractPath, added, bound,
    deps: {
      getSession: async () => ({ projectId: 'proj' }),
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
