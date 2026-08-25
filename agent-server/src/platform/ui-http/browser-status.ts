// input:  the managed browser's live state and this host's display capability
// output: an authenticated status route telling the UI where the browser is and how to reach it
// pos:    Web UI transport host — the takeover half of browser control
// >>> If I am updated, update CORTEX.md <<<

import type * as http from 'http';
import { browserStatus } from '@platform/browser/managed-browser.js';
import { resolveBrowserDisplay, type BrowserDisplay } from '@platform/browser/display.js';

/** Where the UI asks "where is the browser, and can I take it over?". */
export const BROWSER_STATUS_PATH = '/api/browser/status';

/**
 * The display probe shells out (xdpyinfo/launchctl), so it must not run per request. The answer
 * changes only when someone starts or ends a graphical session — a minute of staleness is
 * invisible to a human reading a tooltip, and it keeps a polled UI from spawning processes.
 */
const DISPLAY_TTL_MS = 60_000;
let cached: { at: number; value: BrowserDisplay } | null = null;

function displayNow(): BrowserDisplay {
  if (cached && Date.now() - cached.at < DISPLAY_TTL_MS) return cached.value;
  const value = resolveBrowserDisplay();
  cached = { at: Date.now(), value };
  return value;
}

export interface BrowserStatusPayload {
  /** Chrome is up right now. False is normal: it starts on demand and is reclaimed when idle. */
  running: boolean;
  /** How many browser-enabled turns hold it. */
  refs: number;
  /** Where it draws when it runs. Reported even while stopped — the user asks "can I log in?"
   *  before there is anything to look at. */
  display: BrowserDisplay;
  /** Present only while running; the endpoint a human could point their own tools at. */
  cdpEndpoint: string | null;
}

export function browserStatusPayload(): BrowserStatusPayload {
  const status = browserStatus();
  // A live instance reports the display it actually launched on; a stopped one reports what it
  // WOULD get, so the answer never depends on whether the user happens to be mid-turn.
  const display = status.browser?.display ?? displayNow();
  return {
    running: status.running,
    refs: status.refs,
    display,
    cdpEndpoint: status.browser?.cdpEndpoint ?? null,
  };
}

export function createBrowserStatusRoutes(): Record<
  string,
  (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
> {
  return {
    [BROWSER_STATUS_PATH]: async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data: browserStatusPayload() }));
    },
  };
}
