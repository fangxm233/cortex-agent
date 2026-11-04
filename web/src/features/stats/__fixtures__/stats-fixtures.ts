// Deterministic Stats fixtures for render tests: a 7-day page, tool activity and quota windows.
import type {
  StatsBucket, StatsQuotaWindows, StatsSeries, StatsSessionRow, StatsTools, StatsTotals, StatsUsage,
} from '@cortex-agent/ui-contract';
import type { StatsController, StatsQuery } from '../useStats';

export const FIXTURE_NOW = Date.UTC(2026, 10, 3, 18);
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 28);
const DAYS = 7;

function totals(scale: number, over: Partial<StatsTotals> = {}): StatsTotals {
  const t = {
    input: 100 * scale, output: 2_000 * scale, cacheWrite: 6_000 * scale, cacheRead: 390_000 * scale,
    runs: 20 * scale, requests: 300 * scale, costUsd: 1.6 * scale, ...over,
  };
  return { ...t, total: t.input + t.output + t.cacheWrite + t.cacheRead };
}

const SCALES = [2, 4, 6, 4, 4, 3, 5];
const buckets: StatsBucket[] = SCALES.map((scale, i) => ({ start: START + i * DAY, ...totals(scale) }));
const periodTotals = totals(SCALES.reduce((a, b) => a + b, 0));

function series(key: string | null, slot: number | null, share: number, folded = 0): StatsSeries {
  const values = buckets.map((b) => Math.round(b.total * share));
  return { key, folded, colorSlot: slot, total: values.reduce((a, b) => a + b, 0), values };
}

function session(i: number, label: string | null, projectId: string): StatsSessionRow {
  const t = totals(10 - i);
  return {
    ...t, sessionId: `session-${i}`, label, projectId, mainModel: 'claude-opus-5-5[1m]', lastAt: FIXTURE_NOW - (i + 1) * DAY,
    models: [{ key: 'claude-opus-5-5[1m]', colorSlot: 0, total: t.total }],
    sources: [{ key: 'chat', colorSlot: 0, total: Math.round(t.total * 0.9) }, { key: 'background', colorSlot: 1, total: Math.round(t.total * 0.1) }],
  };
}

export const FIXTURE_USAGE: StatsUsage = {
  window: { range: '7d', page: 0, bucket: 'day', start: START, end: START + DAYS * DAY, hasOlder: true },
  totals: periodTotals,
  previous: totals(30),
  buckets,
  series: {
    model: [series('claude-opus-5-5[1m]', 0, 0.9), series('gpt-6-astra', 1, 0.08), series(null, null, 0.02, 4)],
    project: [series('wm-align', 2, 0.6), series('cortex-self', 0, 0.4)],
    source: [series('chat', 0, 0.85), series('background', 1, 0.1), series('cacheRefresh', 5, 0.05)],
  },
  groups: { model: [], project: [], source: [] },
  sessions: [
    session(0, 'wp1-serialize', 'alap'), session(1, null, 'cortex-self'), session(2, 'arml-code', 'wm-align'),
    session(3, 'arml-aces', 'wm-align'), session(4, 'rr-arm6', 'wm-align'), session(5, 'windows-onboarding', 'cortex-self'),
    session(6, 'connections-core', 'cortex-self'), session(7, 'a7cc44f9', 'cortex-self'),
  ],
  sessionCount: 96,
  runs: {
    model: [series('claude-opus-5-5[1m]', 0, 0.0001), series('gpt-6-astra', 1, 0.00002)],
    source: [series('chat', 0, 0.0001)],
  },
  projects: ['wm-align', 'cortex-self', 'alap'],
};

export const FIXTURE_TOOLS: StatsTools = {
  window: FIXTURE_USAGE.window,
  kind: 'tool',
  ready: true,
  total: 12_996,
  distinct: 29,
  series: [
    { key: 'Bash', folded: 0, colorSlot: 0, total: 11_405, values: [800, 2_100, 3_000, 2_000, 1_000, 1_100, 1_405] },
    { key: 'Read', folded: 0, colorSlot: 1, total: 616, values: [80, 90, 100, 90, 70, 86, 100] },
  ],
  ranking: [{ name: 'Bash', count: 11_405, colorSlot: 0 }, { name: 'Read', count: 616, colorSlot: 1 }, { name: 'TaskStop', count: 32, colorSlot: null }],
};

const H = 3_600_000;
export const FIXTURE_QUOTA: StatsQuotaWindows = {
  accounts: [
    { provider: 'anthropic', route: null, label: 'Claude · subscription' },
    { provider: 'anthropic', route: 'school', label: 'Claude · school' },
  ],
  account: { provider: 'anthropic', route: null, label: 'Claude · subscription' },
  periods: {
    fiveHour: Array.from({ length: 8 }, (_, i) => ({
      windowType: 'five_hour', start: FIXTURE_NOW - (i * 6 + 2) * H, end: FIXTURE_NOW - (i * 6 - 3) * H,
      peakUtilization: [0.353, 0.08, 0.92, 0.5, 0.3, 0.2, 0.1, 0.4][i], lastObservedAt: FIXTURE_NOW,
      breakdown: i === 1 ? [] : [{ key: 'chat' as const, colorSlot: 0, share: 0.9 }, { key: 'background' as const, colorSlot: 1, share: 0.1 }],
    })),
    weekly: [{
      windowType: 'seven_day', start: FIXTURE_NOW - 5 * 24 * H, end: FIXTURE_NOW + 2 * 24 * H, peakUtilization: 0.281,
      lastObservedAt: FIXTURE_NOW, breakdown: [{ key: 'chat', colorSlot: 0, share: 1 }],
    }],
  },
  recordingSince: FIXTURE_NOW - 30 * 24 * H,
};

export function ready<T>(data: T): StatsQuery<T> {
  return { data, isLoading: false, error: null, refreshing: false };
}

export function loading<T>(): StatsQuery<T> {
  return { data: undefined, isLoading: true, error: null, refreshing: false };
}

export function failed<T>(message: string): StatsQuery<T> {
  return { data: undefined, isLoading: false, error: { message }, refreshing: false };
}

type Handlers = Pick<StatsController, 'setRange' | 'setProjectId' | 'setPage' | 'setToolKind' | 'setAccount'>;

export function fixtureController(over: Partial<StatsController> = {}, handlers?: Partial<Handlers>): StatsController {
  const noop = () => {};
  return {
    range: '7d', projectId: null, page: 0, toolKind: 'tool', now: FIXTURE_NOW,
    setRange: noop, setProjectId: noop, setPage: noop, setToolKind: noop, setAccount: noop,
    usage: ready(FIXTURE_USAGE), tools: ready(FIXTURE_TOOLS), quota: ready(FIXTURE_QUOTA),
    ...handlers, ...over,
  };
}
