// Stats page queries. Contract stubs: each returns an empty but well-formed result until the
// aggregations land.
import type {
  StatsQuotaWindows, StatsRange, StatsToolKind, StatsTools, StatsTotals, StatsUsage, StatsWindow,
} from './types.js';

export type * from './types.js';

export interface StatsUsageQuery {
  range: StatsRange;
  page: number;
  projectId: string | null;
}

export interface StatsToolsQuery extends StatsUsageQuery {
  kind: StatsToolKind;
}

export interface StatsQuotaWindowsQuery {
  provider: string | null;
  route: string | null;
}

function emptyTotals(): StatsTotals {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, runs: 0, requests: 0, costUsd: 0 };
}

function emptyWindow(range: StatsRange, page: number): StatsWindow {
  const now = Date.now();
  return { range, page, bucket: range === '24h' ? 'hour' : 'day', start: now, end: now, hasOlder: false };
}

export async function statsUsage(query: StatsUsageQuery): Promise<StatsUsage> {
  return {
    window: emptyWindow(query.range, query.page), totals: emptyTotals(), previous: null, buckets: [],
    series: { model: [], project: [], source: [] }, groups: { model: [], project: [], source: [] },
    sessions: [], sessionCount: 0, runs: { model: [], source: [] }, projects: [],
  };
}

export async function statsTools(query: StatsToolsQuery): Promise<StatsTools> {
  return {
    window: emptyWindow(query.range, query.page), kind: query.kind, ready: false,
    total: 0, distinct: 0, series: [], ranking: [],
  };
}

export async function statsQuotaWindows(_query: StatsQuotaWindowsQuery): Promise<StatsQuotaWindows> {
  return { accounts: [], account: null, periods: { fiveHour: [], weekly: [] }, recordingSince: null };
}
