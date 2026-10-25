/**
 * Canned SQL reports over the telemetry tables, shared by the dashboard and scripts/query.ts.
 * Every report is scoped to a day window and to the release channel unless dev is included.
 * Aggregation stays in SQLite (json_each over the stored rollups) so the Worker only renders.
 */
import { TELEMETRY_BUCKETS, type TelemetryBucketKey } from '../../../agent-server/src/domain/telemetry/schema.js';

const DAY_MS = 86_400_000;
export const MIN_REPORT_DAYS = 7;
export const MAX_REPORT_DAYS = 365;

export interface ReportFilter {
  days: number;
  includeDev: boolean;
  today: string;
  /** First day of the trailing 7-day window ending today. */
  weekStart: string;
  /** First day of the report window. */
  since: string;
  sinceAt: string;
  channels: readonly [string, string];
}

export interface Query {
  sql: string;
  params: Array<string | number>;
}

export function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.min(MAX_REPORT_DAYS, Math.max(MIN_REPORT_DAYS, Math.round(days)));
}

export function reportFilter(now: Date, days: number, includeDev: boolean): ReportFilter {
  const window = clampDays(days);
  const dayAgo = (offset: number) => new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
  const since = dayAgo(window - 1);
  return {
    days: window,
    includeDev,
    today: dayAgo(0),
    weekStart: dayAgo(6),
    since,
    sinceAt: `${since}T00:00:00.000Z`,
    channels: ['release', includeDev ? 'dev' : 'release'],
  };
}

const IN_CHANNELS = 'channel IN (?, ?)';
const ROLLUPS_IN_WINDOW = `d.day >= ? AND d.${IN_CHANNELS}`;

function rollupQuery(sql: string, f: ReportFilter): Query {
  return { sql, params: [f.since, ...f.channels] };
}

export const ACTIVITY_DIMENSIONS = {
  version: 'version',
  os: 'os',
  installForm: 'install_form',
  country: 'country',
} as const;
export type ActivityDimension = keyof typeof ACTIVITY_DIMENSIONS;

function activeBy(dimension: ActivityDimension) {
  const column = ACTIVITY_DIMENSIONS[dimension];
  return (f: ReportFilter): Query => ({
    sql: `SELECT COALESCE(${column}, 'unknown') AS key,
  COUNT(DISTINCT CASE WHEN day = ? THEN install_id END) AS today,
  COUNT(DISTINCT install_id) AS week
FROM install_days WHERE day >= ? AND ${IN_CHANNELS}
GROUP BY key ORDER BY week DESC, key LIMIT 12`,
    params: [f.today, f.weekStart, ...f.channels],
  });
}

/** Histograms the dashboard turns into percentiles; `perTurn` paths sit inside `turns[]`. */
export const HISTOGRAM_METRICS: ReadonlyArray<{
  metric: string;
  bucket: TelemetryBucketKey;
  path: string;
  perTurn: boolean;
}> = [
  { metric: 'ttftMs', bucket: 'ttftMs', path: '$.ttftMs', perTurn: true },
  { metric: 'turnDurationS', bucket: 'turnDurationS', path: '$.durationS', perTurn: true },
  { metric: 'contextPctAtEnd', bucket: 'contextPct', path: '$.contextPctAtEnd', perTurn: true },
  { metric: 'turnsPerSession', bucket: 'turnsPerSession', path: '$.agent.turnsPerSession', perTurn: false },
  { metric: 'webTtfbMs', bucket: 'webLoadMs', path: '$.perf.web.ttfbMs', perTurn: false },
  { metric: 'webFirstRenderMs', bucket: 'webLoadMs', path: '$.perf.web.firstRenderMs', perTurn: false },
  { metric: 'webInteractiveMs', bucket: 'webLoadMs', path: '$.perf.web.interactiveMs', perTurn: false },
];

function histogramSelect(entry: (typeof HISTOGRAM_METRICS)[number]): string {
  const source = entry.perTurn
    ? `daily d, json_each(d.payload, '$.turns') t, json_each(t.value, '${entry.path}') h`
    : `daily d, json_each(d.payload, '${entry.path}') h`;
  return `SELECT '${entry.metric}' AS metric, h.key AS slot, SUM(h.value) AS count
FROM ${source} WHERE ${ROLLUPS_IN_WINDOW} GROUP BY h.key`;
}

function histograms(f: ReportFilter): Query {
  return {
    sql: HISTOGRAM_METRICS.map(histogramSelect).join('\nUNION ALL\n'),
    params: HISTOGRAM_METRICS.flatMap(() => [f.since, ...f.channels]),
  };
}

function jsonCounters(path: string, label: string) {
  return (f: ReportFilter): Query => rollupQuery(`SELECT c.key AS ${label}, SUM(c.value) AS count,
  COUNT(DISTINCT CASE WHEN c.value > 0 THEN d.install_id END) AS installs
FROM daily d, json_each(d.payload, '${path}') c WHERE ${ROLLUPS_IN_WINDOW}
GROUP BY c.key ORDER BY installs DESC, count DESC LIMIT 30`, f);
}

export interface Report {
  description: string;
  build(filter: ReportFilter): Query;
}

export const REPORTS = {
  activeByDay: {
    description: 'Installs that sent anything, per UTC day',
    build: f => ({
      sql: `SELECT day, COUNT(*) AS installs FROM install_days
WHERE day >= ? AND ${IN_CHANNELS} GROUP BY day ORDER BY day`,
      params: [f.since, ...f.channels],
    }),
  },
  activeSummary: {
    description: 'Active, new and crashing installs (today, last 7 days, window)',
    build: f => ({
      sql: `SELECT
  COUNT(DISTINCT CASE WHEN day = ? THEN install_id END) AS today,
  COUNT(DISTINCT CASE WHEN day >= ? THEN install_id END) AS week,
  COUNT(DISTINCT install_id) AS period,
  (SELECT COUNT(*) FROM installs WHERE first_seen >= ? AND ${IN_CHANNELS}) AS new_installs,
  (SELECT COUNT(DISTINCT install_id) FROM crashes WHERE last_seen >= ? AND ${IN_CHANNELS})
    AS crashing_installs
FROM install_days WHERE day >= ? AND ${IN_CHANNELS}`,
      params: [
        f.today, f.weekStart, f.sinceAt, ...f.channels, f.sinceAt, ...f.channels, f.since, ...f.channels,
      ],
    }),
  },
  activeByVersion: { description: 'Active installs by version (today / 7 days)', build: activeBy('version') },
  activeByOs: { description: 'Active installs by OS (today / 7 days)', build: activeBy('os') },
  activeByInstallForm: { description: 'Active installs by install form (today / 7 days)', build: activeBy('installForm') },
  activeByCountry: { description: 'Active installs by country (today / 7 days)', build: activeBy('country') },
  funnel: {
    description: 'Onboarding steps reached by installs that started setup or init in the window',
    build: f => ({
      sql: `WITH cohort AS (
  SELECT DISTINCT install_id FROM funnel
  WHERE step IN ('setup_started', 'server_init_completed') AND at >= ? AND ${IN_CHANNELS}
)
SELECT step, COALESCE(detail, '') AS detail, COUNT(*) AS installs
FROM funnel JOIN cohort USING (install_id) GROUP BY step, detail`,
      params: [f.sinceAt, ...f.channels],
    }),
  },
  crashGroups: {
    description: 'Top crash groups per version with the latest redacted sample',
    build: f => ({
      sql: `WITH ranked AS (
  SELECT component, group_key, version, kind, error_name, message, stack, route, client,
    exit_code, exit_signal,
    SUM(count) OVER grp AS total, COUNT(*) OVER grp AS installs,
    MIN(first_seen) OVER grp AS group_first_seen, MAX(last_seen) OVER grp AS group_last_seen,
    ROW_NUMBER() OVER (PARTITION BY component, group_key, version ORDER BY last_seen DESC) AS rn
  FROM crashes WHERE last_seen >= ? AND ${IN_CHANNELS}
  WINDOW grp AS (PARTITION BY component, group_key, version)
)
SELECT component, group_key, version, kind, error_name, message, stack, route, client, exit_code,
  exit_signal, total AS count, installs, group_first_seen AS first_seen, group_last_seen AS last_seen
FROM ranked WHERE rn = 1 ORDER BY count DESC, last_seen DESC LIMIT 15`,
      params: [f.sinceAt, ...f.channels],
    }),
  },
  errorGroups: {
    description: 'Top non-fatal error groups (log.error samples) per version',
    build: f => ({
      // A lone MAX() makes SQLite take the bare `message` from the latest row of each group.
      sql: `SELECT module, group_key, version, SUM(count) AS count,
  COUNT(DISTINCT install_id) AS installs, MAX(day) AS last_day, message
FROM errors WHERE day >= ? AND ${IN_CHANNELS}
GROUP BY module, group_key, version ORDER BY count DESC LIMIT 15`,
      params: [f.since, ...f.channels],
    }),
  },
  errorModules: {
    description: 'log.error calls per logger module',
    build: f => rollupQuery(`SELECT m.key AS module, SUM(m.value) AS count,
  COUNT(DISTINCT d.install_id) AS installs
FROM daily d, json_each(d.payload, '$.errors.byModule') m WHERE ${ROLLUPS_IN_WINDOW}
GROUP BY m.key ORDER BY count DESC LIMIT 15`, f),
  },
  turnHealth: {
    description: 'Turn outcomes by backend, provider and model',
    build: f => rollupQuery(`SELECT json_extract(t.value, '$.backend') AS backend,
  json_extract(t.value, '$.provider') AS provider, json_extract(t.value, '$.model') AS model,
  SUM(json_extract(t.value, '$.outcomes.completed')) AS completed,
  SUM(json_extract(t.value, '$.outcomes.failed')) AS failed,
  SUM(json_extract(t.value, '$.outcomes.cancelled')) AS cancelled,
  SUM(json_extract(t.value, '$.outcomes.rateLimited')) AS rate_limited,
  SUM(json_extract(t.value, '$.retries')) AS retries,
  SUM(json_extract(t.value, '$.fallbacks')) AS fallbacks,
  COUNT(DISTINCT d.install_id) AS installs
FROM daily d, json_each(d.payload, '$.turns') t WHERE ${ROLLUPS_IN_WINDOW}
GROUP BY backend, provider, model
ORDER BY completed + failed + cancelled + rate_limited DESC LIMIT 20`, f),
  },
  turnTotals: {
    description: 'Turn outcomes summed over every backend and model',
    build: f => rollupQuery(`SELECT
  SUM(json_extract(t.value, '$.outcomes.completed')) AS completed,
  SUM(json_extract(t.value, '$.outcomes.failed')) AS failed,
  SUM(json_extract(t.value, '$.outcomes.cancelled')) AS cancelled,
  SUM(json_extract(t.value, '$.outcomes.rateLimited')) AS rate_limited
FROM daily d, json_each(d.payload, '$.turns') t WHERE ${ROLLUPS_IN_WINDOW}`, f),
  },
  turnFailures: {
    description: 'Turn failure classes by backend',
    build: f => rollupQuery(`SELECT json_extract(t.value, '$.backend') AS backend, c.key AS class,
  SUM(c.value) AS count
FROM daily d, json_each(d.payload, '$.turns') t, json_each(t.value, '$.failures') c
WHERE ${ROLLUPS_IN_WINDOW} GROUP BY backend, class ORDER BY count DESC`, f),
  },
  rollupInstalls: {
    description: 'Installs that sent daily rollups in the window',
    build: f => rollupQuery(`SELECT COUNT(DISTINCT d.install_id) AS installs, COUNT(*) AS rollups
FROM daily d WHERE ${ROLLUPS_IN_WINDOW}`, f),
  },
  features: { description: 'Feature counters: total and installs using each', build: jsonCounters('$.features', 'feature') },
  messageChannels: { description: 'User messages by entry channel', build: jsonCounters('$.messagesByChannel', 'channel') },
  uiOps: { description: 'UI mutation ops', build: jsonCounters('$.uiOps', 'op') },
  tools: {
    description: 'Tool calls and errors',
    build: f => rollupQuery(`SELECT json_extract(t.value, '$.name') AS tool,
  SUM(json_extract(t.value, '$.calls')) AS calls, SUM(json_extract(t.value, '$.errors')) AS errors,
  COUNT(DISTINCT d.install_id) AS installs
FROM daily d, json_each(d.payload, '$.tools') t WHERE ${ROLLUPS_IN_WINDOW}
GROUP BY tool ORDER BY calls DESC LIMIT 15`, f),
  },
  histograms: { description: 'Summed histogram slots per metric', build: histograms },
  startupPhases: {
    description: 'Server startup phase durations',
    build: f => rollupQuery(`SELECT p.key AS phase, COUNT(*) AS boots, AVG(p.value) AS avg_ms,
  MAX(p.value) AS max_ms
FROM daily d, json_each(d.payload, '$.perf.startups') s, json_each(s.value) p
WHERE ${ROLLUPS_IN_WINDOW} GROUP BY phase ORDER BY avg_ms DESC LIMIT 15`, f),
  },
  perfCounters: {
    description: 'Event-loop lag, web loads and reconnect counters',
    build: f => rollupQuery(`SELECT COUNT(*) AS rollups,
  SUM(json_extract(d.payload, '$.perf.web.loads')) AS web_loads,
  SUM(json_extract(d.payload, '$.perf.sseReconnects')) AS sse_reconnects,
  SUM(json_extract(d.payload, '$.perf.remoteClientDisconnects')) AS client_disconnects,
  AVG(CASE WHEN json_extract(d.payload, '$.perf.eventLoop.windows') > 0
    THEN json_extract(d.payload, '$.perf.eventLoop.p99MedianMs') END) AS loop_p99_median_ms,
  MAX(json_extract(d.payload, '$.perf.eventLoop.p99MaxMs')) AS loop_p99_max_ms
FROM daily d WHERE ${ROLLUPS_IN_WINDOW}`, f),
  },
  upgrades: {
    description: 'Upgrade attempts by target version, method and stage',
    build: f => ({
      sql: `SELECT to_version, method, stage, COALESCE(failure_class, '') AS failure_class,
  COUNT(*) AS events, COUNT(DISTINCT install_id) AS installs
FROM upgrades WHERE at >= ? AND ${IN_CHANNELS}
GROUP BY to_version, method, stage, failure_class ORDER BY to_version DESC, events DESC LIMIT 20`,
      params: [f.sinceAt, ...f.channels],
    }),
  },
  migrationFailures: {
    description: 'Failed store migrations with the latest redacted message',
    build: f => ({
      sql: `SELECT migration, error_class, version, COUNT(*) AS events,
  COUNT(DISTINCT install_id) AS installs, MAX(at) AS last_at, message
FROM migration_failures WHERE at >= ? AND ${IN_CHANNELS}
GROUP BY migration, error_class, version ORDER BY events DESC LIMIT 15`,
      params: [f.sinceAt, ...f.channels],
    }),
  },
} satisfies Record<string, Report>;

export type ReportName = keyof typeof REPORTS;
export const REPORT_NAMES = Object.keys(REPORTS) as ReportName[];

/** Every table keyed by install_id, for per-install lookups and deletion requests. */
export const INSTALL_TABLES = [
  'installs', 'install_days', 'crashes', 'errors', 'daily', 'heartbeats', 'funnel', 'upgrades',
  'migration_failures',
] as const;

export function bucketBounds(bucket: TelemetryBucketKey): readonly number[] {
  return TELEMETRY_BUCKETS[bucket];
}
