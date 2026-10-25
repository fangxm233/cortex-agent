import { normalizeModel, normalizeProvider, normalizeTool, toIdent, type NameCatalog } from './normalize.js';
import type { RawRollup, RawTurnRow } from './rollup-types.js';
import { emptyTurnRow } from './rollup-types.js';
import {
  bucketIndex, DailyEventSchema, emptyHistogram, FEATURE_COUNTERS, MESSAGE_CHANNELS,
  type DailyEvent, type TurnHealthRow,
} from './schema.js';

type TurnFailures = TurnHealthRow['failures'];

function addInto(target: number[], source: number[]): void {
  source.forEach((value, index) => { target[index] = (target[index] ?? 0) + value; });
}

function sumRecord<K extends string>(target: Partial<Record<K, number>>, source: Partial<Record<K, number>>): void {
  for (const [key, value] of Object.entries(source) as [K, number][]) target[key] = (target[key] ?? 0) + value;
}

function mergeTurnRow(target: RawTurnRow, row: RawTurnRow): void {
  sumRecord(target.outcomes, row.outcomes);
  sumRecord(target.failures as TurnFailures, row.failures as TurnFailures);
  sumRecord(target.compactions, row.compactions);
  sumRecord(target.tokens, row.tokens);
  target.retries += row.retries;
  target.fallbacks += row.fallbacks;
  addInto(target.ttftMs, row.ttftMs);
  addInto(target.durationS, row.durationS);
  addInto(target.contextPctAtEnd, row.contextPctAtEnd);
}

/** Normalize each row's provider/model, merging rows that collapse onto the same name. */
function turnRows(rollup: RawRollup, catalog: NameCatalog): TurnHealthRow[] {
  const merged = new Map<string, TurnHealthRow>();
  for (const row of Object.values(rollup.turns)) {
    const { provider, customApi } = normalizeProvider(row.backend, row.provider, catalog);
    const model = normalizeModel(row.backend, row.provider, row.model, catalog);
    const key = [row.backend, provider, model, row.billing, customApi].join('|');
    if (!merged.has(key)) merged.set(key, { ...emptyTurnRow(row.backend, provider, model, row.billing), customApi });
    mergeTurnRow(merged.get(key) as RawTurnRow, row);
  }
  return [...merged.values()].sort((a, b) => total(b) - total(a)).slice(0, 100);
}

function total(row: TurnHealthRow): number {
  return row.outcomes.completed + row.outcomes.failed + row.outcomes.cancelled + row.outcomes.rateLimited;
}

function tools(rollup: RawRollup): DailyEvent['tools'] {
  const merged = new Map<string, { calls: number; errors: number }>();
  for (const [name, counts] of Object.entries(rollup.tools)) {
    const key = normalizeTool(name);
    const entry = merged.get(key) ?? { calls: 0, errors: 0 };
    merged.set(key, { calls: entry.calls + counts.calls, errors: entry.errors + counts.errors });
  }
  return [...merged].map(([name, counts]) => ({ name, ...counts }))
    .sort((a, b) => b.calls - a.calls).slice(0, 200);
}

function pick<K extends string>(source: Record<string, number>, keys: readonly K[]): Partial<Record<K, number>> {
  return Object.fromEntries(keys.filter((key) => source[key] > 0).map((key) => [key, source[key]])) as Partial<Record<K, number>>;
}

function identRecord(source: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) out[toIdent(key)] = (out[toIdent(key)] ?? 0) + value;
  return out;
}

function turnsPerSession(sessionTurns: Record<string, number>): number[] {
  const histogram = emptyHistogram('turnsPerSession');
  for (const turns of Object.values(sessionTurns)) histogram[bucketIndex('turnsPerSession', turns)] += 1;
  return histogram;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function perf(rollup: RawRollup): DailyEvent['perf'] {
  const loop = rollup.perf.eventLoopP99s;
  return {
    startups: rollup.perf.startups.slice(-10).map(identRecord),
    eventLoop: { windows: loop.length, p99MedianMs: median(loop), p99MaxMs: loop.length ? Math.max(...loop) : 0 },
    web: rollup.perf.web,
    sseReconnects: rollup.perf.sseReconnects,
    remoteClientDisconnects: rollup.perf.remoteClientDisconnects,
  };
}

/** One finished day as an upload, or null when it does not fit the wire schema. */
export function toDailyEvent(rollup: RawRollup, catalog: NameCatalog): DailyEvent | null {
  const event: DailyEvent = {
    type: 'daily',
    day: rollup.day,
    turns: turnRows(rollup, catalog),
    features: pick(rollup.features, FEATURE_COUNTERS),
    messagesByChannel: pick(rollup.messagesByChannel, MESSAGE_CHANNELS),
    uiOps: identRecord(rollup.uiOps),
    tools: tools(rollup),
    agent: {
      userInterrupts: rollup.agent.userInterrupts,
      superseded: rollup.agent.superseded,
      turnsPerSession: turnsPerSession(rollup.agent.sessionTurns),
      workers: rollup.agent.workers,
      subagents: rollup.agent.subagents,
    },
    perf: perf(rollup),
    errors: {
      byModule: identRecord(rollup.errors.byModule),
      samples: rollup.errors.samples.slice(0, 5).map((sample) => ({ ...sample, module: toIdent(sample.module) })),
    },
  };
  const parsed = DailyEventSchema.safeParse(event);
  return parsed.success ? parsed.data : null;
}
