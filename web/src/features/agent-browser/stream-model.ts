import type { Vocab } from '@/i18n';
import type { AgentBrowserSession } from './agent-browser-api';

// Pure logic behind the agent-browser view: where a frame sits in the box and how a pointer maps
// onto the page, which keys go to the page and which stay with the app, and the stream's state.
// The protocol is agent-browser's stream (JPEG frames + CDP-shaped input), proxied by the server.

// ── Geometry ──────────────────────────────────────────────────────────────────

/** What the server reports with each frame. Sizes are the page viewport in CSS pixels. */
export interface FrameMeta {
  deviceWidth: number;
  deviceHeight: number;
  offsetTop?: number;
  pageScaleFactor?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  timestamp?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a page of `pageW × pageH` lands when scaled to fit inside the box, centred and letterboxed. */
export function fitRect(boxW: number, boxH: number, pageW: number, pageH: number): Rect {
  if (boxW <= 0 || boxH <= 0 || pageW <= 0 || pageH <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(boxW / pageW, boxH / pageH);
  const width = pageW * scale;
  const height = pageH * scale;
  return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height };
}

/**
 * A point in the box (CSS px from its top-left) as a point on the page, or null when it falls on
 * the letterbox. Mapped through the frame's own metadata rather than the JPEG's pixel size: a capped
 * or HiDPI frame has a different pixel size from the page it shows.
 */
export function toPagePoint(px: number, py: number, fit: Rect, meta: FrameMeta): { x: number; y: number } | null {
  if (fit.width <= 0 || fit.height <= 0) return null;
  const u = (px - fit.x) / fit.width;
  const v = (py - fit.y) / fit.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { x: Math.round(u * meta.deviceWidth), y: Math.round(v * meta.deviceHeight) };
}

// ── Input ─────────────────────────────────────────────────────────────────────

export type MouseButtonName = 'left' | 'middle' | 'right' | 'none';

export function mouseButton(button: number): MouseButtonName {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'none';
}

/** The pressed button during a move, from `MouseEvent.buttons`. */
export function heldButton(buttons: number): MouseButtonName {
  if (buttons & 1) return 'left';
  if (buttons & 2) return 'right';
  if (buttons & 4) return 'middle';
  return 'none';
}

interface ModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** CDP modifier bits (Alt 1, Ctrl 2, Meta 4, Shift 8). ⌘ maps to Ctrl: the remote page runs on
 *  Linux or Windows, where Ctrl is what selects all or undoes. */
export function modifiersOf(e: ModifierState): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 2 : 0) | (e.shiftKey ? 8 : 0);
}

export interface KeyLike extends ModifierState {
  key: string;
  code: string;
  /** The legacy `KeyboardEvent.keyCode`: the Windows virtual-key code, which the page needs for
   *  editing keys (Backspace, arrows) and Ctrl shortcuts to take effect. */
  keyCode?: number;
  isComposing?: boolean;
}

/**
 * Who a key belongs to while the page is taken over.
 *  - `page`: sent to the remote page, and kept from the app.
 *  - `paste`: ⌘/Ctrl+V — left to the browser so its paste event carries the local clipboard over.
 *  - `app`: never sent. Every app shortcut is ⌘/Ctrl+something; select-all and undo/redo are the
 *    exceptions worth having on the page. F11 is the window's full screen. Composition keys are the
 *    IME's — Chinese goes through the paste field instead.
 */
export function routeKey(e: KeyLike): 'page' | 'paste' | 'app' {
  if (e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return 'app';
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'v') return 'paste';
  if (mod) return k === 'a' || k === 'z' || k === 'y' ? 'page' : 'app';
  if (e.key === 'F11') return 'app';
  return 'page';
}

export interface KeyboardMessage {
  type: 'input_keyboard';
  eventType: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  modifiers: number;
  windowsVirtualKeyCode?: number;
  text?: string;
}

/** A key as the page receives it. A printable key without Ctrl/⌘/Alt carries its text, which is
 *  what makes it type. */
export function keyMessage(e: KeyLike, eventType: 'keyDown' | 'keyUp'): KeyboardMessage {
  const msg: KeyboardMessage = { type: 'input_keyboard', eventType, key: e.key, code: e.code, modifiers: modifiersOf(e) };
  if (e.keyCode && e.keyCode > 0) msg.windowsVirtualKeyCode = e.keyCode;
  const printable = [...e.key].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (eventType === 'keyDown' && (printable || e.key === 'Enter')) msg.text = e.key === 'Enter' ? '\r' : e.key;
  return msg;
}

export interface MouseMessage {
  type: 'input_mouse';
  eventType: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
  x: number;
  y: number;
  button: MouseButtonName;
  clickCount: number;
  modifiers: number;
  deltaX?: number;
  deltaY?: number;
}

/** `WheelEvent.deltaMode` lines/pages → pixels, the unit CDP expects. */
export function wheelPixels(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 600;
  return delta;
}

// ── Stream state ─────────────────────────────────────────────────────────────

/**
 * - `idle`: not streaming (hidden, or the session has no browser yet).
 * - `connecting`: asking for a ticket / opening the socket.
 * - `live`: socket open; `hasFrame` says whether anything has been drawn yet.
 * - `retrying`: the socket dropped and a reconnect is scheduled.
 */
export type StreamPhase = 'idle' | 'connecting' | 'live' | 'retrying';

export interface StreamView {
  phase: StreamPhase;
  url: string | null;
  title: string | null;
  meta: FrameMeta | null;
  hasFrame: boolean;
  /** Consecutive failed attempts; resets once a frame arrives. */
  failures: number;
}

export const INITIAL_STREAM: StreamView = { phase: 'idle', url: null, title: null, meta: null, hasFrame: false, failures: 0 };

export interface StreamTab {
  active?: boolean;
  title?: string | null;
  url?: string | null;
}

export type StreamEvent =
  | { type: 'connect' }
  | { type: 'open' }
  | { type: 'frame'; meta: FrameMeta }
  | { type: 'url'; url: string }
  | { type: 'tabs'; tabs: StreamTab[] }
  | { type: 'drop' }
  | { type: 'stop' };

export function streamReducer(state: StreamView, event: StreamEvent): StreamView {
  switch (event.type) {
    case 'connect':
      return { ...state, phase: 'connecting' };
    case 'open':
      return { ...state, phase: 'live' };
    case 'frame':
      return { ...state, phase: 'live', meta: event.meta, hasFrame: true, failures: 0 };
    case 'url':
      return { ...state, url: event.url };
    case 'tabs': {
      const tab = event.tabs.find((t) => t.active) ?? event.tabs[0];
      if (!tab) return state;
      return { ...state, title: tab.title || state.title, url: tab.url || state.url };
    }
    case 'drop':
      return { ...state, phase: 'retrying', failures: state.failures + 1 };
    case 'stop':
      return { ...state, phase: 'idle' };
  }
}

/** Backoff before reconnect attempt n (1-based): 1 s, 2 s, 4 s, then every 8 s. */
export function retryDelayMs(failures: number): number {
  return Math.min(8000, 1000 * 2 ** Math.max(0, failures - 1));
}

/** One parsed server message, or null for anything this view does not use. */
export function parseStreamMessage(raw: string): (
  | { type: 'frame'; seq: number; data: string; meta: FrameMeta }
  | { type: 'url'; url: string }
  | { type: 'tabs'; tabs: StreamTab[] }
) | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (msg.type === 'frame' && typeof msg.data === 'string' && typeof msg.seq === 'number') {
    const meta = msg.metadata as FrameMeta | undefined;
    if (!meta || !(meta.deviceWidth > 0) || !(meta.deviceHeight > 0)) return null;
    return { type: 'frame', seq: msg.seq, data: msg.data, meta };
  }
  if (msg.type === 'url' && typeof msg.url === 'string') return { type: 'url', url: msg.url };
  if (msg.type === 'tabs' && Array.isArray(msg.tabs)) return { type: 'tabs', tabs: msg.tabs as StreamTab[] };
  return null;
}

// ── What the view says ────────────────────────────────────────────────────────

/** The machine a browser runs on, as the app names it. */
export function deviceLabel(device: string, L: Pick<Vocab, 'brServer'>): string {
  return device === 'server' ? L.brServer : device;
}

/** The page's host, for the capsule; the raw value when it does not parse. */
export function pageHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'about:' || parsed.protocol === 'chrome:') return null;
    return parsed.host || null;
  } catch {
    return url;
  }
}

/**
 * The title to show for the page at `url`. The server's record is read after each agent command, so
 * it is right while it describes this same URL; once the person navigates during a takeover it is
 * stale. The stream's own tab title is a fallback only when it is a real title: agent-browser keeps a
 * tab's creation-time host there.
 */
export function pageTitle(url: string | null, session: AgentBrowserSession | null | undefined, streamTitle: string | null): string | null {
  if (session?.title && session.url === url) return session.title;
  if (streamTitle && streamTitle !== pageHost(url)) return streamTitle;
  return null;
}

export type BodyStatus = 'none' | 'starting' | 'error' | 'connecting' | 'live' | 'retrying';

/** One status for the body, the lease's state first: a stream is only worth opening once ready. */
export function bodyStatus(session: AgentBrowserSession | null | undefined, view: StreamView): BodyStatus {
  if (!session) return 'none';
  if (session.state === 'starting') return 'starting';
  if (session.state === 'error') return 'error';
  if (view.phase === 'live' && view.hasFrame) return 'live';
  if (view.phase === 'retrying') return 'retrying';
  return 'connecting';
}

/** How often the session list is worth re-reading: fast while something is moving, slow while a
 *  lease just sits there, and not at all for a session that has never had one. */
export function pollIntervalMs(input: { visible: boolean; running: boolean; hasLease: boolean; viewing: boolean }): number | false {
  if (!input.visible) return false;
  if (input.viewing) return 2000;
  if (input.running) return 3000;
  if (input.hasLease) return 10_000;
  return false;
}
