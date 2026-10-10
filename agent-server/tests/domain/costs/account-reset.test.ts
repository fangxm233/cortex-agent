import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import { redeemUsageReset, type UsageResetDeps } from '../../../src/domain/costs/account-reset.js';
import type {
  AccountReading,
  AccountRedeemOutcome,
  ResetProvider,
} from '../../../src/domain/costs/reset-account.js';
import type { ProviderUsage, UsageWindow } from '../../../src/domain/costs/usage-store.js';

const SENT_AT = 1_790_000_000;

const CODEX_EXHAUSTED: AccountReading = {
  windows: [{ type: 'codex_primary', utilization: 0.99, resetsAt: 1_792_115_610 }],
  resetCredits: {
    availableCount: 2,
    credits: [
      { id: 'credit-early', title: 'Full reset', expiresAt: 1_794_000_000 },
      { id: 'credit-late', title: 'Full reset', expiresAt: 1_795_000_000 },
    ],
  },
};

const CLAUDE_EXHAUSTED: AccountReading = {
  windows: [
    { type: 'five_hour', utilization: 1, resetsAt: 1_790_010_000 },
    { type: 'seven_day', utilization: 0.4, resetsAt: 1_790_500_000 },
  ],
  resetCredits: {
    availableCount: 2,
    atLimit: true,
    credits: [
      { id: 'grant_soon', title: 'Reset', expiresAt: 1_794_000_000, clears: ['five_hour', 'seven_day'] },
      { id: 'grant_pick', title: 'Reset', expiresAt: 1_795_000_000, clears: ['five_hour', 'seven_day'] },
    ],
    nextCreditId: 'grant_pick',
  },
};

const READINGS: Record<ResetProvider, AccountReading> = {
  'openai-codex': CODEX_EXHAUSTED,
  anthropic: CLAUDE_EXHAUSTED,
};

function row(provider: ResetProvider, windows: Pick<UsageWindow, 'type' | 'utilization'>[], observedAt: number): ProviderUsage[] {
  return [{
    provider, displayName: provider, modes: [provider], billing: 'subscription',
    windows: windows.map((window) => ({ ...window, resetsAt: null })),
    observedAt, freshness: 'live',
  }];
}

function codexRow(utilization: number, observedAt = SENT_AT + 5): ProviderUsage[] {
  return row('openai-codex', [{ type: 'codex_primary', utilization }], observedAt);
}

function claudeRow(fiveHour: number, sevenDay: number, observedAt = SENT_AT + 5): ProviderUsage[] {
  return row('anthropic', [
    { type: 'five_hour', utilization: fiveHour },
    { type: 'seven_day', utilization: sevenDay },
  ], observedAt);
}

function harness(provider: ResetProvider, options: {
  usage?: AccountReading | null;
  outcome?: AccountRedeemOutcome;
  status?: ProviderUsage[];
  refreshes?: ProviderUsage[][];
}) {
  const refreshes = [...(options.refreshes ?? [])];
  const status = options.status ?? codexRow(0.99, SENT_AT - 60);
  const calls = { redeem: [] as (string | undefined)[], cleared: [] as string[], sleeps: [] as number[], refresh: 0 };
  const account = {
    readUsage: async () => (options.usage === undefined ? READINGS[provider] : options.usage),
    redeemReset: async (creditId?: string) => {
      calls.redeem.push(creditId);
      return options.outcome ?? { status: 'reset' as const, cleared: [] };
    },
  };
  const deps: UsageResetDeps = {
    accounts: { [provider]: account },
    usage: {
      getStatus: async () => status,
      refresh: async () => {
        calls.refresh += 1;
        return refreshes.shift() ?? status;
      },
    },
    clearThrottle: async (name) => { calls.cleared.push(name); },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    pollDelaysMs: [10, 20, 30],
    now: () => SENT_AT * 1000,
  };
  return { deps, calls, account };
}

describe('redeemUsageReset — Codex', () => {
  test('a reset spends the earliest-expiring credit, lifts the throttle and re-polls until usage drops', async () => {
    const { deps, calls } = harness('openai-codex', { refreshes: [codexRow(0.99), codexRow(0)] });

    const result = await redeemUsageReset('openai-codex', undefined, deps);

    assert.equal(result.status, 'reset');
    assert.deepEqual(calls.redeem, ['credit-early']);
    assert.deepEqual(calls.cleared, ['openai-codex']);
    assert.equal(calls.refresh, 2, 'stops polling once the reading shows the reset');
    assert.deepEqual(calls.sleeps, [10, 20]);
    assert.equal(result.usage[0].windows[0].utilization, 0);
  });

  test('polling is bounded when the account is slow to show the reset', async () => {
    const { deps, calls } = harness('openai-codex', {});

    const result = await redeemUsageReset('openai-codex', undefined, deps);

    assert.equal(result.status, 'reset');
    assert.equal(calls.refresh, 3);
    assert.equal(result.usage[0].windows[0].utilization, 0.99);
  });

  test('a reading observed before the redeem was sent does not count as the reset', async () => {
    const { deps, calls } = harness('openai-codex', { refreshes: [codexRow(0, SENT_AT - 1), codexRow(0)] });

    await redeemUsageReset('openai-codex', undefined, deps);

    assert.equal(calls.refresh, 2);
  });

  test('an explicit credit is redeemed as given', async () => {
    const { deps, calls } = harness('openai-codex', { refreshes: [codexRow(0)] });
    await redeemUsageReset('openai-codex', 'credit-late', deps);
    assert.deepEqual(calls.redeem, ['credit-late']);
  });

  test.each(['nothing_to_reset', 'no_credit', 'already_redeemed', 'cooldown', 'ineligible'] as const)(
    '%s is a plain status and leaves the throttle alone',
    async (status) => {
      const { deps, calls } = harness('openai-codex', { outcome: { status, cleared: [] } });

      const result = await redeemUsageReset('openai-codex', undefined, deps);

      assert.equal(result.status, status);
      assert.deepEqual(calls.cleared, []);
      assert.equal(calls.refresh, 1);
      assert.deepEqual(calls.sleeps, []);
    },
  );

  test('without a sign-in nothing is redeemed', async () => {
    const { deps, calls } = harness('openai-codex', { usage: null });

    const result = await redeemUsageReset('openai-codex', undefined, deps);

    assert.equal(result.status, 'signed_out');
    assert.deepEqual(calls.redeem, []);
  });

  test('a failed follow-up refresh still reports the spent reset', async () => {
    const { deps } = harness('openai-codex', {});
    deps.usage!.refresh = async () => { throw new Error('gateway down'); };

    const result = await redeemUsageReset('openai-codex', undefined, deps);

    assert.equal(result.status, 'reset');
    assert.deepEqual(result.usage, codexRow(0.99, SENT_AT - 60));
  });

  test('a second request while one is running joins it instead of spending another credit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps, calls, account } = harness('openai-codex', { refreshes: [codexRow(0)] });
    const redeem = vi.fn(async () => { await gate; return { status: 'reset' as const, cleared: [] }; });
    account.redeemReset = redeem;

    const first = redeemUsageReset('openai-codex', undefined, deps);
    const second = redeemUsageReset('openai-codex', 'credit-late', deps);
    release();

    assert.equal(await first, await second);
    assert.equal(redeem.mock.calls.length, 1);
    assert.deepEqual(calls.cleared, ['openai-codex']);
  });
});

describe('redeemUsageReset — Claude', () => {
  const stale = claudeRow(1, 0.4, SENT_AT - 60);

  test('a reset spends the grant the account offers next and lifts the Anthropic throttle', async () => {
    const { deps, calls } = harness('anthropic', {
      status: stale,
      outcome: { status: 'reset', cleared: ['five_hour', 'seven_day'] },
      refreshes: [claudeRow(0, 0)],
    });

    const result = await redeemUsageReset('anthropic', undefined, deps);

    assert.deepEqual(result, { provider: 'anthropic', status: 'reset', cleared: ['five_hour', 'seven_day'], usage: claudeRow(0, 0) });
    assert.deepEqual(calls.redeem, ['grant_pick']);
    assert.deepEqual(calls.cleared, ['anthropic']);
    assert.equal(calls.refresh, 1);
  });

  test('polling watches only the windows the reset cleared', async () => {
    const { deps, calls } = harness('anthropic', {
      status: stale,
      outcome: { status: 'reset', cleared: ['five_hour'] },
      refreshes: [claudeRow(1, 0), claudeRow(0, 0.4)],
    });

    await redeemUsageReset('anthropic', undefined, deps);

    assert.equal(calls.refresh, 2, 'a drop in an uncleared window is not the reset');
  });

  test('without a listed grant the earliest-expiring one is spent', async () => {
    const reading = { ...CLAUDE_EXHAUSTED, resetCredits: { ...CLAUDE_EXHAUSTED.resetCredits!, nextCreditId: undefined } };
    const { deps, calls } = harness('anthropic', { usage: reading, status: stale, refreshes: [claudeRow(0, 0)] });

    await redeemUsageReset('anthropic', undefined, deps);

    assert.deepEqual(calls.redeem, ['grant_soon']);
  });

  test('requests for different providers run independently', async () => {
    const codex = harness('openai-codex', { refreshes: [codexRow(0)] });
    const claude = harness('anthropic', { status: stale, refreshes: [claudeRow(0, 0)] });

    const [first, second] = await Promise.all([
      redeemUsageReset('openai-codex', undefined, codex.deps),
      redeemUsageReset('anthropic', undefined, claude.deps),
    ]);

    assert.equal(first.provider, 'openai-codex');
    assert.equal(second.provider, 'anthropic');
    assert.deepEqual([codex.calls.redeem, claude.calls.redeem], [['credit-early'], ['grant_pick']]);
  });
});
