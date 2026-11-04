import type {
  StatsBucket,
  StatsDimension,
  StatsQuotaAccount,
  StatsQuotaPeriod,
  StatsQuotaSpan,
  StatsRange,
  StatsSeries,
  StatsSessionRow,
  StatsShare,
  StatsToolKind,
  StatsToolRank,
  StatsTotals,
  StatsUsage,
  StatsWindow,
  TokenCounts,
} from '@cortex-agent/ui-contract';
import { fmt, type Lang, type Vocab } from '@/i18n';
import { relTime } from '@/i18n/time-format';
import { utilizationSeverity, type UsageSeverity } from '@/features/usage/usage-vm';

// Pure view-model of the Stats page: number and date formatting, chart scales and geometry, the
// series each chart stacks, and the rows of the session and quota tables.

export const STATS_RANGES: readonly StatsRange[] = ['24h', '7d', '30d', '90d'];
export const DEFAULT_STATS_RANGE: StatsRange = '30d';
/** Rows a table shows before "Show more", and how many each press adds. */
export const STATS_PAGE_ROWS = 6;

export type TokenKind = keyof TokenCounts;
export type StatsGroup = 'type' | StatsDimension;
export type RunsBy = 'model' | 'source';

/** Bottom to top in a stack, and the legend order. */
export const TOKEN_KINDS: readonly TokenKind[] = ['cacheRead', 'cacheWrite', 'input', 'output'];
/** Token kinds keep fixed palette slots, so a kind is the same colour in every chart. */
export const KIND_SLOTS: Readonly<Record<TokenKind, number>> = { cacheRead: 0, cacheWrite: 1, input: 2, output: 3 };

const KIND_LABEL: Readonly<Record<TokenKind, keyof Vocab>> = {
  cacheRead: 'statsKindCacheRead', cacheWrite: 'statsKindCacheWrite', input: 'statsKindInput', output: 'statsKindOutput',
};
const SOURCE_LABEL: Readonly<Record<string, keyof Vocab>> = {
  chat: 'statsSourceChat', background: 'statsSourceBackground', subagent: 'statsSourceSubagent',
  scheduled: 'statsSourceScheduled', cacheRefresh: 'statsSourceCacheRefresh', compact: 'statsSourceCompact',
  other: 'statsSourceOther',
};
export const RANGE_LABEL: Readonly<Record<StatsRange, keyof Vocab>> = {
  '24h': 'statsRange24h', '7d': 'statsRange7d', '30d': 'statsRange30d', '90d': 'statsRange90d',
};
export const GROUP_LABEL: Readonly<Record<StatsGroup, keyof Vocab>> = {
  type: 'statsByType', model: 'statsByModel', project: 'statsByProject', source: 'statsBySource',
};
export const TOOL_KIND_LABEL: Readonly<Record<StatsToolKind, keyof Vocab>> = {
  tool: 'statsKindTool', skill: 'statsKindSkill', mcp: 'statsKindMcp',
};

// ── Locale and numbers ─────────────────────────────────────────────────────

export function intlLocale(lang: Lang): string {
  return lang === 'zh' ? 'zh-CN' : 'en-US';
}

const TOKEN_UNITS: readonly [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];

/** Compact token count: 12.9B · 66.4M · 849M · 7.8k · 412. Three significant figures at most. */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  for (let i = 0; i < TOKEN_UNITS.length; i += 1) {
    const [size, unit] = TOKEN_UNITS[i];
    if (abs < size) continue;
    const scaled = n / size;
    const text = scaled.toFixed(Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2);
    // 999.96k rounds to "1000k": promote it to the next unit instead.
    if (Math.abs(Number(text)) >= 1000 && i > 0) return formatTokens(Math.sign(n) * TOKEN_UNITS[i - 1][0]);
    return `${trimZeros(text)}${unit}`;
  }
  return String(Math.round(n));
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** Axis tick: the same units as the values, without trailing zeros. */
export function formatTick(n: number, integer: boolean): string {
  if (n === 0) return '0';
  if (Math.abs(n) >= 1000) return formatTokens(n);
  return integer ? String(Math.round(n)) : trimZeros(n.toFixed(2));
}

export function formatCount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(n));
}

/** Money: whole dollars from $100, cents below. */
export function formatCost(usd: number): string {
  if (usd >= 100) return `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(usd))}`;
  return `$${usd.toFixed(2)}`;
}

/** Share of a whole as a percentage; a non-zero sliver reads `<0.1%`, never `0.0%`. */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '0%';
  const pct = (part / whole) * 100;
  return pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

// ── Deltas ─────────────────────────────────────────────────────────────────

export interface DeltaView {
  direction: 'up' | 'down';
  text: string;
}

/** Relative change against the previous period; null when there is nothing to compare with. */
export function relativeDelta(current: number, previous: number | null | undefined): DeltaView | null {
  if (previous == null || previous <= 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const abs = Math.abs(pct);
  return { direction: pct >= 0 ? 'up' : 'down', text: `${abs.toFixed(abs < 10 ? 1 : 0)}%` };
}

/** Change of a rate in percentage points. */
export function pointDelta(current: number | null, previous: number | null, L: Vocab): DeltaView | null {
  if (current === null || previous === null) return null;
  const pt = (current - previous) * 100;
  return { direction: pt >= 0 ? 'up' : 'down', text: fmt(L.statsPoints, { n: Math.abs(pt).toFixed(1) }) };
}

/** Cache reads over the whole prompt (input + cache write + cache read); null with no prompt. */
export function cacheHitRate(t: TokenCounts): number | null {
  const prompt = t.input + t.cacheWrite + t.cacheRead;
  return prompt > 0 ? t.cacheRead / prompt : null;
}

// ── Colour ─────────────────────────────────────────────────────────────────

export const OTHER_COLOR = 'var(--viz-other)';

/** The palette slot a key was given by the server; past slot 7 and the remainder are grey. */
export function slotColor(slot: number | null | undefined): string {
  return slot != null && Number.isInteger(slot) && slot >= 0 && slot < 8 ? `var(--viz-${slot + 1})` : OTHER_COLOR;
}

export function kindColor(kind: TokenKind): string {
  return slotColor(KIND_SLOTS[kind]);
}

// ── Dates ──────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, options);
}

/** Day buckets are labelled from their midpoint, so a browser a few hours off the server's zone
 *  still names the right day. */
function bucketInstant(start: number, bucket: StatsWindow['bucket']): Date {
  return new Date(bucket === 'day' ? start + 12 * HOUR_MS : start);
}

const HOUR_OPTIONS: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

/** Axis label: `10/5` for a day, `14:00` for an hour. */
export function axisLabel(start: number, bucket: StatsWindow['bucket'], locale: string): string {
  const options: Intl.DateTimeFormatOptions = bucket === 'day' ? { month: 'numeric', day: 'numeric' } : HOUR_OPTIONS;
  return dateFormat(locale, options).format(bucketInstant(start, bucket));
}

/** Tooltip heading: the full date, plus the hour for an hourly bucket. */
export function bucketTitle(start: number, bucket: StatsWindow['bucket'], locale: string): string {
  const options: Intl.DateTimeFormatOptions = bucket === 'day'
    ? { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' }
    : { month: 'short', day: 'numeric', ...HOUR_OPTIONS };
  return dateFormat(locale, options).format(bucketInstant(start, bucket));
}

/** The period a page covers: `Oct 5 – Nov 3, 2026`, or the hours of a 24-hour page. */
export function windowLabel(window: StatsWindow, locale: string): string {
  const options: Intl.DateTimeFormatOptions = window.bucket === 'day'
    ? { year: 'numeric', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', ...HOUR_OPTIONS };
  const lastBucket = window.end - (window.bucket === 'day' ? 24 * HOUR_MS : HOUR_MS);
  const from = bucketInstant(window.start, window.bucket);
  const to = window.bucket === 'day' ? bucketInstant(lastBucket, 'day') : new Date(window.end);
  return dateFormat(locale, options).formatRange(from, to);
}

/** Bucket starts of a period, for a read that carries only its window (tool activity). Days step
 *  by calendar day, so a DST change does not shift the labels. */
export function windowStarts(window: StatsWindow): number[] {
  if (window.bucket === 'hour') {
    const count = Math.max(0, Math.round((window.end - window.start) / HOUR_MS));
    return Array.from({ length: count }, (_, i) => window.start + i * HOUR_MS);
  }
  const count = Math.max(0, Math.round((window.end - window.start) / (24 * HOUR_MS)));
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(window.start);
    day.setDate(day.getDate() + i);
    return day.getTime();
  });
}

/** Show every n-th axis label so at most `maxLabels` fit. */
export function labelStride(count: number, maxLabels: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, maxLabels)));
}

export function formatDay(at: number, locale: string): string {
  return dateFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(at));
}

export function lastActive(at: number, now: number, lang: Lang): string {
  return relTime(at, now, lang);
}

// ── Scales ─────────────────────────────────────────────────────────────────

const NICE_STEPS = [1, 2, 2.5, 5, 10];
const INTEGER_STEPS = [1, 2, 5, 10];

/** Ticks from 0 to a round top at or above `max`, about four intervals. Integer scales (counts)
 *  never get a fractional step. */
export function niceTicks(max: number, integer = false): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const steps = integer ? INTEGER_STEPS : NICE_STEPS;
  let step = (steps.find((m) => m * power >= raw) ?? 10) * power;
  if (integer) step = Math.max(1, Math.round(step));
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; i * step <= top + step * 1e-9; i += 1) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}

export interface ChartFrame {
  width: number;
  height: number;
  /** Plot insets: the y labels sit in `left`, the x labels in `bottom`. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface YScale {
  ticks: number[];
  max: number;
  y: (value: number) => number;
}

export function yScale(maxValue: number, frame: ChartFrame, integer = false): YScale {
  const ticks = niceTicks(maxValue, integer);
  const max = ticks[ticks.length - 1] || 1;
  const plot = frame.height - frame.top - frame.bottom;
  return { ticks, max, y: (value: number) => frame.top + plot * (1 - value / max) };
}

// ── Stacked bars ───────────────────────────────────────────────────────────

/** The surface gap between touching segments, and the largest bar a slot may hold. */
export const SEGMENT_GAP = 2;
export const MAX_BAR_WIDTH = 24;
export const BAR_RADIUS = 4;

export interface BarSegment {
  series: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The top segment of a bar carries the rounded data end. */
  top: boolean;
}

export interface BarColumn {
  index: number;
  /** The bucket's full slot: the hover target. */
  slotX: number;
  slotWidth: number;
  /** The painted bar, centred in the slot. */
  x: number;
  width: number;
  total: number;
  segments: BarSegment[];
}

export interface StackLayout {
  scale: YScale;
  columns: BarColumn[];
}

/** Lays out `values[series][bucket]` as stacked columns; hidden series drop out and the axis
 *  rescales to what is left. */
export function stackLayout(values: number[][], hidden: readonly boolean[], frame: ChartFrame, buckets: number): StackLayout {
  const visible = values.map((_, i) => i).filter((i) => !hidden[i]);
  const totals = Array.from({ length: buckets }, (_, j) => visible.reduce((sum, i) => sum + Math.max(0, values[i][j] ?? 0), 0));
  const scale = yScale(Math.max(0, ...totals), frame);
  const plotWidth = Math.max(0, frame.width - frame.left - frame.right);
  const slotWidth = buckets > 0 ? plotWidth / buckets : 0;
  const gap = Math.max(1, Math.min(5, slotWidth * 0.28));
  const width = Math.max(1, Math.min(MAX_BAR_WIDTH, slotWidth - gap));
  const columns = totals.map((total, j): BarColumn => {
    const slotX = frame.left + j * slotWidth;
    const x = slotX + (slotWidth - width) / 2;
    return { index: j, slotX, slotWidth, x, width, total, segments: stackSegments(values, visible, j, x, width, scale) };
  });
  return { scale, columns };
}

function stackSegments(values: number[][], visible: number[], j: number, x: number, width: number, scale: YScale): BarSegment[] {
  const present = visible.filter((i) => (values[i][j] ?? 0) > 0);
  const segments: BarSegment[] = [];
  let acc = 0;
  present.forEach((series, k) => {
    const from = acc;
    acc += values[series][j];
    // Each boundary between two segments gives up 1px on either side: a 2px surface gap.
    const bottom = scale.y(from) - (k > 0 ? SEGMENT_GAP / 2 : 0);
    const top = scale.y(acc) + (k < present.length - 1 ? SEGMENT_GAP / 2 : 0);
    const height = bottom - top;
    if (height > 0) segments.push({ series, x, y: top, width, height, top: false });
  });
  if (segments.length > 0) segments[segments.length - 1].top = true;
  return segments;
}

/** A rect with its top corners rounded and its baseline square. */
export function roundedTopPath(x: number, y: number, width: number, height: number, radius = BAR_RADIUS): string {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const n = (v: number) => Number(v.toFixed(2));
  if (r === 0) return `M${n(x)},${n(y + height)}V${n(y)}H${n(x + width)}V${n(y + height)}Z`;
  return `M${n(x)},${n(y + height)}V${n(y + r)}Q${n(x)},${n(y)} ${n(x + r)},${n(y)}`
    + `H${n(x + width - r)}Q${n(x + width)},${n(y)} ${n(x + width)},${n(y + r)}V${n(y + height)}Z`;
}

/** The bucket under a pointer at plot-relative `x`; null outside the plot. */
export function barIndexAt(x: number, frame: ChartFrame, buckets: number): number | null {
  const plotWidth = frame.width - frame.left - frame.right;
  if (buckets <= 0 || plotWidth <= 0 || x < frame.left || x >= frame.left + plotWidth) return null;
  return Math.min(buckets - 1, Math.floor(((x - frame.left) / plotWidth) * buckets));
}

// ── Lines ──────────────────────────────────────────────────────────────────

export interface LineLayout {
  scale: YScale;
  xs: number[];
  lines: { series: number; points: string }[];
}

export function lineX(j: number, frame: ChartFrame, buckets: number): number {
  const plotWidth = Math.max(0, frame.width - frame.left - frame.right);
  return frame.left + (buckets <= 1 ? plotWidth / 2 : (plotWidth * j) / (buckets - 1));
}

export function lineLayout(values: number[][], hidden: readonly boolean[], frame: ChartFrame, buckets: number, integer = true): LineLayout {
  const visible = values.map((_, i) => i).filter((i) => !hidden[i]);
  const scale = yScale(Math.max(0, ...visible.flatMap((i) => values[i])), frame, integer);
  const xs = Array.from({ length: buckets }, (_, j) => lineX(j, frame, buckets));
  const lines = visible.map((series) => ({
    series,
    points: xs.map((x, j) => `${x.toFixed(1)},${scale.y(values[series][j] ?? 0).toFixed(1)}`).join(' '),
  }));
  return { scale, xs, lines };
}

/** The nearest point to a pointer at `x`: the crosshair snaps to it. */
export function lineIndexAt(x: number, frame: ChartFrame, buckets: number): number | null {
  const plotWidth = frame.width - frame.left - frame.right;
  if (buckets <= 0 || plotWidth <= 0) return null;
  if (buckets === 1) return 0;
  const j = Math.round(((x - frame.left) / plotWidth) * (buckets - 1));
  return Math.max(0, Math.min(buckets - 1, j));
}

// ── Sparkline ──────────────────────────────────────────────────────────────

/** A sparkline's stroke and its wash; a null value breaks the line. */
export function sparkPaths(values: readonly (number | null)[], width: number, height: number): { line: string; area: string } {
  const max = Math.max(0, ...values.map((v) => v ?? 0)) || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  values.forEach((v, i) => {
    if (v === null) { if (run.length) runs.push(run); run = []; return; }
    run.push([Number((i * step).toFixed(1)), Number((height - 2 - ((height - 4) * v) / max).toFixed(1))]);
  });
  if (run.length) runs.push(run);
  const line = runs.map((r) => r.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('')).join('');
  const area = runs.filter((r) => r.length > 1)
    .map((r) => `M${r[0][0]},${height}${r.map(([x, y]) => `L${x},${y}`).join('')}L${r[r.length - 1][0]},${height}Z`).join('');
  return { line, area };
}

// ── Series ─────────────────────────────────────────────────────────────────

export interface ChartSeries {
  /** Stable across pages and filters: the key, or `__rest` for the folded remainder. */
  id: string;
  name: string;
  color: string;
  total: number;
  values: number[];
}

export const REST_ID = '__rest';

export function sourceLabel(source: string, L: Vocab): string {
  const key = SOURCE_LABEL[source];
  return key ? L[key] : source;
}

/** The display name of a key in a dimension; the remainder is "N others". */
export function keyLabel(dimension: StatsDimension | RunsBy, key: string | null, folded: number, L: Vocab): string {
  if (key === null) return fmt(L.statsOthers, { n: folded });
  return dimension === 'source' ? sourceLabel(key, L) : key;
}

export function kindLabel(kind: TokenKind, L: Vocab): string {
  return L[KIND_LABEL[kind]];
}

export function typeSeries(buckets: readonly StatsBucket[], L: Vocab): ChartSeries[] {
  return TOKEN_KINDS.map((kind) => {
    const values = buckets.map((bucket) => bucket[kind]);
    return { id: kind, name: kindLabel(kind, L), color: kindColor(kind), total: values.reduce((a, b) => a + b, 0), values };
  });
}

export function dimensionSeries(series: readonly StatsSeries[], dimension: StatsDimension | RunsBy, L: Vocab): ChartSeries[] {
  return series.map((s) => ({
    id: s.key ?? REST_ID,
    name: keyLabel(dimension, s.key, s.folded, L),
    color: s.key === null ? OTHER_COLOR : slotColor(s.colorSlot),
    total: s.total,
    values: s.values,
  }));
}

/** The token chart's series for a grouping. */
export function usageSeries(usage: StatsUsage, group: StatsGroup, L: Vocab): ChartSeries[] {
  return group === 'type' ? typeSeries(usage.buckets, L) : dimensionSeries(usage.series[group], group, L);
}

export function toolSeries(series: readonly StatsSeries[]): ChartSeries[] {
  return series.map((s) => ({
    id: s.key ?? REST_ID, name: s.key ?? '', color: slotColor(s.colorSlot), total: s.total, values: s.values,
  }));
}

export function toggleId(hidden: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function hiddenMask(series: readonly ChartSeries[], hidden: ReadonlySet<string>): boolean[] {
  return series.map((s) => hidden.has(s.id));
}

export interface LegendItem {
  id: string;
  name: string;
  color: string;
  share: string;
  value: string;
  hidden: boolean;
}

export function legendItems(
  series: readonly ChartSeries[], hidden: ReadonlySet<string>, whole: number, formatValue: (n: number) => string,
): LegendItem[] {
  return series.map((s) => ({
    id: s.id, name: s.name, color: s.color, share: formatShare(s.total, whole), value: formatValue(s.total), hidden: hidden.has(s.id),
  }));
}

export interface TooltipRow {
  id: string;
  name: string;
  color: string;
  value: number;
}

/** Every visible series with a value in a bucket, largest first. */
export function tooltipRows(series: readonly ChartSeries[], hidden: ReadonlySet<string>, index: number, keepZero = false): TooltipRow[] {
  return series
    .filter((s) => !hidden.has(s.id) && (keepZero || (s.values[index] ?? 0) > 0))
    .map((s) => ({ id: s.id, name: s.name, color: s.color, value: s.values[index] ?? 0 }))
    .sort((a, b) => b.value - a.value);
}

// ── KPIs ───────────────────────────────────────────────────────────────────

export interface KpiView {
  id: 'total' | 'output' | 'cacheHit' | 'cost';
  label: string;
  value: string;
  delta: DeltaView | null;
  spark: (number | null)[];
  color: string;
}

export function buildKpis(usage: StatsUsage, L: Vocab): KpiView[] {
  const { totals, previous, buckets } = usage;
  const hit = cacheHitRate(totals);
  return [
    {
      id: 'total', label: L.statsKpiTotal, value: formatTokens(totals.total), color: slotColor(0),
      delta: relativeDelta(totals.total, previous?.total), spark: buckets.map((b) => b.total),
    },
    {
      id: 'output', label: L.statsKpiOutput, value: formatTokens(totals.output), color: slotColor(3),
      delta: relativeDelta(totals.output, previous?.output), spark: buckets.map((b) => b.output),
    },
    {
      id: 'cacheHit', label: L.statsKpiCacheHit, value: hit === null ? '—' : formatPercent(hit), color: slotColor(2),
      delta: previous ? pointDelta(hit, cacheHitRate(previous), L) : null, spark: buckets.map(cacheHitRate),
    },
    {
      id: 'cost', label: L.statsKpiCost, value: formatCost(totals.costUsd), color: slotColor(6),
      delta: relativeDelta(totals.costUsd, previous?.costUsd), spark: buckets.map((b) => b.costUsd),
    },
  ];
}

// ── Sessions ───────────────────────────────────────────────────────────────

export interface ShareItemView {
  id: string;
  name: string;
  color: string;
  value: string;
}

export interface SessionKindView extends ShareItemView {
  amount: number;
}

export interface SessionRowView {
  sessionId: string;
  projectId: string | null;
  label: string;
  sub: string;
  tokens: string;
  share: string;
  output: string;
  cost: string;
  lastActive: string;
  kinds: SessionKindView[];
  models: ShareItemView[];
  sources: ShareItemView[];
  requests: string;
  runs: string;
}

/** First-message titles can carry inline markdown (`**alap**`, `` `code` ``); show the text only. */
export function sessionLabel(row: Pick<StatsSessionRow, 'label' | 'sessionId'>): string {
  const text = row.label?.replace(/(\*\*|__|`)/g, '').trim();
  return text || row.sessionId.slice(0, 8);
}

function shareItems(items: readonly StatsShare[], dimension: 'model' | 'source', L: Vocab): ShareItemView[] {
  return items.map((item) => ({
    id: item.key, name: keyLabel(dimension, item.key, 0, L), color: slotColor(item.colorSlot), value: formatTokens(item.total),
  }));
}

export function buildSessionRow(row: StatsSessionRow, whole: number, now: number, lang: Lang, L: Vocab): SessionRowView {
  const locale = intlLocale(lang);
  return {
    sessionId: row.sessionId,
    projectId: row.projectId,
    label: sessionLabel(row),
    sub: [row.projectId ?? '—', row.mainModel].filter(Boolean).join(' · '),
    tokens: formatTokens(row.total),
    share: formatShare(row.total, whole),
    output: formatTokens(row.output),
    cost: formatCost(row.costUsd),
    lastActive: lastActive(row.lastAt, now, lang),
    kinds: TOKEN_KINDS.map((kind) => ({
      id: kind, name: kindLabel(kind, L), color: kindColor(kind), value: formatTokens(row[kind]), amount: row[kind],
    })),
    models: shareItems(row.models, 'model', L),
    sources: shareItems(row.sources, 'source', L),
    requests: formatCount(row.requests, locale),
    runs: formatCount(row.runs, locale),
  };
}

export function buildSessionRows(usage: StatsUsage, now: number, lang: Lang, L: Vocab): SessionRowView[] {
  return usage.sessions.map((row) => buildSessionRow(row, usage.totals.total, now, lang, L));
}

/** The next "Show more" count. */
export function showMore(shown: number, total: number, step = STATS_PAGE_ROWS): number {
  return Math.min(total, shown + step);
}

// ── Quota windows ──────────────────────────────────────────────────────────

export function accountKey(account: Pick<StatsQuotaAccount, 'provider' | 'route'>): string {
  return `${account.provider}\u0000${account.route ?? ''}`;
}

export function accountFromKey(key: string): { provider: string; route: string | null } {
  const [provider, route = ''] = key.split('\u0000');
  return { provider, route: route || null };
}

export interface QuotaRowView {
  id: string;
  label: string;
  percent: number;
  percentText: string;
  severity: UsageSeverity;
  /** Each source's part of the peak, in points of the window. */
  breakdown: ShareItemView[];
}

export function quotaPeriodLabel(period: StatsQuotaPeriod, span: StatsQuotaSpan, locale: string): string {
  const options: Intl.DateTimeFormatOptions = span === 'weekly'
    ? { month: 'numeric', day: 'numeric' }
    : { month: 'numeric', day: 'numeric', ...HOUR_OPTIONS };
  return dateFormat(locale, options).formatRange(new Date(period.start), new Date(period.end));
}

export function quotaRows(periods: readonly StatsQuotaPeriod[], span: StatsQuotaSpan, lang: Lang, L: Vocab): QuotaRowView[] {
  const locale = intlLocale(lang);
  return periods.map((period) => {
    const peak = Math.max(0, Math.min(1, period.peakUtilization));
    return {
      id: `${period.windowType}:${period.end}`,
      label: quotaPeriodLabel(period, span, locale),
      percent: peak * 100,
      percentText: formatPercent(peak),
      severity: utilizationSeverity(peak),
      breakdown: [...period.breakdown].sort((a, b) => b.share - a.share).map((part) => ({
        id: part.key, name: sourceLabel(part.key, L), color: slotColor(part.colorSlot), value: formatPercent(part.share * peak),
      })),
    };
  });
}

// ── Tool ranking ───────────────────────────────────────────────────────────

export interface RankRowView {
  name: string;
  count: string;
  /** Bar length relative to the top entry, 0–100. */
  width: number;
  color: string;
}

export function rankRows(ranking: readonly StatsToolRank[], locale: string): RankRowView[] {
  const top = Math.max(1, ...ranking.map((r) => r.count));
  return ranking.map((r) => ({
    name: r.name, count: formatCount(r.count, locale), width: (r.count / top) * 100, color: slotColor(r.colorSlot),
  }));
}

// ── Totals ─────────────────────────────────────────────────────────────────

export function isEmptyUsage(totals: StatsTotals): boolean {
  return totals.total === 0 && totals.runs === 0;
}
