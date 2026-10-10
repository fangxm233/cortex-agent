import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import type { CodexAccountUsage, CodexRedeemOutcome } from '../../../src/domain/costs/codex-account.js';
import { redeemCodexReset, type CodexResetDeps } from '../../../src/domain/costs/codex-reset.js';
import type { ProviderUsage } from '../../../src/domain/costs/usage-store.js';

const EXHAUSTED: CodexAccountUsage = {
  planType: 'prolite',
  windows: [{ type: 'codex_primary', utilization: 0.99, resetsAt: 1_792_115_610 }],
  resetCredits: {
    availableCount: 2,
    credits: [
      { id: 'credit-early', title: 'Full reset', expiresAt: 1_794_000_000 },
      { id: 'credit-late', title: 'Full reset', expiresAt: 1_795_000_000 },
    ],
  },
};

function codexRow(utilization: number, freshness: ProviderUsage['freshness'] = 'live'): ProviderUsage[] {
  return [{
    provider: 'openai-codex', displayName: 'OpenAI Codex', modes: ['openai-codex'], billing: 'subscription',
    windows: [{ type: 'codex_primary', utilization, resetsAt: 1_792_115_610 }],
    observedAt: 1_790_000_000, freshness,
  }];
}

function harness(options: {
  usage?: CodexAccountUsage | null;
  outcome?: CodexRedeemOutcome;
  refreshes?: ProviderUsage[][];
}) {
  const refreshes = [...(options.refreshes ?? [])];
  const calls = { redeem: [] as (string | undefined)[], cleared: [] as string[], sleeps: [] as number[], refresh: 0 };
  const deps: CodexResetDeps = {
    account: {
      readUsage: async () => (options.usage === undefined ? EXHAUSTED : options.usage),
      redeemReset: async (creditId) => {
        calls.redeem.push(creditId);
        return options.outcome ?? { code: 'reset', windowsReset: 1 };
      },
    },
    usage: {
      getStatus: async () => codexRow(0.99, 'stale'),
      refresh: async () => {
        calls.refresh += 1;
        return refreshes.shift() ?? codexRow(0.99);
      },
    },
    clearThrottle: async (provider) => { calls.cleared.push(provider); },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    pollDelaysMs: [10, 20, 30],
  };
  return { deps, calls };
}

describe('redeemCodexReset', () => {
  test('a reset spends the earliest-expiring credit, lifts the throttle and re-polls until usage drops', async () => {
    const { deps, calls } = harness({ refreshes: [codexRow(0.99), codexRow(0)] });

    const result = await redeemCodexReset(undefined, deps);

    assert.equal(result.status, 'reset');
    assert.equal(result.windowsReset, 1);
    assert.deepEqual(calls.redeem, ['credit-early']);
    assert.deepEqual(calls.cleared, ['openai-codex']);
    assert.equal(calls.refresh, 2, 'stops polling once the reading shows the reset');
    assert.deepEqual(calls.sleeps, [10, 20]);
    assert.equal(result.usage[0].windows[0].utilization, 0);
  });

  test('polling is bounded when the account is slow to show the reset', async () => {
    const { deps, calls } = harness({});

    const result = await redeemCodexReset(undefined, deps);

    assert.equal(result.status, 'reset');
    assert.equal(calls.refresh, 3);
    assert.equal(result.usage[0].windows[0].utilization, 0.99);
  });

  test('an explicit credit is redeemed as given', async () => {
    const { deps, calls } = harness({ refreshes: [codexRow(0)] });
    await redeemCodexReset('credit-late', deps);
    assert.deepEqual(calls.redeem, ['credit-late']);
  });

  test.each(['nothing_to_reset', 'no_credit', 'already_redeemed'] as const)(
    '%s is a plain status and leaves the throttle alone',
    async (code) => {
      const { deps, calls } = harness({ outcome: { code, windowsReset: 0 } });

      const result = await redeemCodexReset(undefined, deps);

      assert.equal(result.status, code);
      assert.deepEqual(calls.cleared, []);
      assert.equal(calls.refresh, 1);
      assert.deepEqual(calls.sleeps, []);
    },
  );

  test('without a Codex sign-in nothing is redeemed', async () => {
    const { deps, calls } = harness({ usage: null });

    const result = await redeemCodexReset(undefined, deps);

    assert.equal(result.status, 'unavailable');
    assert.deepEqual(calls.redeem, []);
  });

  test('a failed follow-up refresh still reports the spent reset', async () => {
    const { deps } = harness({});
    deps.usage!.refresh = async () => { throw new Error('gateway down'); };

    const result = await redeemCodexReset(undefined, deps);

    assert.equal(result.status, 'reset');
    assert.deepEqual(result.usage, codexRow(0.99, 'stale'));
  });

  test('a second request while one is running joins it instead of spending another credit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps, calls } = harness({ refreshes: [codexRow(0)] });
    const redeem = vi.fn(async () => { await gate; return { code: 'reset' as const, windowsReset: 1 }; });
    deps.account!.redeemReset = redeem;

    const first = redeemCodexReset(undefined, deps);
    const second = redeemCodexReset('credit-late', deps);
    release();

    assert.equal(await first, await second);
    assert.equal(redeem.mock.calls.length, 1);
    assert.deepEqual(calls.cleared, ['openai-codex']);
  });
});
