/** Theme-neutral stylesheet: follows the viewer's light/dark preference, one series hue. */
export const DASHBOARD_STYLE = `
.viz-root {
  color-scheme: light;
  --surface-0: #f4f4f2; --surface-1: #fcfcfb; --border: #e2e1dc;
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #7a7974;
  --series-1: #2a78d6; --critical: #d03b3b; --grid: #e6e5e0;
}
@media (prefers-color-scheme: dark) {
  .viz-root {
    color-scheme: dark;
    --surface-0: #121211; --surface-1: #1a1a19; --border: #2e2e2b;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8f8e86;
    --series-1: #3987e5; --critical: #e66767; --grid: #2a2a27;
  }
}
* { box-sizing: border-box; }
body { margin: 0; }
.viz-root {
  min-height: 100vh; padding: 20px 24px 40px; background: var(--surface-0);
  color: var(--text-primary); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 20px; margin-bottom: 16px; }
h1 { font-size: 18px; margin: 0; }
h2 { font-size: 15px; margin: 0 0 4px; }
h3 { font-size: 13px; margin: 0 0 6px; color: var(--text-secondary); }
.filters { display: flex; gap: 6px; flex-wrap: wrap; }
.filters a {
  padding: 2px 10px; border: 1px solid var(--border); border-radius: 999px;
  color: var(--text-secondary); text-decoration: none; background: var(--surface-1);
}
.filters a.on { border-color: var(--series-1); color: var(--text-primary); font-weight: 600; }
.stamp { color: var(--text-muted); }
section {
  background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px;
  padding: 14px 16px; margin-bottom: 14px;
}
.note { margin: 0 0 10px; color: var(--text-muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.panel { min-width: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.tile { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; }
.tile-label { color: var(--text-secondary); }
.tile-value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tile-note { color: var(--text-muted); min-height: 1em; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { text-align: left; font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--border); }
th, td { padding: 4px 8px 4px 0; vertical-align: top; }
tr + tr td { border-top: 1px solid var(--grid); }
.num { text-align: right; }
.empty { color: var(--text-muted); margin: 4px 0; }
.barcell { position: relative; display: block; min-width: 90px; }
.bar { position: absolute; left: 0; top: 2px; bottom: 2px; border-radius: 0 4px 4px 0; opacity: 0.28; }
.bar.series { background: var(--series-1); }
.bar.critical { background: var(--critical); }
.barlabel { position: relative; padding-left: 4px; }
details summary { cursor: pointer; }
pre {
  white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; margin: 6px 0;
  padding: 8px; background: var(--surface-0); border-radius: 4px; font-size: 12px;
}
.meta { margin: 4px 0; color: var(--text-muted); word-break: break-all; }
.chart { width: 100%; max-width: 980px; height: auto; display: block; }
.chart .gridline { stroke: var(--grid); stroke-width: 1; }
.chart .axis { fill: var(--text-muted); font-size: 11px; }
.chart .line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; }
.chart .dot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }
.chart .hit { fill: transparent; }
.chart .pt:hover .dot { r: 6; }
`;
