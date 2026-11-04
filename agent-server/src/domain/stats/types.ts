// DTOs of the Stats page (Settings → Resources → Stats): token usage from the cost ledger, tool
// activity from conversation history, and quota-window history from usage observations.
// Every timestamp is epoch milliseconds; day buckets follow the server's local calendar day.

export type StatsRange = '24h' | '7d' | '30d' | '90d';

/** What the Token usage chart can stack by besides token kind. */
export type StatsDimension = 'model' | 'project' | 'source';

/** A ledger row's trigger, folded for display. `background` is a `*:bg-continuation` trigger. */
export type StatsSource = 'chat' | 'background' | 'subagent' | 'scheduled' | 'cacheRefresh' | 'compact' | 'other';

export type StatsToolKind = 'tool' | 'skill' | 'mcp';

/** `input` is uncached prompt input; the full prompt is input + cacheWrite + cacheRead. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface StatsTotals extends TokenCounts {
  /** input + output + cacheWrite + cacheRead. */
  total: number;
  /** Ledger rows: one per finished run. */
  runs: number;
  /** Model API requests. */
  requests: number;
  /** Billed cost on metered connections, the imputed API price on subscriptions. */
  costUsd: number;
}

export interface StatsWindow {
  range: StatsRange;
  /** 0 is the period ending now; page n is n whole periods earlier. */
  page: number;
  bucket: 'hour' | 'day';
  /** [start, end) of the period. `end` is the end of the current hour/day on page 0. */
  start: number;
  end: number;
  /** Whether page + 1 still overlaps the ledger's 90-day retention. */
  hasOlder: boolean;
}

/** One hour or day of the period. */
export interface StatsBucket extends StatsTotals {
  start: number;
}

/**
 * One series of a chart: a value per bucket, aligned with the period's buckets.
 * `key` null is the folded remainder ("N others"); `colorSlot` null draws it in the neutral grey.
 */
export interface StatsSeries {
  key: string | null;
  /** How many keys the remainder folds; 0 for a named key. */
  folded: number;
  /** 0–7: the categorical slot, fixed by the key's rank over the whole 90-day ledger so that
   *  filters and paging never repaint an entity. Null past slot 7 and for the remainder. */
  colorSlot: number | null;
  total: number;
  values: number[];
}

export interface StatsGroup extends StatsTotals {
  key: string;
  colorSlot: number | null;
}

export interface StatsShare {
  key: string;
  colorSlot: number | null;
  total: number;
}

export interface StatsSessionRow extends StatsTotals {
  sessionId: string;
  label: string | null;
  projectId: string | null;
  /** The model with the most tokens in the period. */
  mainModel: string | null;
  lastAt: number;
  /** Top 4 by tokens, in the period. */
  models: StatsShare[];
  sources: StatsShare[];
}

export interface StatsUsage {
  window: StatsWindow;
  totals: StatsTotals;
  /** The period just before, same length; null when it falls outside the 90-day retention. */
  previous: StatsTotals | null;
  buckets: StatsBucket[];
  /** Token totals per bucket by dimension: top 6 keys of the period, then the remainder if any. */
  series: Record<StatsDimension, StatsSeries[]>;
  /** Every key of the period, most tokens first. */
  groups: Record<StatsDimension, StatsGroup[]>;
  /** Top 50 sessions by tokens. */
  sessions: StatsSessionRow[];
  sessionCount: number;
  /** Run counts per bucket: top 5 keys, no remainder. */
  runs: Record<'model' | 'source', StatsSeries[]>;
  /** Projects with ledger rows in the last 90 days, for the filter. */
  projects: string[];
}

export interface StatsToolRank {
  name: string;
  count: number;
  colorSlot: number | null;
}

export interface StatsTools {
  window: StatsWindow;
  kind: StatsToolKind;
  /** False until the first index build has finished; the counts are then empty, not zero. */
  ready: boolean;
  total: number;
  distinct: number;
  /** Call counts per bucket: top 5 names, no remainder. */
  series: StatsSeries[];
  /** Top 10 names. */
  ranking: StatsToolRank[];
}

export interface StatsQuotaAccount {
  provider: string;
  /** The account's connection id; null for the provider's default login. */
  route: string | null;
  label: string;
}

export type StatsQuotaSpan = 'fiveHour' | 'weekly';

export interface StatsQuotaPeriod {
  /** The provider's own window type (e.g. `five_hour`, `seven_day`, `primary`). */
  windowType: string;
  start: number;
  /** The window's reset time. */
  end: number;
  /** Highest utilization observed in the period, 0–1. Sparse observations can understate it. */
  peakUtilization: number;
  lastObservedAt: number;
  /** The account's ledger usage in [start, end) split by source, cost-weighted; shares sum to 1.
   *  Empty when the ledger holds no row for the account in the period. */
  breakdown: Array<{ key: StatsSource; colorSlot: number | null; share: number }>;
}

export interface StatsQuotaWindows {
  /** Subscription accounts with any recorded window. */
  accounts: StatsQuotaAccount[];
  /** The account shown: the requested one, else the first. */
  account: StatsQuotaAccount | null;
  /** Newest first, at most 50 each. */
  periods: Record<StatsQuotaSpan, StatsQuotaPeriod[]>;
  /** First recorded observation; null when nothing has been recorded yet. */
  recordingSince: number | null;
}
