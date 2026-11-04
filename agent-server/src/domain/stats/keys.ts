// Shared folding of Stats keys: the source a ledger trigger counts as, colour slots fixed by a key's
// 90-day rank, and top-N series with a folded remainder.
import type { StatsSeries, StatsSource } from './types.js';

const COLOR_SLOTS = 8;

const TRIGGER_SOURCES: Record<string, StatsSource> = {
  user: 'chat',
  subagent: 'subagent',
  scheduled: 'scheduled',
  'cache-refresh': 'cacheRefresh',
  'manual-compact': 'compact',
};

/** A ledger trigger folded for display; any `*bg-continuation` trigger is background work. */
export function foldSource(trigger: string): StatsSource {
  if (trigger.endsWith('bg-continuation')) return 'background';
  return TRIGGER_SOURCES[trigger] ?? 'other';
}

/** Keys most first; ties break on the key so the order is stable. */
export function rankKeys(totals: ReadonlyMap<string, number>): string[] {
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key]) => key);
}

/** Colour slot per key: its rank when within the first eight, absent otherwise. */
export function colorSlots(totals: ReadonlyMap<string, number>): Map<string, number> {
  return new Map(rankKeys(totals).slice(0, COLOR_SLOTS).map((key, slot) => [key, slot]));
}

export function slotOf(slots: ReadonlyMap<string, number>, key: string): number | null {
  return slots.get(key) ?? null;
}

export function addTo(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

/** Per-key values aligned with a period's buckets. */
export type KeyedValues = Map<string, number[]>;

export function addValue(values: KeyedValues, key: string, index: number, value: number, buckets: number): void {
  let row = values.get(key);
  if (!row) {
    row = new Array<number>(buckets).fill(0);
    values.set(key, row);
  }
  row[index]! += value;
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function namedSeries(key: string, values: number[], slots: ReadonlyMap<string, number>): StatsSeries {
  return { key, folded: 0, colorSlot: slotOf(slots, key), total: sum(values), values };
}

function remainderSeries(rest: string[], values: KeyedValues, buckets: number): StatsSeries {
  const folded = new Array<number>(buckets).fill(0);
  for (const key of rest) values.get(key)!.forEach((value, i) => { folded[i]! += value; });
  return { key: null, folded: rest.length, colorSlot: null, total: sum(folded), values: folded };
}

/**
 * The `limit` keys with the most in total, then — with `withRemainder` — one series folding the rest
 * when there is any.
 */
export function topSeries(
  values: KeyedValues, slots: ReadonlyMap<string, number>, opts: { limit: number; buckets: number; withRemainder: boolean },
): StatsSeries[] {
  const totals = new Map([...values].map(([key, row]) => [key, sum(row)]));
  const ranked = rankKeys(totals);
  const series = ranked.slice(0, opts.limit).map((key) => namedSeries(key, values.get(key)!, slots));
  const rest = ranked.slice(opts.limit);
  if (opts.withRemainder && rest.length > 0) series.push(remainderSeries(rest, values, opts.buckets));
  return series;
}
