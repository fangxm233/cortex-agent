import { AsyncMutex } from '@core/async-mutex.js';
import { providerStateRepo } from '@store/provider-state-repo.js';
import { usageWindowHistory } from './usage-window-history.js';

export type UsageFreshness = 'live' | 'stale' | 'never' | 'unsupported';

/**
 * How a row's traffic is billed. Subscription rows carry quota windows and never
 * carry spend (their recorded cost is an imputed API-equivalent price, not a bill);
 * metered rows carry spend and have no quota windows.
 */
export type UsageBilling = 'subscription' | 'api';

export interface UsageWindow {
  type: string;
  label?: string;
  utilization: number | null;
  resetsAt: number | null;
}

/** One banked rate-limit reset the account can spend. */
export interface UsageResetCredit {
  id: string;
  title: string | null;
  /** Epoch seconds; null when the provider gave no expiry. */
  expiresAt: number | null;
  /** Window types spending it clears, when the provider names them. */
  clears?: string[];
  /** Resets this credit still holds; one when absent. */
  count?: number;
}

export interface UsageResetCredits {
  availableCount: number;
  /** Whether the account is at a usage limit right now, when the provider says. */
  atLimit?: boolean;
  /** Spendable credits, earliest expiry first. May be empty when only the count is known. */
  credits: UsageResetCredit[];
  /** The listed credit the account itself offers next, when it names one. */
  nextCreditId?: string;
}

/** The credit a redeem without an explicit choice spends: the account's pick, else the earliest. */
export function nextResetCredit(credits: UsageResetCredits): UsageResetCredit | null {
  return credits.credits.find((credit) => credit.id === credits.nextCreditId) ?? credits.credits[0] ?? null;
}

export interface ProviderUsage {
  provider: string;
  /** An account's connection id: each account of a provider is a row of its own. Absent on the
   *  provider's default login and on metered rows. */
  route?: string;
  /** The account's label, beside `route`. */
  label?: string;
  displayName: string;
  /** Connections the row's traffic ran on (rows stored before connections hold gateway mode names). */
  modes: string[];
  windows: UsageWindow[];
  spend?: {
    today: number;
    /** Rolling 30 days. */
    month: number;
    /** The cost ledger's whole retention, 90 days; absent on rows stored before it was read. */
    all?: number;
  };
  observedAt: number | null;
  freshness: UsageFreshness;
  /** Absent on legacy records written before billing rows were split. */
  billing?: UsageBilling;
  /** Banked rate-limit resets; only an active account read knows them (OpenAI Codex today). */
  resetCredits?: UsageResetCredits;
  note?: string;
}

/**
 * Identity of a usage row. Rows are keyed by provider, billing kind and account, so one provider
 * can hold a subscription row per account and a metered row. Legacy records without `billing`
 * collapse onto the bare provider key.
 */
export function usageRecordKey(record: Pick<ProviderUsage, 'provider' | 'billing' | 'route'>): string {
  if (!record.billing) return record.provider;
  const base = `${record.provider}::${record.billing}`;
  return record.route ? `${base}::${record.route}` : base;
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
    ...(record.resetCredits ? { resetCredits: cloneResetCredits(record.resetCredits) } : {}),
  };
}

function cloneResetCredits(credits: UsageResetCredits): UsageResetCredits {
  return {
    ...credits,
    credits: credits.credits.map((credit) => ({ ...credit, ...(credit.clears ? { clears: [...credit.clears] } : {}) })),
  };
}

/** Response-header readings know nothing about banked resets, so they keep the stored ones. */
function withStoredResetCredits(existing: ProviderUsage | undefined, next: ProviderUsage): ProviderUsage {
  if (next.resetCredits || !existing?.resetCredits) return next;
  return { ...next, resetCredits: cloneResetCredits(existing.resetCredits) };
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

/** Where every quota reading is also offered, to keep its history (best-effort, never throws). */
export interface UsageObserver {
  observe(records: readonly ProviderUsage[]): void;
}

export class UsageStore {
  private readonly mutationMutex = new AsyncMutex();

  constructor(
    private readonly persistence: UsagePersistence = defaultPersistence,
    private readonly observer?: UsageObserver,
  ) {}

  async list(): Promise<ProviderUsage[]> {
    return canonicalRecords(await this.persistence.load());
  }

  /** Omit `billing` to match the first row of a provider regardless of billing kind; `route`
   *  names an account's row, and is omitted for the provider's default login. */
  async get(provider: string, billing?: UsageBilling, route?: string): Promise<ProviderUsage | null> {
    const records = await this.list();
    if (billing === undefined) return records.find((record) => record.provider === provider) ?? null;
    const key = usageRecordKey({ provider, billing, route });
    return records.find((record) => usageRecordKey(record) === key) ?? null;
  }

  async update(record: ProviderUsage): Promise<void> {
    this.observer?.observe([record]);
    await this.mutationMutex.run(async () => {
      const records = canonicalRecords(await this.persistence.load());
      const key = usageRecordKey(record);
      const existingIndex = records.findIndex((candidate) => usageRecordKey(candidate) === key);
      if (existingIndex !== -1 && !canReplace(records[existingIndex], record)) return;
      if (existingIndex === -1) records.push(record);
      else records[existingIndex] = withStoredResetCredits(records[existingIndex], record);
      await this.persistence.save(canonicalRecords(records));
    });
  }

  /**
   * Write a freshly composed table, dropping rows it omits. A row whose stored quota
   * observation is newer than the incoming one keeps that observation: the
   * composed table is built from a snapshot read before the write, so a live quota push
   * landing mid-collection must not be rolled back. Spend and labels always take the
   * incoming values, which are authoritative for the cycle.
   */
  async commit(records: ProviderUsage[]): Promise<void> {
    this.observer?.observe(records);
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

export const usageStore = new UsageStore(defaultPersistence, usageWindowHistory);
