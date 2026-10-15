import { buildViewCsp } from '@/features/media/html-sandbox';

// The board body is agent-written HTML rendered in a frame sandboxed to `allow-scripts` (see
// media/html-sandbox.ts for why that token set is the whole defence). The frame is its own
// document, so the app's theme variables do not cascade into it: the parent reads the values the
// stylesheets reference off its own root and hands them over. The document is stacked
//
//   theme variables → default preset → user override → board.html body
//
// so the preset can be restyled by the override, and the body can restyle anything.

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/** Every custom property referenced through `var(--x)`, in first-seen order. */
export function referencedVars(...sources: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(VAR_REF)) seen.add(match[1]!);
  }
  return [...seen];
}

/** A value that cannot close its declaration or the style element it sits in. */
function safeValue(raw: string): string | null {
  const v = raw.trim();
  return v && !/[;{}<]/.test(v) ? v : null;
}

/** `:root{…}` declaring each name the parent resolves; names it does not know are left out, so the
 *  preset's own `--b-*` defaults still apply. */
export function themeVarsCss(names: string[], read: (name: string) => string): string {
  const decls: string[] = [];
  for (const name of names) {
    const value = safeValue(read(name));
    if (value) decls.push(`${name}:${value}`);
  }
  return decls.length ? `:root{${decls.join(';')}}` : '';
}

/** Read `names` off an element's computed style (the app root in practice). */
export function readThemeVars(names: string[], root: Element): string {
  const style = getComputedStyle(root);
  return themeVarsCss(names, (name) => style.getPropertyValue(name));
}

/** Messages the board frame posts to its parent. Authenticate by `event.source`, never by origin:
 *  a sandboxed frame reports its origin as "null". */
export type BoardMessage =
  | { type: 'height'; value: number }
  | { type: 'open'; path: string }
  | { type: 'link'; href: string };

const HEIGHT_MAX = 200_000;

export function parseBoardMessage(data: unknown): BoardMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  switch (d.__cortexBoard) {
    case 'height': {
      const n = Number(d.value);
      if (!Number.isFinite(n)) return null;
      return { type: 'height', value: Math.min(HEIGHT_MAX, Math.max(0, Math.round(n))) };
    }
    case 'open':
      return typeof d.path === 'string' && d.path ? { type: 'open', path: d.path } : null;
    case 'link':
      return typeof d.href === 'string' && /^https?:\/\//i.test(d.href) ? { type: 'link', href: d.href } : null;
    default:
      return null;
  }
}

// Reports the content height (the parent scrolls, so a reload keeps the reader's place) and turns
// link clicks into requests: `data-open` opens a board file, an http(s) link opens outside.
// No literal markup in this script — it would close the script element early.
const BOOTSTRAP = `
(function () {
  var last = -1;
  function post(msg) { try { parent.postMessage(msg, '*'); } catch (e) {} }
  function report() {
    var d = document.documentElement, b = document.body;
    var h = Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0);
    if (Math.abs(h - last) < 2) return;
    last = h;
    post({ __cortexBoard: 'height', value: h });
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-open],a[href]') : null;
    if (!t) return;
    var open = t.getAttribute('data-open');
    if (open) { e.preventDefault(); post({ __cortexBoard: 'open', path: open }); return; }
    var href = t.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    e.preventDefault();
    if (/^https?:/i.test(href)) post({ __cortexBoard: 'link', href: t.href });
  }, true);
  function watch() {
    report();
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(report).observe(document.body || document.documentElement); } catch (e) {}
    }
    window.addEventListener('load', report);
    [60, 250, 800, 2000].forEach(function (t) { setTimeout(report, t); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();
`.trim();

/** Keep a stylesheet from closing its own element. */
function styleText(css: string | null | undefined): string {
  return (css ?? '').replace(/<\/style/gi, '<\\/style');
}

export interface BoardDocumentParts {
  /** Output of `themeVarsCss` / `readThemeVars`. */
  themeCss: string;
  defaultCss: string;
  userCss: string | null;
  body: string;
  pendingContent: string;
  theme: 'light' | 'dark';
}

export function assembleBoardDocument(parts: BoardDocumentParts): string {
  const pending = parts.pendingContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = parts.body.replaceAll('{{boardPendingContent}}', () => pending);
  const base = `:root{color-scheme:${parts.theme}}html,body{background:transparent}`;
  return '<!DOCTYPE html><html><head>'
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta http-equiv="Content-Security-Policy" content="${buildViewCsp()}">`
    + `<style data-board-layer="theme">${base}${styleText(parts.themeCss)}</style>`
    + `<style data-board-layer="preset">${styleText(parts.defaultCss)}</style>`
    + (parts.userCss ? `<style data-board-layer="user">${styleText(parts.userCss)}</style>` : '')
    + `<script>${BOOTSTRAP}</script>`
    + `</head><body>${body}</body></html>`;
}
