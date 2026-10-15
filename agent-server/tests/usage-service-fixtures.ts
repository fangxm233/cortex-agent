import { vi } from 'vitest';
import type { AgentUsageScope, Backend } from '../src/agent-adapter/types.js';
import { Capability } from '../src/agent-adapter/capabilities.js';
import { UsageService, type UsageServiceStore } from '../src/domain/costs/usage-service.js';
import { UsageStore, usageRecordKey, type ProviderUsage } from '../src/domain/costs/usage-store.js';

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

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route A gateway: groups by provider and billing mode. Without `allRows` it predates lifetime totals. */
export function gatewayFetch(
  todayRows: unknown,
  monthRows: unknown,
  quotaProviders: unknown = [],
  allRows?: unknown,
): typeof fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url.includes('/quota?')) return json({ providers: quotaProviders });
    if (url.includes('period=all')) {
      return allRows === undefined ? new Response('unsupported period', { status: 400 }) : json({ rows: allRows });
    }
    return json({ rows: url.includes('period=today') ? todayRows : monthRows });
  }) as typeof fetch;
}

/** Route B gateway: rejects composite grouping, serves raw records instead. */
export function legacyGatewayFetch(
  todayRecords: unknown[],
  monthRecords: unknown[],
  quotaProviders: unknown = [],
): typeof fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url.includes('/quota?')) return json({ providers: quotaProviders });
    if (url.includes('group_by=')) return new Response('unsupported group_by', { status: 400 });
    // The two period reads differ only by `since`; anything older than a week is the month read.
    const since = Date.parse(decodeURIComponent(new URL(url).searchParams.get('since') ?? ''));
    const isToday = Date.now() - since < 7 * 24 * 60 * 60 * 1000;
    return json({ records: isToday ? todayRecords : monthRecords });
  }) as typeof fetch;
}

export function spend(provider: string, billingMode: string, costUsd: unknown) {
  return { provider, billing_mode: billingMode, cost_usd: costUsd };
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
  store?: MemoryUsageStore;
  anthropicModes?: string[];
  subscriptionModes?: string[];
  pi?: UsageProbeAdapter;
  fetch?: typeof globalThis.fetch;
}) {
  const store = options.store ?? new MemoryUsageStore();
  const pi = options.pi ?? fakeAdapter('pi', async () => []);
  const service = new UsageService({
    store,
    getAdapter: () => pi,
    getSettings: () => ({
      anthropicSubscriptionModes: options.anthropicModes ?? ['plan'],
      subscriptionBillingModes: options.subscriptionModes ?? ['plan', 'openai-codex'],
    }),
    fetch: options.fetch ?? gatewayFetch([], []),
    gatewayUrl: 'http://gateway.test',
  });
  return { service, store };
}
