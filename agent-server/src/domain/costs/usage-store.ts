// input:  ProviderStateRepo and provider usage readings
// output: ProviderUsage model and ordered atomic usage store
// pos:    Backend-neutral source of latest provider usage
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { AsyncMutex } from '@core/async-mutex.js';
import { providerStateRepo } from '@store/provider-state-repo.js';

export type UsageFreshness = 'live' | 'stale' | 'never' | 'unsupported';

/**
 * How a row's traffic is billed. Subscription rows carry quota windows and never
 * carry spend (their gateway cost is an imputed API-equivalent price, not a bill);
 * metered rows carry spend and have no quota windows.
 */
export type UsageBilling = 'subscription' | 'api';

export interface UsageWindow {
  type: string;
  label?: string;
  utilization: number | null;
  resetsAt: number | null;
}

export interface ProviderUsage {
  provider: string;
  displayName: string;
  modes: string[];
  windows: UsageWindow[];
  spend?: {
    today: number;
    month: number;
  };
  observedAt: number | null;
  freshness: UsageFreshness;
  /** Absent on legacy records written before billing rows were split. */
  billing?: UsageBilling;
  note?: string;
}

/**
 * Identity of a usage row. Rows are keyed by provider *and* billing kind so one
 * provider can hold both a subscription row and a metered row. Legacy records
 * without `billing` collapse onto the bare provider key.
 */
export function usageRecordKey(record: Pick<ProviderUsage, 'provider' | 'billing'>): string {
  return record.billing ? `${record.provider}::${record.billing}` : record.provider;
}

export interface UsagePersistence {
  load: () => Promise<ProviderUsage[]>;
  save: (records: ProviderUsage[]) => Promise<void>;
}

function cloneRecord(record: ProviderUsage): ProviderUsage {
  return {
    ...record,
    modes: [...record.modes],
    windows: record.windows.map((window) => ({ ...window })),
    ...(record.spend ? { spend: { ...record.spend } } : {}),
  };
}

function canonicalRecords(records: ProviderUsage[]): ProviderUsage[] {
  const byKey = new Map<string, ProviderUsage>();
  for (const record of records) byKey.set(usageRecordKey(record), cloneRecord(record));
  return [...byKey.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || usageRecordKey(a).localeCompare(usageRecordKey(b)),
  );
}

function canReplace(existing: ProviderUsage, next: ProviderUsage): boolean {
  if (existing.observedAt === null) return true;
  if (next.observedAt === null) return false;
  return next.observedAt >= existing.observedAt;
}

const defaultPersistence: UsagePersistence = {
  load: () => providerStateRepo.getProviderUsage(),
  save: (records) => providerStateRepo.setProviderUsage(records),
};

export class UsageStore {
  private readonly mutationMutex = new AsyncMutex();

  constructor(private readonly persistence: UsagePersistence = defaultPersistence) {}

  async list(): Promise<ProviderUsage[]> {
    return canonicalRecords(await this.persistence.load());
  }

  /** Omit `billing` to match the first row of a provider regardless of billing kind. */
  async get(provider: string, billing?: UsageBilling): Promise<ProviderUsage | null> {
    const records = await this.list();
    if (billing === undefined) return records.find((record) => record.provider === provider) ?? null;
    const key = usageRecordKey({ provider, billing });
    return records.find((record) => usageRecordKey(record) === key) ?? null;
  }

  async update(record: ProviderUsage): Promise<void> {
    await this.mutationMutex.run(async () => {
      const records = canonicalRecords(await this.persistence.load());
      const key = usageRecordKey(record);
      const existingIndex = records.findIndex((candidate) => usageRecordKey(candidate) === key);
      if (existingIndex !== -1 && !canReplace(records[existingIndex], record)) return;
      if (existingIndex === -1) records.push(record);
      else records[existingIndex] = record;
      await this.persistence.save(canonicalRecords(records));
    });
  }

  async replace(records: ProviderUsage[]): Promise<void> {
    await this.mutationMutex.run(() => this.persistence.save(canonicalRecords(records)));
  }

  /**
   * Write a freshly composed table, dropping rows it omits. Unlike `replace`, a row whose
   * stored quota observation is newer than the incoming one keeps that observation: the
   * composed table is built from a snapshot read before the write, so a live quota push
   * landing mid-collection must not be rolled back. Spend and labels always take the
   * incoming values, which are authoritative for the cycle.
   */
  async commit(records: ProviderUsage[]): Promise<void> {
    await this.mutationMutex.run(async () => {
      const stored = new Map(
        canonicalRecords(await this.persistence.load()).map((record) => [usageRecordKey(record), record]),
      );
      const merged = records.map((record) => {
        const existing = stored.get(usageRecordKey(record));
        if (!existing || canReplace(existing, record)) return record;
        return { ...record, windows: existing.windows.map((w) => ({ ...w })), observedAt: existing.observedAt, freshness: existing.freshness };
      });
      await this.persistence.save(canonicalRecords(merged));
    });
  }
}

export const usageStore = new UsageStore();
