// input:  agent-authored HTML and a render mode
// output: the sandbox token set, an injected CSP, a wrapped srcdoc, and the parsed frame protocol
// pos:    the security boundary for every agent-rendered view; pure, no DOM, no I/O
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// An agent-rendered view (`AttachmentMeta.type === 'view'`) is UNTRUSTED HTML that runs in this
// app's webview. The isolation is the `sandbox` attribute and nothing else — there is no CSP header
// anywhere in the stack (the Tauri shell sets `csp: null`, the ui-http server and the desktop
// `cortexui://` scheme both send Content-Type only). So the rules below are the whole defence:
//
//   1. NEVER add `allow-same-origin`. With `allow-scripts` it is equivalent to no sandbox at all:
//      the frame can reach into the parent and remove its own sandbox attribute. In the desktop
//      shell the parent page holds `window.__CORTEX_DESKTOP_CONFIG` (server URL + auth token in
//      cleartext) and `window.__TAURI__.core.invoke` — a same-origin frame owns both.
//   2. NEVER point the frame at `/api/files/download`. In the browser the SPA is served
//      same-origin with the API, so the document would execute AS Cortex; in the desktop shell the
//      frame cannot send `x-cortex-token` and the request 401s anyway. `blob:` URLs inherit the
//      creating origin, so they fail the same way.
//   3. The bytes are fetched by the PARENT (authenticated) and handed to the frame as `srcdoc`.
//      With no `allow-same-origin` the frame gets an opaque origin: no parent DOM, no storage, no
//      cookies, and any request it makes carries `Origin: null`, which the server's non-wildcard
//      CORS allow-list rejects.
//
// `html-sandbox.test.ts` asserts these properties. If a test there fails, the fix is the caller,
// never the assertion.

/** The complete sandbox token set for a view frame. Deliberately a single token. */
export const VIEW_SANDBOX = 'allow-scripts';

/** Mirrors the server-side clamp in `orchestration/agent-view-send.ts`. Duplicated rather than
 *  shared because the web bundle must not import server code; both sides clamp independently. */
export const VIEW_HEIGHT_MIN = 160;
export const VIEW_HEIGHT_MAX = 900;
export const VIEW_HEIGHT_DEFAULT = 360;
/** Expanded surfaces (modal, docked pane) let a view grow past the inline card's ceiling. */
export const VIEW_HEIGHT_MAX_EXPANDED = 20000;

export interface WrapViewOptions {
  /** Let the document load libraries/data over https. Off produces a fully offline document. */
  allowNetwork?: boolean;
  /** Seeds `color-scheme` so form controls, scrollbars and the default canvas match the app. */
  theme?: 'light' | 'dark';
  /**
   * Default text colour, resolved by the CALLER from the app's theme tokens (`--proto-ink`).
   * The frame is a separate document, so the app's CSS variables do not cascade into it and the
   * value has to be carried across. Omitted → no `color` declaration at all, and the UA default
   * for the declared `color-scheme` applies, which is already light-on-dark / dark-on-light.
   */
  ink?: string;
}

/**
 * Defence-in-depth policy injected into the document itself, since nothing upstream sets one.
 * `'self'` would be meaningless inside an opaque origin, so every source is spelled out. Inline
 * script/style are permitted because that is how a self-contained view is written (and how the
 * height bootstrap below runs); the isolation that matters comes from the opaque origin, not here.
 */
export function buildViewCsp(allowNetwork: boolean): string {
  const net = allowNetwork ? ' https:' : '';
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${net}`,
    `style-src 'unsafe-inline'${net}`,
    `img-src data: blob:${net}`,
    `font-src data:${net}`,
    `media-src data: blob:${net}`,
    `connect-src${net || " 'none'"}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** Message the frame posts to its parent. `submit` is reserved for the future "a view can answer
 *  back into the chat" path; it is parsed and ignored today so the protocol does not change later. */
export type ViewMessage =
  | { type: 'height'; value: number }
  | { type: 'submit'; value: unknown };

/**
 * Parse a `MessageEvent.data` from a view frame. Returns null for anything that is not ours.
 *
 * The caller must authenticate the message by `event.source === iframe.contentWindow`, NOT by
 * `event.origin`: a sandboxed frame without `allow-same-origin` reports its origin as the string
 * "null", so an origin allow-list would drop every message a view ever sends.
 */
export function parseViewMessage(data: unknown, maxHeight = VIEW_HEIGHT_MAX): ViewMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.__cortexView === 'height') {
    const n = Number(d.value);
    if (!Number.isFinite(n)) return null;
    return { type: 'height', value: Math.min(maxHeight, Math.max(VIEW_HEIGHT_MIN, Math.round(n))) };
  }
  if (d.__cortexView === 'submit') return { type: 'submit', value: d.value };
  return null;
}

/** Reports the document's natural height to the parent on load, on resize and on mutation, so the
 *  frame can be sized to its content instead of guessing. Inline (hence `'unsafe-inline'` above). */
const HEIGHT_BOOTSTRAP = `
(function () {
  var last = -1;
  function report() {
    var d = document.documentElement, b = document.body;
    var h = Math.max(
      d ? d.scrollHeight : 0, d ? d.offsetHeight : 0,
      b ? b.scrollHeight : 0, b ? b.offsetHeight : 0
    );
    if (!h || Math.abs(h - last) < 2) return;
    last = h;
    try { parent.postMessage({ __cortexView: 'height', value: h }, '*'); } catch (e) {}
  }
  function watch() {
    report();
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(report).observe(document.documentElement); } catch (e) {}
    }
    if (typeof MutationObserver === 'function') {
      try { new MutationObserver(report).observe(document.documentElement, { subtree: true, childList: true }); } catch (e) {}
    }
    window.addEventListener('load', report);
    // Late-arriving webfonts/images/charts settle over the first couple of seconds; these catch
    // the common cases in WebViews where ResizeObserver on the root element does not fire.
    // (No literal markup in this inline script - it would close the script element early.)
    [60, 250, 600, 1200, 2400].forEach(function (t) { setTimeout(report, t); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();
`.trim();

/** Keep a caller-supplied token value from escaping its declaration. The value comes from our own
 *  stylesheet, so this is a bound rather than a defence against a real attacker. */
function cssValue(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return v && !/[;{}<]/.test(v) ? v : null;
}

function baseStyle(theme: 'light' | 'dark', ink?: string): string {
  const color = cssValue(ink);
  return [
    `:root{color-scheme:${theme}}`,
    'html,body{margin:0;padding:0;background:transparent;',
    color ? `color:${color};` : '',
    "font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}",
  ].join('');
}

const HAS_HTML_TAG = /<html[\s>]/i;
const HAS_HEAD_OPEN = /<head[\s>]/i;
const HAS_CSP_META = /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy/i;

/**
 * Wrap agent HTML into the document actually handed to the frame's `srcdoc`.
 *
 * A fragment becomes a full document; a full document is left structurally alone and only has the
 * injected block spliced into its `<head>`. The injected block goes FIRST so the author's own
 * styles win every conflict — this adds a floor, it does not restyle the view.
 *
 * An author-supplied CSP meta is never overwritten: a view that ships a stricter policy of its own
 * keeps it. Never throws; the worst case is an un-augmented document.
 */
export function wrapViewDocument(html: string, opts: WrapViewOptions = {}): string {
  const theme = opts.theme ?? 'light';
  const allowNetwork = opts.allowNetwork ?? true;
  const source = typeof html === 'string' ? html : '';

  const csp = HAS_CSP_META.test(source)
    ? ''
    : `<meta http-equiv="Content-Security-Policy" content="${buildViewCsp(allowNetwork)}">`;
  const injected =
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    csp +
    `<style>${baseStyle(theme, opts.ink)}</style>` +
    `<script>${HEIGHT_BOOTSTRAP}</script>`;

  if (!HAS_HTML_TAG.test(source)) {
    return `<!DOCTYPE html><html><head>${injected}</head><body>${source}</body></html>`;
  }
  if (HAS_HEAD_OPEN.test(source)) {
    return source.replace(/(<head[^>]*>)/i, `$1${injected}`);
  }
  // A document with <html> but no <head>: browsers synthesize one, so open our own right after it.
  return source.replace(/(<html[^>]*>)/i, `$1<head>${injected}</head>`);
}
