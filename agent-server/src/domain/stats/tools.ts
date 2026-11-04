// Tool activity for one Stats query, from the tool index's per-session hourly counts. Pure.
import { addTo, addValue, colorSlots, rankKeys, slotOf, topSeries, type KeyedValues } from './keys.js';
import type { StatsToolsQuery } from './query.js';
import type { ToolIndexSnapshot, ToolCell } from './tool-index.js';
import type { StatsTools } from './types.js';
import { HOUR_MS, RETENTION_MS, bucketIndex, statsPeriod } from './window.js';

const SERIES_LIMIT = 5;
const RANKING_LIMIT = 10;
/** Calls in a session the registry no longer knows count toward the default project. */
export const DEFAULT_PROJECT = 'general';

/** Names are merged case-insensitively; each shows as its most-called spelling. */
function displayNames(cells: readonly ToolCell[]): Map<string, string> {
  const spellings = new Map<string, Map<string, number>>();
  for (const cell of cells) {
    const key = cell.name.toLowerCase();
    if (!spellings.has(key)) spellings.set(key, new Map());
    addTo(spellings.get(key)!, cell.name, cell.count);
  }
  return new Map([...spellings].map(([key, counts]) => [key, rankKeys(counts)[0]!]));
}

function countsByName(cells: readonly ToolCell[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const cell of cells) addTo(totals, cell.name.toLowerCase(), cell.count);
  return totals;
}

export function aggregateTools(
  snapshot: ToolIndexSnapshot, query: StatsToolsQuery, now: number, projectOf: (sessionId: string) => string,
): StatsTools {
  const period = statsPeriod(query.range, query.page, now);
  const empty: StatsTools = { window: period.window, kind: query.kind, ready: snapshot.ready, total: 0, distinct: 0, series: [], ranking: [] };
  if (!snapshot.ready) return empty;
  const cutoffHour = Math.floor((now - RETENTION_MS) / HOUR_MS);
  const retained = snapshot.cells.filter((cell) => cell.kind === query.kind && cell.hour >= cutoffHour);
  const names = displayNames(retained);
  const slots = colorSlots(countsByName(retained));
  const scoped = query.projectId ? retained.filter((cell) => projectOf(cell.sessionId) === query.projectId) : retained;
  const values: KeyedValues = new Map();
  for (const cell of scoped) {
    const index = bucketIndex(period, cell.hour * HOUR_MS);
    if (index >= 0) addValue(values, cell.name.toLowerCase(), index, cell.count, period.starts.length);
  }
  const totals = new Map([...values].map(([key, row]) => [key, row.reduce((acc, value) => acc + value, 0)]));
  const series = topSeries(values, slots, { limit: SERIES_LIMIT, buckets: period.starts.length, withRemainder: false });
  return {
    ...empty,
    total: [...totals.values()].reduce((acc, value) => acc + value, 0),
    distinct: totals.size,
    series: series.map((entry) => ({ ...entry, key: names.get(entry.key!)! })),
    ranking: rankKeys(totals).slice(0, RANKING_LIMIT)
      .map((key) => ({ name: names.get(key)!, count: totals.get(key)!, colorSlot: slotOf(slots, key) })),
  };
}
