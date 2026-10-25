import {
  DESKTOP_SETUP_STEPS,
  SERVER_FUNNEL_STEPS,
  TELEMETRY_BUCKETS,
  type TelemetryBucketKey,
} from '../../../../agent-server/src/domain/telemetry/schema.js';
import type { Row } from '../env.js';
import { HISTOGRAM_METRICS, type ReportFilter, type ReportName } from '../reports.js';
import {
  bar, details, esc, fmtInt, fmtMs, grid, lineChart, num, panel, pct, section, table, tiles,
  type Column,
} from './html.js';
import { histogramCounts, percentileSlot, slotLabel } from './stats.js';
import { DASHBOARD_STYLE } from './style.js';

export type DashboardData = Record<ReportName, Row[]>;

const DAY_MS = 86_400_000;
const WINDOW_CHOICES = [7, 30, 90] as const;

function maxOf(rows: Row[], key: string): number {
  return rows.reduce((max, row) => Math.max(max, num(row[key])), 0);
}

function turnCount(row: Row): number {
  return num(row.completed) + num(row.failed) + num(row.cancelled) + num(row.rate_limited);
}

function shortTime(value: unknown): string {
  return esc(String(value ?? '').slice(0, 16).replace('T', ' '));
}

function filterLink(f: ReportFilter, days: number, includeDev: boolean, label: string): string {
  const active = f.days === days && f.includeDev === includeDev;
  const href = `?days=${days}${includeDev ? '&amp;dev=1' : ''}`;
  return `<a class="${active ? 'on' : ''}" href="${href}">${esc(label)}</a>`;
}

function header(f: ReportFilter, now: Date): string {
  const windows = WINDOW_CHOICES.map(days => filterLink(f, days, f.includeDev, `${days} days`));
  const channels = [
    filterLink(f, f.days, false, 'release'),
    filterLink(f, f.days, true, 'release + dev'),
  ];
  return `<header><h1>Cortex telemetry</h1><nav class="filters">${windows.join('')}</nav>`
    + `<nav class="filters">${channels.join('')}</nav>`
    + `<span class="stamp">${esc(f.since)} → ${esc(f.today)} · rendered ${shortTime(now.toISOString())} UTC</span></header>`;
}

function summarySection(data: DashboardData): string {
  const summary = data.activeSummary[0] ?? {};
  const turns = data.turnTotals[0] ?? {};
  const period = num(summary.period);
  const crashing = num(summary.crashing_installs);
  const failed = num(turns.failed);
  return section('Summary', tiles([
    { label: 'Active today', value: fmtInt(summary.today) },
    { label: 'Active, last 7 days', value: fmtInt(summary.week) },
    { label: 'Active in window', value: fmtInt(period) },
    { label: 'New installs', value: fmtInt(summary.new_installs), note: 'first seen in window' },
    { label: 'Crash-free installs', value: pct(period - crashing, period), note: `${fmtInt(crashing)} with a crash` },
    { label: 'Turn failure rate', value: pct(failed, turnCount(turns)), note: `${fmtInt(turnCount(turns))} turns` },
  ]));
}

function windowDays(f: ReportFilter): string[] {
  const start = Date.parse(`${f.since}T00:00:00Z`);
  return Array.from({ length: f.days }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}

function breakdownTable(rows: Row[]): string {
  const max = maxOf(rows, 'week');
  return table([
    { label: '', cell: row => esc(row.key) },
    { label: 'Today', numeric: true, cell: row => fmtInt(row.today) },
    { label: '7 days', cell: row => bar(num(row.week), max, fmtInt(row.week)) },
  ], rows);
}

function activitySection(data: DashboardData, f: ReportFilter): string {
  const perDay = new Map(data.activeByDay.map(row => [String(row.day), num(row.installs)]));
  const points = windowDays(f).map(day => ({ label: day.slice(5), value: perDay.get(day) ?? 0 }));
  const dayTable = table([
    { label: 'Day', cell: (p: { label: string; value: number }) => esc(p.label) },
    { label: 'Installs', numeric: true, cell: p => fmtInt(p.value) },
  ], [...points].reverse());
  const breakdowns = grid(
    panel('Version', breakdownTable(data.activeByVersion)),
    panel('OS', breakdownTable(data.activeByOs)),
    panel('Install form', breakdownTable(data.activeByInstallForm)),
    panel('Country', breakdownTable(data.activeByCountry)),
  );
  return section('Active installs', lineChart(points, 'active installs') + details('Table', dayTable) + breakdowns,
    'Installs that sent anything on each UTC day. Breakdowns: today and the last 7 days.');
}

interface StepCount {
  installs: number;
  details: Map<string, number>;
}

function funnelCounts(rows: Row[]): Map<string, StepCount> {
  const counts = new Map<string, StepCount>();
  for (const row of rows) {
    const step = counts.get(String(row.step)) ?? { installs: 0, details: new Map<string, number>() };
    step.installs += num(row.installs);
    if (row.detail) step.details.set(String(row.detail), num(row.installs));
    counts.set(String(row.step), step);
  }
  return counts;
}

function detailText(detailCounts: Map<string, number>): string {
  return [...detailCounts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(' · ');
}

function funnelTable(steps: readonly string[], counts: Map<string, StepCount>, base: string): string {
  const baseCount = counts.get(base)?.installs ?? 0;
  const rows = steps.map(step => ({ step, ...(counts.get(step) ?? { installs: 0, details: new Map() }) }));
  return table([
    { label: 'Step', cell: row => esc(row.step) },
    {
      label: 'Installs',
      cell: row => bar(row.installs, baseCount, `${fmtInt(row.installs)} · ${pct(row.installs, baseCount)}`,
        row.step.endsWith('_failed') ? 'critical' : 'series'),
    },
    { label: 'Detail', cell: row => esc(detailText(row.details)) },
  ], baseCount > 0 ? rows : []);
}

function funnelSection(data: DashboardData): string {
  const counts = funnelCounts(data.funnel);
  return section('Onboarding funnel', grid(
    panel('Desktop setup (from setup_started)', funnelTable(DESKTOP_SETUP_STEPS, counts, 'setup_started')),
    panel('Server (from server_init_completed)', funnelTable(SERVER_FUNNEL_STEPS, counts, 'server_init_completed')),
  ), 'Installs whose setup or init started in the window, and every step they reached since.');
}

function exitText(row: Row): string {
  if (row.exit_code === null && row.exit_signal === null) return '';
  return `exit ${row.exit_code ?? ''}${row.exit_signal ? ` ${row.exit_signal}` : ''}`.trim();
}

function crashSample(row: Row): string {
  const message = String(row.message ?? '');
  const summary = `${row.error_name}: ${message.length > 90 ? `${message.slice(0, 90)}…` : message}`;
  const meta = [row.kind, row.route, row.client, exitText(row)].filter(Boolean).join(' · ');
  return details(summary, `<p class="meta">${esc(row.group_key)}<br>${esc(meta)}</p>`
    + `<pre>${esc(message)}\n${esc(row.stack)}</pre>`);
}

function crashSection(data: DashboardData): string {
  const rows = data.crashGroups;
  const max = maxOf(rows, 'count');
  return section('Top crash groups', table([
    { label: 'Component', cell: row => esc(row.component) },
    { label: 'Error (latest sample)', cell: crashSample },
    { label: 'Version', cell: row => esc(row.version) },
    { label: 'Events', cell: row => bar(num(row.count), max, fmtInt(row.count), 'critical') },
    { label: 'Installs', numeric: true, cell: row => fmtInt(row.installs) },
    { label: 'First seen', cell: row => shortTime(row.first_seen) },
    { label: 'Last seen', cell: row => shortTime(row.last_seen) },
  ], rows), 'Grouped by component, group key and version; events include rate-limited repeats.');
}

function errorSection(data: DashboardData): string {
  const groups = data.errorGroups;
  const groupMax = maxOf(groups, 'count');
  const groupTable = table([
    { label: 'Module', cell: row => esc(row.module) },
    { label: 'Latest sample', cell: row => details(String(row.group_key), `<pre>${esc(row.message)}</pre>`) },
    { label: 'Version', cell: row => esc(row.version) },
    { label: 'Count', cell: row => bar(num(row.count), groupMax, fmtInt(row.count), 'critical') },
    { label: 'Installs', numeric: true, cell: row => fmtInt(row.installs) },
    { label: 'Last day', cell: row => esc(row.last_day) },
  ], groups);
  const moduleMax = maxOf(data.errorModules, 'count');
  const moduleTable = table([
    { label: 'Module', cell: row => esc(row.module) },
    { label: 'log.error calls', cell: row => bar(num(row.count), moduleMax, fmtInt(row.count), 'critical') },
    { label: 'Installs', numeric: true, cell: row => fmtInt(row.installs) },
  ], data.errorModules);
  return section('Error digest', grid(panel('Sampled groups', groupTable), panel('By logger module', moduleTable)),
    'Non-fatal log.error calls from the daily rollups.');
}

function turnColumns(): Column<Row>[] {
  return [
    { label: 'Backend', cell: row => esc(row.backend) },
    { label: 'Provider', cell: row => esc(row.provider) },
    { label: 'Model', cell: row => esc(row.model) },
    { label: 'Turns', numeric: true, cell: row => fmtInt(turnCount(row)) },
    { label: 'Failed', cell: row => bar(num(row.failed), turnCount(row), pct(num(row.failed), turnCount(row)), 'critical') },
    { label: 'Rate-limited', numeric: true, cell: row => fmtInt(row.rate_limited) },
    { label: 'Cancelled', numeric: true, cell: row => fmtInt(row.cancelled) },
    { label: 'Retries', numeric: true, cell: row => fmtInt(row.retries) },
    { label: 'Fallbacks', numeric: true, cell: row => fmtInt(row.fallbacks) },
    { label: 'Installs', numeric: true, cell: row => fmtInt(row.installs) },
  ];
}

function turnSection(data: DashboardData): string {
  const failureMax = maxOf(data.turnFailures, 'count');
  const failures = table([
    { label: 'Backend', cell: row => esc(row.backend) },
    { label: 'Class', cell: row => esc(row.class) },
    { label: 'Failures', cell: row => bar(num(row.count), failureMax, fmtInt(row.count), 'critical') },
  ], data.turnFailures);
  return section('Turn health', table(turnColumns(), data.turnHealth) + panel('Failure classes', failures),
    'Failed share is failed turns over all turns (completed, failed, cancelled, rate-limited).');
}

function usageTable(rows: Row[], label: string, key: string, denominator: number): string {
  return table([
    { label, cell: row => esc(row[key]) },
    { label: 'Installs using', cell: row => bar(num(row.installs), denominator, `${fmtInt(row.installs)} · ${pct(num(row.installs), denominator)}`) },
    { label: 'Total', numeric: true, cell: row => fmtInt(row.count) },
  ], rows);
}

function toolTable(rows: Row[]): string {
  const max = maxOf(rows, 'calls');
  return table([
    { label: 'Tool', cell: row => esc(row.tool) },
    { label: 'Calls', cell: row => bar(num(row.calls), max, fmtInt(row.calls)) },
    { label: 'Error rate', numeric: true, cell: row => pct(num(row.errors), num(row.calls)) },
    { label: 'Installs', numeric: true, cell: row => fmtInt(row.installs) },
  ], rows);
}

function usageSection(data: DashboardData): string {
  const reporting = num(data.rollupInstalls[0]?.installs);
  return section('Feature usage', grid(
    panel('Features', usageTable(data.features, 'Feature', 'feature', reporting)),
    panel('Message entry points', usageTable(data.messageChannels, 'Channel', 'channel', reporting)),
    panel('Top tools', toolTable(data.tools)),
  ), `Share of the ${fmtInt(reporting)} installs that sent daily rollups in the window.`);
}

const seconds = (value: number) => (value >= 60 ? `${value / 60} min` : `${value} s`);
const METRIC_FORMATS: Record<string, { label: string; format: (v: number) => string }> = {
  ttftMs: { label: 'Time to first token', format: fmtMs },
  turnDurationS: { label: 'Turn duration', format: seconds },
  contextPctAtEnd: { label: 'Context used at turn end', format: value => `${value}%` },
  turnsPerSession: { label: 'Turns per session', format: String },
  webTtfbMs: { label: 'Web TTFB', format: fmtMs },
  webFirstRenderMs: { label: 'Web first render', format: fmtMs },
  webInteractiveMs: { label: 'Web interactive', format: fmtMs },
};

function percentileRows(rows: Row[]): Row[] {
  return HISTOGRAM_METRICS.map(({ metric, bucket }) => {
    const bounds: readonly number[] = TELEMETRY_BUCKETS[bucket as TelemetryBucketKey];
    const counts = histogramCounts(rows, metric, bounds.length + 1);
    const { label, format } = METRIC_FORMATS[metric];
    const at = (q: number) => slotLabel(percentileSlot(counts, q), bounds, format);
    return { label, samples: counts.reduce((a, b) => a + b, 0), p50: at(0.5), p90: at(0.9), p99: at(0.99) };
  });
}

function perfTiles(data: DashboardData): string {
  const perf = data.perfCounters[0] ?? {};
  return tiles([
    { label: 'Event-loop p99 (median)', value: fmtMs(perf.loop_p99_median_ms), note: 'mean over install-days' },
    { label: 'Event-loop p99 (worst)', value: fmtMs(perf.loop_p99_max_ms) },
    { label: 'Web loads', value: fmtInt(perf.web_loads) },
    { label: 'SSE reconnects', value: fmtInt(perf.sse_reconnects) },
    { label: 'Remote client drops', value: fmtInt(perf.client_disconnects) },
  ]);
}

function perfSection(data: DashboardData): string {
  const percentiles = table([
    { label: 'Metric', cell: row => esc(row.label) },
    { label: 'Samples', numeric: true, cell: row => fmtInt(row.samples) },
    { label: 'p50', numeric: true, cell: row => esc(row.p50) },
    { label: 'p90', numeric: true, cell: row => esc(row.p90) },
    { label: 'p99', numeric: true, cell: row => esc(row.p99) },
  ], percentileRows(data.histograms));
  const startup = table([
    { label: 'Startup phase', cell: row => esc(row.phase) },
    { label: 'Boots', numeric: true, cell: row => fmtInt(row.boots) },
    { label: 'Mean', numeric: true, cell: row => fmtMs(row.avg_ms) },
    { label: 'Max', numeric: true, cell: row => fmtMs(row.max_ms) },
  ], data.startupPhases);
  return section('Performance', perfTiles(data) + grid(panel('Percentiles', percentiles), panel('Server startup', startup)),
    'Percentiles resolve to histogram bucket bounds.');
}

function upgradeSection(data: DashboardData): string {
  const upgrades = table([
    { label: 'To', cell: row => esc(row.to_version) },
    { label: 'Method', cell: row => esc(row.method) },
    { label: 'Stage', cell: row => esc(row.stage) },
    { label: 'Failure', cell: row => esc(row.failure_class) },
    { label: 'Events', numeric: true, cell: row => fmtInt(row.events) },
    { label: 'Installs', numeric: true, cell: row => fmtInt(row.installs) },
  ], data.upgrades);
  const migrations = table([
    { label: 'Migration', cell: row => details(String(row.migration), `<pre>${esc(row.message)}</pre>`) },
    { label: 'Class', cell: row => esc(row.error_class) },
    { label: 'Version', cell: row => esc(row.version) },
    { label: 'Installs', numeric: true, cell: row => fmtInt(row.installs) },
    { label: 'Last', cell: row => shortTime(row.last_at) },
  ], data.migrationFailures);
  return section('Upgrades and migrations', grid(panel('Upgrades', upgrades), panel('Failed migrations', migrations)));
}

export function renderDashboard(data: DashboardData, f: ReportFilter, now: Date): string {
  const body = [
    header(f, now), summarySection(data), activitySection(data, f), funnelSection(data),
    crashSection(data), errorSection(data), turnSection(data), usageSection(data), perfSection(data),
    upgradeSection(data),
  ].join('\n');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
    + `<title>Cortex telemetry</title><style>${DASHBOARD_STYLE}</style></head>`
    + `<body><main class="viz-root">${body}</main></body></html>`;
}
