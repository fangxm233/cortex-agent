// input:  raw address-bar text, page/API origins, and navigation intents
// output: normalized preview URLs, an origin guard, history math and viewport presets
// pos:    pure browser-pane model; no DOM, no I/O
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// The docked browser pane previews HTTP services that are reachable from THIS machine — a local
// dev server, or a remote one surfaced by the port forward (see plan/embedded-browser.md §4).
// Everything here is pure so the pane itself stays a thin view.

/** A web page docked in the preview pane. Joins `PreviewItem` alongside MediaItem / DocItem. */
export interface WebItem {
  kind: 'web';
  /** Display label in the pane header (host:port + path). */
  name: string;
  /** Absolute http(s) URL, or '' for the empty pane (address bar waiting for input). */
  url: string;
}

/** Only http(s) is previewable. `javascript:` / `data:` / `file:` must never reach an iframe src. */
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Address-bar text → an absolute URL, or null when it is not previewable.
 *
 * Accepts the three shapes a dev types: a bare port (`5173` → loopback), a host:port
 * (`localhost:5173`), and a full URL. A missing scheme becomes `http:` — dev servers are http,
 * and guessing https would break every one of them.
 */
export function normalizeBrowserUrl(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  if (/^\d{2,5}$/.test(text)) {
    const port = Number(text);
    if (port < 1 || port > 65535) return null;
    return `http://127.0.0.1:${port}/`;
  }
  const withScheme = text.includes('://') ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) return null;
    if (url.hostname === '') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Short label for the pane header: host:port plus a non-root path. */
export function browserItemName(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

/** Build the docked item for a URL (already normalized). */
export function webItem(url: string): WebItem {
  return { kind: 'web', name: url === '' ? 'Browser' : browserItemName(url), url };
}

/**
 * THE security boundary of this pane (plan/embedded-browser.md §10).
 *
 * The frame is granted `allow-same-origin` because real dev apps need storage — so isolation rests
 * entirely on the target being a DIFFERENT origin from both the app page and the API. Same-origin
 * with the app page would hand the frame `__CORTEX_DESKTOP_CONFIG` (server URL + token in
 * cleartext) and `window.__TAURI__.core.invoke`; same-origin with the API would let it ride the
 * Cloudflare Access cookie in browser mode. Either is a full compromise, so both are refused.
 *
 * A relative/empty `apiBase()` (browser mode) contributes no origin of its own — the page origin
 * already covers it. Unparseable input is refused: "we could not tell" must not read as "safe".
 */
export function previewOriginConflict(url: string, origins: (string | undefined | null)[]): boolean {
  let target: string;
  try {
    target = new URL(url).origin;
  } catch {
    return true;
  }
  return origins.some((raw) => {
    if (!raw) return false;
    try {
      return new URL(raw, 'http://invalid.invalid').origin === target;
    } catch {
      return false;
    }
  });
}

/** Sandbox tokens for the preview frame. `allow-same-origin` is deliberate (see above) and safe
 *  ONLY because `previewOriginConflict` refuses same-origin targets. Top-level navigation is NOT
 *  granted: a framed page must never be able to navigate the whole app away. */
export const WEB_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups';

// ── History ───────────────────────────────────────────────────────────────────
// The pane owns its own back/forward stack. A cross-origin iframe's internal history is invisible
// to us (and `history.back()` on it is not reachable), so navigation means re-pointing `src`.

export interface BrowserHistory {
  entries: string[];
  /** Index of the current entry, or -1 when empty. */
  index: number;
}

export const EMPTY_HISTORY: BrowserHistory = { entries: [], index: -1 };

/** Cap so a long session cannot grow the stack without bound. */
const HISTORY_CAP = 50;

export function currentUrl(h: BrowserHistory): string | null {
  return h.index >= 0 && h.index < h.entries.length ? h.entries[h.index] : null;
}

/** Navigate to `url`. Re-entering the current URL is a no-op (reload is a separate action);
 *  navigating from the middle of the stack drops the forward entries, like a real browser. */
export function pushHistory(h: BrowserHistory, url: string): BrowserHistory {
  if (currentUrl(h) === url) return h;
  const kept = h.entries.slice(0, h.index + 1);
  kept.push(url);
  const trimmed = kept.length > HISTORY_CAP ? kept.slice(kept.length - HISTORY_CAP) : kept;
  return { entries: trimmed, index: trimmed.length - 1 };
}

export function canGoBack(h: BrowserHistory): boolean {
  return h.index > 0;
}

export function canGoForward(h: BrowserHistory): boolean {
  return h.index >= 0 && h.index < h.entries.length - 1;
}

export function goBack(h: BrowserHistory): BrowserHistory {
  return canGoBack(h) ? { ...h, index: h.index - 1 } : h;
}

export function goForward(h: BrowserHistory): BrowserHistory {
  return canGoForward(h) ? { ...h, index: h.index + 1 } : h;
}

// ── Viewport presets ──────────────────────────────────────────────────────────

export interface ViewportPreset {
  id: 'fit' | 'desktop' | 'tablet' | 'phone';
  label: string;
  /** CSS width applied to the frame; null = fill the pane. */
  width: number | null;
}

/** `fit` is the default — the pane is usually narrower than a desktop viewport already. The fixed
 *  widths render the frame at that width and let the pane scroll, for checking breakpoints. */
export const VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: 'fit', label: 'Fit', width: null },
  { id: 'desktop', label: '1280', width: 1280 },
  { id: 'tablet', label: '768', width: 768 },
  { id: 'phone', label: '390', width: 390 },
];
