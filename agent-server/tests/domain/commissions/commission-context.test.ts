// input:  ../../_test-home, vitest, commission-context with injected deps
// output: contract/ledger loading, closed-commission and truncation tests
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

test('loads contract text and ledger digest for an active commission', async () => {
  const ctx = await loadCommissionPromptContext('comm-1', harness({
    'contract.md': '# Contract\ngoal',
    'ledger.md': '# Ledger\nstatus line',
  }));
  assert.equal(ctx?.title, 'My task');
  assert.equal(ctx?.dir, '/ctx/proj/commissions/my-task');
  assert.equal(ctx?.contractText, '# Contract\ngoal');
  assert.equal(ctx?.ledgerDigest, '# Ledger\nstatus line');
});

test('missing ledger is tolerated; missing or empty contract loads nothing', async () => {
  const noLedger = await loadCommissionPromptContext('c', harness({ 'contract.md': 'X' }));
  assert.equal(noLedger?.ledgerDigest, '');
  assert.equal(await loadCommissionPromptContext('c', harness({})), null);
  assert.equal(await loadCommissionPromptContext('c', harness({ 'contract.md': '  \n' })), null);
});

test('closed commissions and unknown ids load nothing', async () => {
  assert.equal(await loadCommissionPromptContext('c', harness({ 'contract.md': 'X' }, 'done')), null);
  assert.equal(await loadCommissionPromptContext('c', { ...harness({}), findCommission: async () => null }), null);
});

test('oversize contract and ledger are truncated with an on-disk pointer', async () => {
  const ctx = await loadCommissionPromptContext('c', harness({
    'contract.md': 'A'.repeat(20_000),
    'ledger.md': Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'),
  }));
  assert.ok(ctx!.contractText.length < 17_000);
  assert.match(ctx!.contractText, /truncated/);
  assert.match(ctx!.ledgerDigest, /truncated — read ledger\.md/);
  assert.ok(ctx!.ledgerDigest.split('\n').length <= 82);
});
