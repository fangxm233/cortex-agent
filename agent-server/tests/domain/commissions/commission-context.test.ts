// input:  ../../_test-home, vitest, commission-context with injected deps
// output: identity/dir resolution, ledger presence, closed-commission and missing-contract tests
// pos:    [Commission] injection payload loader contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  loadCommissionPromptContext,
  type CommissionContextDeps,
} from '../../../src/domain/commissions/commission-context.js';

function harness(files: Record<string, string>, status: 'active' | 'done' = 'active'): CommissionContextDeps {
  return {
    findCommission: async () => ({ projectId: 'proj', slug: 'my-task', title: 'My task', status }),
    resolveDir: () => '/ctx/proj/commissions/my-task',
    readFile: async (p) => {
      const name = p.split('/').pop()!;
      if (!(name in files)) throw new Error('ENOENT');
      return files[name];
    },
  };
}

test('resolves identity and directory for an active commission, without carrying file contents', async () => {
  const ctx = await loadCommissionPromptContext('comm-1', harness({
    'contract.md': '# Contract\ngoal',
    'ledger.md': '# Ledger\nstatus line',
  }));
  assert.equal(ctx?.id, 'comm-1');
  assert.equal(ctx?.title, 'My task');
  assert.equal(ctx?.dir, '/ctx/proj/commissions/my-task');
  assert.equal(ctx?.hasLedger, true);
  // The context is an index — no snapshot fields, no matter how large the files are.
  assert.deepEqual(Object.keys(ctx!).sort(), ['dir', 'hasLedger', 'id', 'title']);
});

test('a missing or empty ledger is reported as absent, not fatal', async () => {
  assert.equal((await loadCommissionPromptContext('c', harness({ 'contract.md': 'X' })))?.hasLedger, false);
  assert.equal((await loadCommissionPromptContext('c', harness({ 'contract.md': 'X', 'ledger.md': ' \n' })))?.hasLedger, false);
});

test('a missing or empty contract means the commission is not set up — nothing is injected', async () => {
  assert.equal(await loadCommissionPromptContext('c', harness({})), null);
  assert.equal(await loadCommissionPromptContext('c', harness({ 'contract.md': '  \n' })), null);
});

test('closed commissions and unknown ids load nothing', async () => {
  assert.equal(await loadCommissionPromptContext('c', harness({ 'contract.md': 'X' }, 'done')), null);
  assert.equal(await loadCommissionPromptContext('c', { ...harness({}), findCommission: async () => null }), null);
});

test('an enormous contract and ledger cost nothing — size never reaches the prompt', async () => {
  const ctx = await loadCommissionPromptContext('c', harness({
    'contract.md': 'A'.repeat(200_000),
    'ledger.md': 'B'.repeat(200_000),
  }));
  assert.equal(ctx?.hasLedger, true);
  assert.ok(JSON.stringify(ctx).length < 200, 'context stays constant-size regardless of file size');
});
