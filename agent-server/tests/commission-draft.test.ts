// input:  ./_test-home, vitest, resolveCommissionCreate with injected deps
// output: commission-mode create resolution: draft dir, join validation, failure surfacing
// pos:    Guards the create-time half of commission mode (DR-0037 v2)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import './_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveCommissionCreate } from '../src/domain/commissions/commission-draft.js';

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
