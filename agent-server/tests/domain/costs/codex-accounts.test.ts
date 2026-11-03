// Each PI account has a usage row of its own: a Codex account its own quota reading and reset, any
// account its own spend.
import { describe, expect, it, vi } from 'vitest';
import { redeemUsageReset } from '../../../src/domain/costs/account-reset.js';
import type { CostEntry } from '../../../src/domain/costs/cost-tracker.js';
import { ledgerSpend } from '../../../src/domain/costs/ledger-spend.js';
import type { AccountReading } from '../../../src/domain/costs/reset-account.js';
import { UsageService, type UsageServiceDependencies } from '../../../src/domain/costs/usage-service.js';
import type { ProviderUsage } from '../../../src/domain/costs/usage-store.js';
import { Capability } from '../../../src/agent-adapter/capabilities.js';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const ACCOUNTS: Record<string, string> = { 'codex-lab': 'openai-codex', 'deepseek-work': 'deepseek' };

function piEntry(provider: string, connection: string): CostEntry {
  return {
    timestamp: new Date(NOW.getTime() - 3_600_000).toISOString(), project: 'p', trigger: 't', cost_usd: 1,
    num_turns: 1, duration_s: 1, backend: 'pi', mode: 'api', provider, connection, source: 's',
  };
}

const accountOf: UsageServiceDependencies['accountOf'] = (ref) =>
  (ref.connection && ACCOUNTS[ref.connection] === ref.provider ? ref.connection : null);

const reading = (utilization: number): AccountReading => ({
  windows: [{ type: 'codex_primary', utilization, resetsAt: NOW_SEC + 3600 }], resetCredits: null,
});

function service(overrides: Partial<UsageServiceDependencies> & { stored?: ProviderUsage[] } = {}) {
  let rows: ProviderUsage[] = overrides.stored ?? [];
  const releaseThrottle = vi.fn(async () => true);
  const usage = new UsageService({
    store: { list: async () => rows, commit: async (next) => { rows = next; } },
    getAdapter: () => ({ capabilities: new Set<Capability>() }),
    readLedger: async () => [],
    billingOf: (ref) => (ref.provider === 'openai-codex' ? 'subscription' : 'metered'),
    accountOf,
    now: () => NOW,
    codexAccount: { readUsage: async () => reading(0.2) },
    codexAccounts: () => [{ id: 'codex-lab', label: 'Lab', account: { readUsage: async () => reading(0.7) } }],
    releaseThrottle,
    ...overrides,
  });
  return { usage, releaseThrottle };
}

function codexRows(rows: ProviderUsage[]) {
  return rows.filter((row) => row.provider === 'openai-codex')
    .map((row) => [row.route ?? null, row.displayName, row.windows[0]?.utilization ?? null, row.freshness]);
}

describe('Codex usage per account', () => {
  it('reads each account and releases only its own throttle', async () => {
    const { usage, releaseThrottle } = service();
    expect(codexRows(await usage.collect())).toEqual([
      [null, 'OpenAI Codex', 0.2, 'live'],
      ['codex-lab', 'OpenAI Codex (Lab)', 0.7, 'live'],
    ]);
    expect(releaseThrottle.mock.calls.map((call) => (call as unknown[])[2]).sort()).toEqual(['codex-lab', 'openai-codex']);
  });

  it('falls back to the account\'s own header readings when its read fails', async () => {
    const observed: ProviderUsage = {
      provider: 'openai-codex', route: 'codex-lab', displayName: 'OpenAI Codex', modes: ['codex-lab'],
      windows: [{ type: 'codex_primary', utilization: 0.5, resetsAt: NOW_SEC + 60 }], observedAt: NOW_SEC - 60,
      freshness: 'live', billing: 'subscription',
    };
    const failing = { readUsage: async () => { throw new Error('HTTP 500'); } };
    const { usage } = service({
      stored: [observed], codexAccounts: () => [{ id: 'codex-lab', label: 'Lab', account: failing }],
    });
    const rows = await usage.collect();
    expect(codexRows(rows)).toEqual([
      [null, 'OpenAI Codex', 0.2, 'live'],
      ['codex-lab', 'OpenAI Codex (Lab)', 0.5, 'stale'],
    ]);
    expect(rows.find((row) => row.route === 'codex-lab')?.note).toMatch(/HTTP 500/);
  });

  it('shows no row for a signed-out account it never read', async () => {
    const { usage } = service({
      codexAccounts: () => [{ id: 'codex-lab', label: 'Lab', account: { readUsage: async () => null } }],
    });
    expect(codexRows(await usage.collect()).map((row) => row[0])).toEqual([null]);
  });
});

describe('PI spend per account', () => {
  it('files an account\'s spend under its route, and the provider\'s own under the default', () => {
    const rows = ledgerSpend([
      piEntry('deepseek', 'deepseek'), piEntry('deepseek', 'deepseek-work'), piEntry('deepseek', 'removed'),
      piEntry('openai-codex', 'codex-lab'),
    ], (ref) => (ref.provider === 'openai-codex' ? 'subscription' : 'metered'), NOW, accountOf);
    expect(rows.map((row) => [row.provider, row.billing, row.route ?? null, row.connections])).toEqual([
      ['deepseek', 'api', null, ['deepseek']],
      ['deepseek', 'api', 'deepseek-work', ['deepseek-work']],
      ['openai-codex', 'subscription', 'codex-lab', ['codex-lab']],
    ]);
  });

  it('names a spend row by the account it was filed under', async () => {
    const { usage } = service({
      readLedger: async () => [piEntry('deepseek', 'deepseek-work')],
      accountLabels: () => [{ provider: 'deepseek', id: 'deepseek-work', label: 'Work' }],
    });
    const row = (await usage.collect()).find((candidate) => candidate.provider === 'deepseek');
    expect(row).toMatchObject({ route: 'deepseek-work', label: 'Work', displayName: 'DeepSeek (Work)', billing: 'api' });
  });
});

describe('a Codex reset per account', () => {
  it('spends on the account and lifts that account\'s throttle alone', async () => {
    const cleared: string[] = [];
    const row: ProviderUsage = {
      provider: 'openai-codex', route: 'codex-lab', displayName: 'OpenAI Codex (Lab)', modes: ['codex-lab'],
      windows: [{ type: 'codex_primary', utilization: 0, resetsAt: null }], observedAt: NOW_SEC + 5,
      freshness: 'live', billing: 'subscription',
    };
    const result = await redeemUsageReset('openai-codex', undefined, {
      accounts: { 'openai-codex': { readUsage: async () => reading(0.99), redeemReset: async () => ({ status: 'reset', cleared: [] }) } },
      usage: { getStatus: async () => [], refresh: async () => [row] },
      clearThrottle: async (key) => { cleared.push(key); },
      sleep: async () => {}, pollDelaysMs: [1], now: () => NOW.getTime(),
    }, 'codex-lab');
    expect(result).toMatchObject({ provider: 'openai-codex', connection: 'codex-lab', status: 'reset', usage: [row] });
    expect(cleared).toEqual(['openai-codex::codex-lab']);
  });

  it('refuses a connection that is not a stored Codex account', async () => {
    await expect(redeemUsageReset('openai-codex', undefined, {}, 'nobody')).rejects.toThrow(/No Codex account/);
  });
});
