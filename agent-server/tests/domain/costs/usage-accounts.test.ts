// Each Claude account has a usage row of its own: its own quota reading, its own spend attribution,
// its own sign-out, its own reset.
import { describe, expect, it, vi } from 'vitest';
import { redeemUsageReset } from '../../../src/domain/costs/account-reset.js';
import type { CostEntry } from '../../../src/domain/costs/cost-tracker.js';
import { ledgerSpend } from '../../../src/domain/costs/ledger-spend.js';
import type { AccountReading } from '../../../src/domain/costs/reset-account.js';
import { UsageService } from '../../../src/domain/costs/usage-service.js';
import { usageRecordKey, type ProviderUsage } from '../../../src/domain/costs/usage-store.js';
import { Capability } from '../../../src/agent-adapter/capabilities.js';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function entry(connection: string): CostEntry {
  return {
    timestamp: new Date(NOW.getTime() - 3_600_000).toISOString(), project: 'p', trigger: 't', cost_usd: 1,
    num_turns: 1, duration_s: 1, backend: 'claude', mode: 'plan', connection, source: 's',
  };
}

const reading = (utilization: number): AccountReading => ({
  windows: [{ type: 'five_hour', utilization, resetsAt: NOW_SEC + 3600 }], resetCredits: null,
});

function service(overrides: { signedOut?: Record<string, number> } = {}) {
  let rows: ProviderUsage[] = [];
  const signOuts = new Map(Object.entries(overrides.signedOut ?? {}));
  const releaseThrottle = vi.fn(async () => true);
  const usage = new UsageService({
    store: { list: async () => rows, commit: async (next) => { rows = next; } },
    signOuts: {
      list: async () => Object.fromEntries(signOuts),
      set: async (key, at) => { if (at === null) signOuts.delete(key); else signOuts.set(key, at); },
    },
    getAdapter: () => ({ capabilities: new Set<Capability>() }),
    readLedger: async () => [entry('subscription'), entry('school')],
    billingOf: () => 'subscription',
    accountOf: (ref) => (ref.connection === 'school' ? 'school' : null),
    now: () => NOW,
    claudeAccount: { readUsage: async () => reading(0.2) },
    claudeAccounts: () => [{ id: 'school', label: 'School Team', account: { readUsage: async () => reading(0.7) } }],
    releaseThrottle,
  });
  return { usage, releaseThrottle };
}

describe('usage rows per account', () => {
  it('keys an account row apart from the default login', () => {
    expect(usageRecordKey({ provider: 'anthropic', billing: 'subscription' })).toBe('anthropic::subscription');
    expect(usageRecordKey({ provider: 'anthropic', billing: 'subscription', route: 'school' }))
      .toBe('anthropic::subscription::school');
  });

  it('attributes an account\'s spend to its own ledger row', () => {
    const rows = ledgerSpend([entry('subscription'), entry('school')], () => 'subscription', NOW,
      (ref) => (ref.connection === 'school' ? 'school' : null));
    expect(rows.map((row) => [row.provider, row.billing, row.route ?? null, row.connections])).toEqual([
      ['anthropic', 'subscription', null, ['subscription']],
      ['anthropic', 'subscription', 'school', ['school']],
    ]);
  });

  it('reads each account and releases only its own throttle', async () => {
    const { usage, releaseThrottle } = service();
    const rows = (await usage.collect()).filter((row) => row.provider === 'anthropic');
    expect(rows.map((row) => [row.route ?? null, row.label ?? null, row.displayName, row.windows[0]?.utilization, row.freshness]))
      .toEqual([
        [null, null, 'Anthropic', 0.2, 'live'],
        ['school', 'School Team', 'Anthropic (School Team)', 0.7, 'live'],
      ]);
    expect(releaseThrottle.mock.calls.map((call) => (call as unknown[])[2]).sort()).toEqual(['school', 'subscription']);
  });

  it('hides a signed-out account and keeps the default row', async () => {
    const { usage } = service();
    await usage.collect();
    await usage.signOut('anthropic', 'school');
    expect((await usage.getStatus()).filter((row) => row.provider === 'anthropic').map((row) => row.route ?? null))
      .toEqual([null]);
  });
});

describe('a reset per account', () => {
  it('spends on the account and lifts that account\'s throttle alone', async () => {
    const cleared: string[] = [];
    const row: ProviderUsage = {
      provider: 'anthropic', route: 'school', displayName: 'Anthropic (School)', modes: ['school'],
      windows: [{ type: 'five_hour', utilization: 0, resetsAt: null }], observedAt: NOW_SEC + 5,
      freshness: 'live', billing: 'subscription',
    };
    const result = await redeemUsageReset('anthropic', undefined, {
      accounts: { anthropic: { readUsage: async () => reading(0.99), redeemReset: async () => ({ status: 'reset', cleared: [] }) } },
      usage: { getStatus: async () => [], refresh: async () => [row] },
      clearThrottle: async (key) => { cleared.push(key); },
      sleep: async () => {}, pollDelaysMs: [1, 1], now: () => NOW.getTime(),
    }, 'school');
    expect(result).toMatchObject({ provider: 'anthropic', connection: 'school', status: 'reset', usage: [row] });
    expect(cleared).toEqual(['anthropic::school']);
  });
});
