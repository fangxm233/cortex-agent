// input:  ProviderStateRepo and provider usage readings
// output: ProviderUsage model and observation-ordered usage store
// pos:    Backend-neutral source of latest provider usage
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { AsyncMutex } from '@core/async-mutex.js';
import { providerStateRepo } from '@store/provider-state-repo.js';

export type UsageFreshness = 'live' | 'stale' | 'never' | 'unsupported';

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
  note?: string;
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
  const byProvider = new Map<string, ProviderUsage>();
  for (const record of records) byProvider.set(record.provider, cloneRecord(record));
  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
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

  async get(provider: string): Promise<ProviderUsage | null> {
    return (await this.list()).find((record) => record.provider === provider) ?? null;
  }

  async update(record: ProviderUsage): Promise<void> {
    await this.mutationMutex.run(async () => {
      const records = canonicalRecords(await this.persistence.load());
      const existingIndex = records.findIndex((candidate) => candidate.provider === record.provider);
      if (existingIndex !== -1 && !canReplace(records[existingIndex], record)) return;
      if (existingIndex === -1) records.push(record);
      else records[existingIndex] = record;
      await this.persistence.save(canonicalRecords(records));
    });
  }

  async replace(records: ProviderUsage[]): Promise<void> {
    await this.mutationMutex.run(() => this.persistence.save(canonicalRecords(records)));
  }
}

export const usageStore = new UsageStore();
