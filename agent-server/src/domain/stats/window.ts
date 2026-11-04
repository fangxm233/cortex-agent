// The period a Stats query covers: hourly buckets for 24h, local calendar days otherwise. Page n
// shifts the period back n whole periods; everything is pinned to an injected `now`.
import type { StatsRange, StatsWindow } from './types.js';

export const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The cost ledger and the tool index both keep 90 days. */
export const RETENTION_MS = 90 * DAY_MS;

const RANGE_DAYS: Record<Exclude<StatsRange, '24h'>, number> = { '7d': 7, '30d': 30, '90d': 90 };
const HOURS_PER_DAY_RANGE = 24;

export interface StatsPeriod {
  window: StatsWindow;
  /** Bucket starts, oldest first; bucket i covers [starts[i], starts[i + 1] ?? end). */
  starts: number[];
}

/** Local midnight `offset` days after the local day containing `ms` (DST-safe: calendar math). */
function localMidnight(ms: number, offset: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
}

/** Bucket edges, oldest first: n buckets have n + 1 edges, the last being the period's end. */
function hourlyEdges(now: number, page: number): number[] {
  const hour = new Date(now);
  hour.setMinutes(0, 0, 0);
  const end = hour.getTime() + HOUR_MS - page * HOURS_PER_DAY_RANGE * HOUR_MS;
  return Array.from({ length: HOURS_PER_DAY_RANGE + 1 }, (_, i) => end - (HOURS_PER_DAY_RANGE - i) * HOUR_MS);
}

function dailyEdges(now: number, page: number, days: number): number[] {
  const lastDay = -page * days;
  return Array.from({ length: days + 1 }, (_, i) => localMidnight(now, lastDay - days + 1 + i));
}

/** The period of `range` on `page`, with `hasOlder` judged against the 90-day retention. */
export function statsPeriod(range: StatsRange, page: number, now: number): StatsPeriod {
  const edges = range === '24h' ? hourlyEdges(now, page) : dailyEdges(now, page, RANGE_DAYS[range]);
  const start = edges[0]!;
  const end = edges[edges.length - 1]!;
  const window: StatsWindow = {
    range, page, bucket: range === '24h' ? 'hour' : 'day', start, end, hasOlder: start > now - RETENTION_MS,
  };
  return { window, starts: edges.slice(0, -1) };
}

/** Index of the bucket holding `at`, or -1 outside the period. */
export function bucketIndex(period: StatsPeriod, at: number): number {
  const { starts, window } = period;
  if (at < window.start || at >= window.end) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
