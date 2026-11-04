// Token usage from the cost ledger: one row per finished run, aggregated over a Stats period.
// Pure: rows, the query, `now` and a session lookup in; the StatsUsage DTO out.
import type { CostEntry } from '@domain/costs/cost-tracker.js';
import {
  addTo, addValue, colorSlots, foldSource, rankKeys, slotOf, topSeries, type KeyedValues,
} from './keys.js';
import type {
  StatsDimension, StatsGroup, StatsSessionRow, StatsShare, StatsSource, StatsTotals, StatsUsage,
} from './types.js';
import { RETENTION_MS, bucketIndex, statsPeriod, type StatsPeriod } from './window.js';
import type { StatsUsageQuery } from './query.js';

export interface UsageRow {
  at: number;
  model: string;
  project: string;
  source: StatsSource;
  sessionId: string | null;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  requests: number;
  cost: number;
}

export interface SessionInfo {
  label: string | null;
  projectId: string | null;
}

export type SessionLookup = (sessionId: string) => SessionInfo | null;

const SERIES_LIMIT = 6;
const RUNS_LIMIT = 5;
const SESSION_LIMIT = 50;
const SHARE_LIMIT = 4;
const DIMENSIONS: Record<StatsDimension, (row: UsageRow) => string> = {
  model: (row) => row.model,
  project: (row) => row.project,
  source: (row) => row.source,
};

/** A ledger entry as a usage row; null when its timestamp does not parse. Absent counts are 0. */
export function usageRow(entry: CostEntry): UsageRow | null {
  const at = Date.parse(entry.timestamp);
  if (!Number.isFinite(at)) return null;
  return {
    at, model: entry.model || 'unknown', project: entry.project || 'general',
    source: foldSource(entry.trigger || ''), sessionId: entry.session_id || null,
    input: entry.input_tokens || 0, output: entry.output_tokens || 0,
    cacheWrite: entry.cache_creation_tokens || 0, cacheRead: entry.cache_read_tokens || 0,
    requests: entry.provider_requests || 0, cost: entry.cost_usd || 0,
  };
}

export function rowTokens(row: UsageRow): number {
  return row.input + row.output + row.cacheWrite + row.cacheRead;
}

export function emptyTotals(): StatsTotals {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, runs: 0, requests: 0, costUsd: 0 };
}

function addRow(totals: StatsTotals, row: UsageRow): void {
  totals.input += row.input;
  totals.output += row.output;
  totals.cacheWrite += row.cacheWrite;
  totals.cacheRead += row.cacheRead;
  totals.total += rowTokens(row);
  totals.runs += 1;
  totals.requests += row.requests;
  totals.costUsd += row.cost;
}

function totalsOf(rows: readonly UsageRow[]): StatsTotals {
  const totals = emptyTotals();
  for (const row of rows) addRow(totals, row);
  return totals;
}

function inRange(rows: readonly UsageRow[], start: number, end: number): UsageRow[] {
  return rows.filter((row) => row.at >= start && row.at < end);
}

/** Colour slots per dimension, by tokens over the whole retained ledger. */
export function usageSlots(rows: readonly UsageRow[]): Record<StatsDimension, Map<string, number>> {
  const slots = {} as Record<StatsDimension, Map<string, number>>;
  for (const [dimension, keyOf] of Object.entries(DIMENSIONS) as Array<[StatsDimension, (row: UsageRow) => string]>) {
    const totals = new Map<string, number>();
    for (const row of rows) addTo(totals, keyOf(row), rowTokens(row));
    slots[dimension] = colorSlots(totals);
  }
  return slots;
}

function bucketsOf(period: StatsPeriod, rows: readonly UsageRow[]): StatsUsage['buckets'] {
  const buckets = period.starts.map((start) => ({ start, ...emptyTotals() }));
  for (const row of rows) {
    const index = bucketIndex(period, row.at);
    if (index >= 0) addRow(buckets[index]!, row);
  }
  return buckets;
}

interface DimensionTally {
  groups: Map<string, StatsTotals>;
  tokens: KeyedValues;
  runs: KeyedValues;
}

function tallyDimension(period: StatsPeriod, rows: readonly UsageRow[], keyOf: (row: UsageRow) => string): DimensionTally {
  const tally: DimensionTally = { groups: new Map(), tokens: new Map(), runs: new Map() };
  const buckets = period.starts.length;
  for (const row of rows) {
    const key = keyOf(row);
    const index = bucketIndex(period, row.at);
    if (!tally.groups.has(key)) tally.groups.set(key, emptyTotals());
    addRow(tally.groups.get(key)!, row);
    addValue(tally.tokens, key, index, rowTokens(row), buckets);
    addValue(tally.runs, key, index, 1, buckets);
  }
  return tally;
}

function groupsOf(tally: DimensionTally, slots: ReadonlyMap<string, number>): StatsGroup[] {
  const totals = new Map([...tally.groups].map(([key, group]) => [key, group.total]));
  return rankKeys(totals).map((key) => ({ key, colorSlot: slotOf(slots, key), ...tally.groups.get(key)! }));
}

type DimensionViews = Pick<StatsUsage, 'series' | 'groups' | 'runs'>;

function dimensionViews(
  period: StatsPeriod, rows: readonly UsageRow[], slots: Record<StatsDimension, Map<string, number>>,
): DimensionViews {
  const views = { series: {}, groups: {}, runs: {} } as DimensionViews;
  const buckets = period.starts.length;
  for (const [dimension, keyOf] of Object.entries(DIMENSIONS) as Array<[StatsDimension, (row: UsageRow) => string]>) {
    const tally = tallyDimension(period, rows, keyOf);
    views.series[dimension] = topSeries(tally.tokens, slots[dimension], { limit: SERIES_LIMIT, buckets, withRemainder: true });
    views.groups[dimension] = groupsOf(tally, slots[dimension]);
    if (dimension !== 'project') {
      views.runs[dimension] = topSeries(tally.runs, slots[dimension], { limit: RUNS_LIMIT, buckets, withRemainder: false });
    }
  }
  return views;
}

interface SessionTally {
  totals: StatsTotals;
  models: Map<string, number>;
  sources: Map<string, number>;
  lastAt: number;
  project: string;
}

function tallySessions(rows: readonly UsageRow[]): Map<string, SessionTally> {
  const sessions = new Map<string, SessionTally>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    let tally = sessions.get(row.sessionId);
    if (!tally) {
      tally = { totals: emptyTotals(), models: new Map(), sources: new Map(), lastAt: row.at, project: row.project };
      sessions.set(row.sessionId, tally);
    }
    addRow(tally.totals, row);
    addTo(tally.models, row.model, rowTokens(row));
    addTo(tally.sources, row.source, rowTokens(row));
    if (row.at >= tally.lastAt) {
      tally.lastAt = row.at;
      tally.project = row.project;
    }
  }
  return sessions;
}

function shares(totals: ReadonlyMap<string, number>, slots: ReadonlyMap<string, number>): StatsShare[] {
  return rankKeys(totals).slice(0, SHARE_LIMIT)
    .map((key) => ({ key, colorSlot: slotOf(slots, key), total: totals.get(key)! }));
}

function sessionRow(
  sessionId: string, tally: SessionTally, slots: Record<StatsDimension, Map<string, number>>, lookup: SessionLookup,
): StatsSessionRow {
  const info = lookup(sessionId);
  return {
    sessionId, label: info?.label ?? null, projectId: info?.projectId ?? tally.project,
    mainModel: rankKeys(tally.models)[0] ?? null, lastAt: tally.lastAt,
    models: shares(tally.models, slots.model), sources: shares(tally.sources, slots.source),
    ...tally.totals,
  };
}

function topSessions(
  rows: readonly UsageRow[], slots: Record<StatsDimension, Map<string, number>>, lookup: SessionLookup,
): { sessions: StatsSessionRow[]; sessionCount: number } {
  const tallies = tallySessions(rows);
  const ranked = rankKeys(new Map([...tallies].map(([id, tally]) => [id, tally.totals.total])));
  const sessions = ranked.slice(0, SESSION_LIMIT).map((id) => sessionRow(id, tallies.get(id)!, slots, lookup));
  return { sessions, sessionCount: tallies.size };
}

/** The Stats page's token usage for one query. `rows` may span more than the retention; older rows
 *  are ignored, so the 90-day ledger is the same whatever the file still holds. */
export function aggregateUsage(
  rows: readonly UsageRow[], query: StatsUsageQuery, now: number, lookup: SessionLookup,
): StatsUsage {
  const retentionStart = now - RETENTION_MS;
  const retained = rows.filter((row) => row.at >= retentionStart);
  const slots = usageSlots(retained);
  const scoped = query.projectId ? retained.filter((row) => row.project === query.projectId) : retained;
  const period = statsPeriod(query.range, query.page, now);
  const current = inRange(scoped, period.window.start, period.window.end);
  const before = statsPeriod(query.range, query.page + 1, now).window;
  return {
    window: period.window,
    totals: totalsOf(current),
    previous: before.start >= retentionStart ? totalsOf(inRange(scoped, before.start, before.end)) : null,
    buckets: bucketsOf(period, current),
    ...dimensionViews(period, current, slots),
    ...topSessions(current, slots, lookup),
    projects: [...new Set(retained.map((row) => row.project))].sort(),
  };
}
