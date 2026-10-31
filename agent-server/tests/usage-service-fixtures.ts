import type { AgentUsageScope, Backend } from '../src/agent-adapter/types.js';
import { Capability } from '../src/agent-adapter/capabilities.js';
import type { ConnectionBilling } from '../src/core/connections-file.js';
import type { SelectionRef } from '../src/domain/connections/index.js';
import type { CostEntry } from '../src/domain/costs/cost-tracker.js';
import type { BillingOf } from '../src/domain/costs/ledger-spend.js';
import type { ResetAccount } from '../src/domain/costs/reset-account.js';
import { UsageService, type UsageServiceStore } from '../src/domain/costs/usage-service.js';
import { UsageStore, usageRecordKey, type ProviderUsage } from '../src/domain/costs/usage-store.js';

/** Midday, so "today" and the rolling windows never straddle a local midnight in these fixtures. */
export const NOW = new Date(2026, 9, 30, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export class MemoryUsageStore implements UsageServiceStore {
  private records: ProviderUsage[] = [];
  commitCalls = 0;

  constructor(records: ProviderUsage[] = []) {
    this.records = structuredClone(records);
  }

  async list(): Promise<ProviderUsage[]> {
    return structuredClone(this.records).sort(
      (a, b) => a.provider.localeCompare(b.provider) || usageRecordKey(a).localeCompare(usageRecordKey(b)),
    );
  }

  async commit(records: ProviderUsage[]): Promise<void> {
    this.commitCalls += 1;
    this.records = structuredClone(records);
  }
}

export function usage(
  provider: string,
  freshness: ProviderUsage['freshness'],
  options: Partial<ProviderUsage> = {},
): ProviderUsage {
  return {
    provider,
    displayName: provider,
    modes: [provider],
    windows: [],
    observedAt: freshness === 'never' || freshness === 'unsupported' ? null : 1_700_000_000,
    freshness,
    ...options,
  };
}

/** The adapter shape the usage service reads (its dependency is structural, not a class). */
interface UsageProbeAdapter {
  backend: Backend;
  capabilities: Set<Capability>;
  getUsage: (scope: AgentUsageScope) => Promise<ProviderUsage[] | null>;
}

export function fakeAdapter(
  backend: Backend,
  getUsage: UsageProbeAdapter['getUsage'],
): UsageProbeAdapter {
  return {
    backend,
    capabilities: new Set([Capability.Usage]),
    getUsage,
  };
}

/** A ledger row `ageMs` before NOW. Defaults: Claude on the subscription, $1. */
export function ledgerRow(ageMs: number, overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    timestamp: new Date(NOW.getTime() - ageMs).toISOString(), project: 'nimbus', trigger: 'user',
    cost_usd: 1, num_turns: null, duration_s: null, backend: 'claude', mode: 'plan',
    connection: 'subscription', source: 'estimate', input_tokens: 10, output_tokens: 20,
    cache_read_tokens: 0, cache_creation_tokens: 0, provider: 'anthropic', model: 'claude-x',
    ...overrides,
  };
}

export const hoursAgo = (hours: number): number => hours * HOUR_MS;
export const daysAgo = (days: number): number => days * DAY_MS;

/** A Claude row on a metered key connection. */
export function claudeKeyRow(ageMs: number, connection: string, cost: number): CostEntry {
  return ledgerRow(ageMs, { mode: 'api', connection, cost_usd: cost });
}

/** A PI row on its provider. */
export function piRow(ageMs: number, provider: string, cost: number, overrides: Partial<CostEntry> = {}): CostEntry {
  return ledgerRow(ageMs, { backend: 'pi', mode: 'api', connection: provider, provider, cost_usd: cost, ...overrides });
}

/**
 * Billing by `<backend>:<connection or provider>`. Unlisted: Claude's subscription is a
 * subscription, everything else metered.
 */
export function billingTable(subscriptions: string[] = ['pi:openai-codex']): BillingOf & { calls: SelectionRef[] } {
  const calls: SelectionRef[] = [];
  const of = (ref: SelectionRef): ConnectionBilling => {
    calls.push(ref);
    const key = ref.backend === 'claude' ? `claude:${ref.connection}` : `pi:${ref.provider}`;
    if (ref.backend === 'claude' && ref.connection === 'subscription') return 'subscription';
    return subscriptions.includes(key) ? 'subscription' : 'metered';
  };
  return Object.assign(of, { calls });
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export function durableMemoryStore(): UsageStore {
  let records: ProviderUsage[] = [];
  return new UsageStore({
    load: async () => structuredClone(records),
    save: async (next) => { records = structuredClone(next); },
  });
}

export function serviceWith(options: {
  store?: UsageServiceStore;
  pi?: UsageProbeAdapter;
  ledger?: CostEntry[];
  readLedger?: () => Promise<readonly CostEntry[]>;
  billingOf?: BillingOf;
  claudeAccount?: Pick<ResetAccount, 'readUsage'>;
  codexAccount?: Pick<ResetAccount, 'readUsage'>;
  releaseThrottle?: (provider: string, windows: unknown[]) => Promise<unknown>;
}) {
  const store = options.store ?? new MemoryUsageStore();
  const pi = options.pi ?? fakeAdapter('pi', async () => []);
  const ledger = options.ledger ?? [];
  const service = new UsageService({
    store,
    getAdapter: () => pi,
    readLedger: options.readLedger ?? (async () => ledger),
    billingOf: options.billingOf ?? billingTable(),
    now: () => NOW,
    ...(options.claudeAccount ? { claudeAccount: options.claudeAccount } : {}),
    ...(options.codexAccount ? { codexAccount: options.codexAccount } : {}),
    ...(options.releaseThrottle ? { releaseThrottle: options.releaseThrottle } : {}),
  });
  return { service, store };
}
