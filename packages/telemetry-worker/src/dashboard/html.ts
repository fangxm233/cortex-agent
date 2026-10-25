/** HTML and inline-SVG building blocks for the server-rendered dashboard. */

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);
}

export function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function fmtInt(value: unknown): string {
  return Math.round(num(value)).toLocaleString('en-US');
}

export function fmtMs(value: unknown): string {
  const ms = num(value);
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

export function pct(part: number, whole: number): string {
  return whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : '–';
}

export interface Column<R> {
  label: string;
  cell: (row: R) => string;
  numeric?: boolean;
}

export function table<R>(columns: Column<R>[], rows: R[], empty = 'No data in this window.'): string {
  if (rows.length === 0) return `<p class="empty">${esc(empty)}</p>`;
  const head = columns.map(c => `<th${c.numeric ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.map(row => `<tr>${columns.map(c =>
    `<td${c.numeric ? ' class="num"' : ''}>${c.cell(row)}</td>`).join('')}</tr>`).join('\n');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** A value with a proportional bar behind it; `tone` picks the series or the critical color. */
export function bar(value: number, max: number, label: string, tone: 'series' | 'critical' = 'series'): string {
  const width = max > 0 && value > 0 ? Math.min(100, Math.max(1, Math.round((100 * value) / max))) : 0;
  return `<span class="barcell"><span class="bar ${tone}" style="width:${width}%"></span>`
    + `<span class="barlabel">${esc(label)}</span></span>`;
}

export function section(title: string, body: string, note = ''): string {
  const caption = note ? `<p class="note">${esc(note)}</p>` : '';
  return `<section><h2>${esc(title)}</h2>${caption}${body}</section>`;
}

export function grid(...panels: string[]): string {
  return `<div class="grid">${panels.join('')}</div>`;
}

export function panel(title: string, body: string): string {
  return `<div class="panel"><h3>${esc(title)}</h3>${body}</div>`;
}

export interface Tile {
  label: string;
  value: string;
  note?: string;
}

export function tiles(items: Tile[]): string {
  const cells = items.map(item => `<div class="tile"><div class="tile-label">${esc(item.label)}</div>`
    + `<div class="tile-value">${esc(item.value)}</div>`
    + `<div class="tile-note">${esc(item.note ?? '')}</div></div>`);
  return `<div class="tiles">${cells.join('')}</div>`;
}

export interface Point {
  label: string;
  value: number;
}

const CHART = { width: 760, height: 200, left: 44, right: 16, top: 12, bottom: 28 } as const;

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value / 4));
  const step = [1, 2, 2.5, 5, 10].find(s => s * magnitude * 4 >= value) ?? 10;
  return step * magnitude * 4;
}

function chartGrid(max: number, y: (v: number) => number): string {
  return [0, 0.25, 0.5, 0.75, 1].map(fraction => {
    const value = max * fraction;
    return `<line class="gridline" x1="${CHART.left}" x2="${CHART.width - CHART.right}" y1="${y(value)}" y2="${y(value)}"/>`
      + `<text class="axis" x="${CHART.left - 6}" y="${y(value) + 4}" text-anchor="end">${fmtInt(value)}</text>`;
  }).join('');
}

function chartXLabels(points: Point[], x: (i: number) => number): string {
  const picks = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  return picks.map(i => `<text class="axis" x="${x(i)}" y="${CHART.height - 8}" text-anchor="middle">`
    + `${esc(points[i].label)}</text>`).join('');
}

/** One-series line chart; each point carries a native hover tooltip and a larger hit target. */
export function lineChart(points: Point[], unit: string): string {
  if (points.length === 0) return '<p class="empty">No data in this window.</p>';
  const max = niceMax(Math.max(...points.map(p => p.value)));
  const span = CHART.width - CHART.left - CHART.right;
  const x = (i: number) => CHART.left + (points.length === 1 ? span / 2 : (span * i) / (points.length - 1));
  const y = (v: number) => CHART.top + (CHART.height - CHART.top - CHART.bottom) * (1 - v / max);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const marks = points.map((p, i) => `<g class="pt"><title>${esc(p.label)}: ${fmtInt(p.value)} ${esc(unit)}</title>`
    + `<circle class="hit" cx="${x(i)}" cy="${y(p.value)}" r="10"/>`
    + `<circle class="dot" cx="${x(i)}" cy="${y(p.value)}" r="4"/></g>`).join('');
  return `<svg class="chart" viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-label="${esc(unit)} per day">`
    + `${chartGrid(max, y)}${chartXLabels(points, x)}<path class="line" d="${path}"/>${marks}</svg>`;
}

export function details(summary: string, body: string): string {
  return `<details><summary>${esc(summary)}</summary>${body}</details>`;
}
