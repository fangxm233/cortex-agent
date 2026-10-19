import * as crypto from 'crypto';
import type * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { timingSafeEqualStr } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { readJsonBody, sendError, sendJson, sendMethodNotAllowed } from './http-json.js';
import type { CustomRouteHandler } from './ui-http-server.js';

const log = createLogger('browser-stream');

// The agent's browser, seen and driven from the app. Each Cortex session that holds a browser lease
// has an agent-browser daemon session, and that daemon serves a live JPEG stream plus an input
// channel on a loopback port. This module lists those sessions, proxies the stream to the app over
// the ui-http server, and lets a person take the page over from the agent.
//
// Authentication of the stream: a page cannot put `x-cortex-token` on a WebSocket handshake, and the
// cookie / Cloudflare Access legs would ride along on any cross-site handshake. So the socket is
// opened with a one-shot ticket instead: the app first POSTs for one through the ordinary gate (token,
// session cookie or Access JWT, plus the Origin check every state-changing request gets), then
// presents it on the handshake. A ticket names one session, lives for seconds and is spent on use.
//
// A takeover belongs to the app window that asked for it (its `client` id, which also rides on that
// window's stream ticket). Only that window's input reaches the page, and the page goes back to the
// agent by itself when the person is gone: once the window's stream has been closed for
// TAKEOVER_GRACE_MS without coming back (dock closed, page reloaded, network lost), or after
// TAKEOVER_IDLE_MS without a click, key or paste. The broker only knows on/off; the watch lives here.

export const BROWSER_SESSIONS_PATH = '/api/browser/sessions';
export const BROWSER_TICKET_PATH = '/api/browser/stream-ticket';
export const BROWSER_STREAM_PATH = '/api/browser/stream';
export const BROWSER_TAKEOVER_PATH = '/api/browser/takeover';
export const BROWSER_INSERT_TEXT_PATH = '/api/browser/insert-text';

/** The session has no stream to attach to (no lease, still starting, or its daemon went away). */
export const CLOSE_NO_STREAM = 4004;
/** The upstream stream ended underneath a live viewer. The app reconnects with a fresh ticket. */
export const CLOSE_UPSTREAM_GONE = 4010;

const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 256;
const MAX_STREAMS = 32;
const DEFAULT_FPS = 10;
const MAX_FPS = 15;
/** Input and acks are tiny; anything near this is not a client of ours. */
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
/** Longest text the paste field may insert at once. */
export const MAX_INSERT_TEXT_CHARS = 4000;
/** A viewer this far behind is shed frames rather than buffered without bound. */
const MAX_DOWNSTREAM_BUFFER = 4 * 1024 * 1024;
const UPSTREAM_CONNECT_TIMEOUT_MS = 5_000;
/** How long a takeover survives its window's stream being gone, so a reload or a blip keeps it. */
export const TAKEOVER_GRACE_MS = 30_000;
/** How long a takeover lasts without any input from the person. */
export const TAKEOVER_IDLE_MS = 10 * 60_000;
/** Message the proxy adds to the stream whenever the takeover changes (and once on connect). */
export const TAKEOVER_MESSAGE = 'cortex_takeover';
/** An app window's id: opaque, not a credential — every caller is already authenticated. */
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type BrowserSessionState = 'starting' | 'ready' | 'error';

/** One leased browser as the app sees it. The domain owns the full record. */
export interface BrowserSessionView {
  sessionId: string;
  device: string;
  state: BrowserSessionState;
  error?: string;
  url?: string;
  title?: string;
  takenOver: boolean;
  lastUsedAt: number;
}

/**
 * The browser broker, injected: platform may not depend on domain, and the entry layer already owns
 * joining the two.
 */
export interface BrowserStreamDeps {
  listSessions: () => BrowserSessionView[];
  /** Loopback port of the session's agent-browser stream, or null when it has none. */
  streamPort: (sessionId: string) => Promise<number | null>;
  setTakeover: (sessionId: string, on: boolean) => void | Promise<void>;
  isTakenOver: (sessionId: string) => boolean;
  insertText: (sessionId: string, text: string) => Promise<void>;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface BrowserStreamOptions {
  graceMs?: number;
  idleMs?: number;
}

export interface BrowserStreamHandle {
  routes: Record<string, CustomRouteHandler>;
  /** Upgrade handler for BROWSER_STREAM_PATH. Authenticates by ticket itself. */
  handleUpgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => void;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const INPUT_TYPES = new Set(['input_mouse', 'input_keyboard', 'input_touch']);

/**
 * Decide what of a viewer's message reaches the page. Acks always pass (they only pace frames);
 * input passes only from the window holding the page, so a watcher can never steer it by accident.
 * Everything else (a `config` raising the frame rate, unknown types) is dropped. `input` marks the
 * person's own activity, which keeps the takeover alive.
 */
export function admitClientMessage(raw: string, holdsPage: boolean): { message: string; input: boolean } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const type = (msg as { type?: unknown }).type;
  if (type === 'ack') {
    const seq = (msg as { seq?: unknown }).seq;
    return typeof seq === 'number' && Number.isFinite(seq) ? { message: JSON.stringify({ type: 'ack', seq }), input: false } : null;
  }
  if (typeof type === 'string' && INPUT_TYPES.has(type) && holdsPage) return { message: raw, input: true };
  return null;
}

/** A body's `client`: '' when absent, null when present but malformed. */
export function parseClientId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return '';
  return typeof value === 'string' && CLIENT_ID.test(value) ? value : null;
}

/** The frame-rate cap a viewer asked for, clamped to what the tunnel should carry. */
export function clampFps(raw: string | null): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return DEFAULT_FPS;
  return Math.min(MAX_FPS, Math.max(1, Math.round(n)));
}

export interface StreamTarget {
  sessionId: string;
  ticket: string;
  fps: number;
}

export function parseStreamTarget(rawUrl: string): StreamTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://localhost');
  } catch {
    return null;
  }
  const sessionId = url.searchParams.get('session') ?? '';
  const ticket = url.searchParams.get('ticket') ?? '';
  if (!sessionId || !ticket) return null;
  return { sessionId, ticket, fps: clampFps(url.searchParams.get('maxFps')) };
}

// ── Tickets ──────────────────────────────────────────────────────────────────

export interface TicketStore {
  mint: (sessionId: string, client?: string) => string;
  /** Spend a ticket. The window it was minted for, only for a live ticket of this very session. */
  redeem: (ticket: string, sessionId: string) => { client: string } | null;
  size: () => number;
}

export function createTicketStore(now: () => number = Date.now): TicketStore {
  const tickets = new Map<string, { sessionId: string; client: string; expiresAt: number }>();
  const prune = (): void => {
    const t = now();
    for (const [id, entry] of tickets) if (entry.expiresAt <= t) tickets.delete(id);
  };
  return {
    mint(sessionId, client = '') {
      prune();
      // A burst past the cap drops the oldest: a ticket is cheap to ask for again.
      while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
      const id = crypto.randomBytes(32).toString('hex');
      tickets.set(id, { sessionId, client, expiresAt: now() + TICKET_TTL_MS });
      return id;
    },
    // A constant-time walk rather than a Map lookup, as the UI session store does: the ticket is a
    // credential for a few seconds, and the set is a handful of entries.
    redeem(ticket, sessionId) {
      prune();
      let hit: string | null = null;
      for (const id of tickets.keys()) if (timingSafeEqualStr(id, ticket)) hit = id;
      if (hit === null) return null;
      const entry = tickets.get(hit)!;
      tickets.delete(hit);
      return entry.sessionId === sessionId ? { client: entry.client } : null;
    },
    size: () => {
      prune();
      return tickets.size;
    },
  };
}

// ── Takeover watch ───────────────────────────────────────────────────────────

export type ReleaseReason = 'disconnected' | 'idle';

export interface TakeoverWatchDeps {
  isTakenOver: (sessionId: string) => boolean;
  /** Hand the page back to the agent on the person's behalf. */
  release: (sessionId: string, reason: ReleaseReason) => void;
  /** Whether a stream from this window is open on the session right now. */
  hasClient: (sessionId: string, client: string) => boolean;
  now: () => number;
  graceMs: number;
  idleMs: number;
}

export interface TakeoverWatch {
  begin: (sessionId: string, client: string) => void;
  end: (sessionId: string) => void;
  /** The window holding the session's page, or null. */
  holder: (sessionId: string) => string | null;
  /** A stream opened / closed. Call `disconnected` once the stream is out of the live set. */
  connected: (sessionId: string, client: string) => void;
  disconnected: (sessionId: string, client: string) => void;
  /** The person did something: a click, a key, a paste. */
  input: (sessionId: string) => void;
  close: () => void;
}

interface Hold {
  client: string;
  lastInputAt: number;
  grace: NodeJS.Timeout | null;
  idle: NodeJS.Timeout | null;
}

export function createTakeoverWatch(deps: TakeoverWatchDeps): TakeoverWatch {
  const holds = new Map<string, Hold>();
  const stop = (hold: Hold): void => {
    if (hold.grace) clearTimeout(hold.grace);
    if (hold.idle) clearTimeout(hold.idle);
    hold.grace = null;
    hold.idle = null;
  };
  const expire = (sessionId: string, hold: Hold, reason: ReleaseReason): void => {
    if (holds.get(sessionId) !== hold) return;
    stop(hold);
    holds.delete(sessionId);
    // The broker may already have dropped it (lease retired); then there is nothing to hand back.
    if (deps.isTakenOver(sessionId)) deps.release(sessionId, reason);
  };
  // One timer per hold, checked lazily: input only moves the timestamp, the timer re-arms itself.
  const armIdle = (sessionId: string, hold: Hold): void => {
    const wait = Math.max(0, hold.lastInputAt + deps.idleMs - deps.now());
    hold.idle = setTimeout(() => {
      hold.idle = null;
      if (deps.now() - hold.lastInputAt >= deps.idleMs) expire(sessionId, hold, 'idle');
      else armIdle(sessionId, hold);
    }, wait);
    hold.idle.unref?.();
  };
  const armGrace = (sessionId: string, hold: Hold): void => {
    if (hold.grace) return;
    hold.grace = setTimeout(() => {
      hold.grace = null;
      expire(sessionId, hold, 'disconnected');
    }, deps.graceMs);
    hold.grace.unref?.();
  };

  return {
    begin(sessionId, client) {
      const prev = holds.get(sessionId);
      if (prev) stop(prev);
      const hold: Hold = { client, lastInputAt: deps.now(), grace: null, idle: null };
      holds.set(sessionId, hold);
      armIdle(sessionId, hold);
      if (!deps.hasClient(sessionId, client)) armGrace(sessionId, hold);
    },
    end(sessionId) {
      const hold = holds.get(sessionId);
      if (!hold) return;
      stop(hold);
      holds.delete(sessionId);
    },
    holder: (sessionId) => holds.get(sessionId)?.client ?? null,
    connected(sessionId, client) {
      const hold = holds.get(sessionId);
      if (hold?.client === client && hold.grace) {
        clearTimeout(hold.grace);
        hold.grace = null;
      }
    },
    disconnected(sessionId, client) {
      const hold = holds.get(sessionId);
      if (hold?.client === client && !deps.hasClient(sessionId, client)) armGrace(sessionId, hold);
    },
    input(sessionId) {
      const hold = holds.get(sessionId);
      if (hold) hold.lastInputAt = deps.now();
    },
    close() {
      for (const hold of holds.values()) stop(hold);
      holds.clear();
    },
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function publicView(s: BrowserSessionView): BrowserSessionView {
  return {
    sessionId: s.sessionId,
    device: s.device,
    state: s.state,
    ...(s.error ? { error: s.error } : {}),
    ...(s.url ? { url: s.url } : {}),
    ...(s.title ? { title: s.title } : {}),
    takenOver: s.takenOver,
    lastUsedAt: s.lastUsedAt,
  };
}

/** `{ session }` from a POST body for a session that holds a browser, or null after answering. */
async function readSessionBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: BrowserStreamDeps,
): Promise<{ sessionId: string; body: Record<string, unknown> } | null> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST');
    return null;
  }
  const body = await readJsonBody(req, res);
  if (!body) return null;
  const sessionId = typeof body.session === 'string' ? body.session : '';
  if (!sessionId) {
    sendError(res, 400, 'missing-session', 'session is required');
    return null;
  }
  if (!deps.listSessions().some((s) => s.sessionId === sessionId)) {
    sendError(res, 404, 'no-browser', 'This session has no browser');
    return null;
  }
  return { sessionId, body };
}

interface Viewer {
  ws: WebSocket;
  sessionId: string;
  client: string;
}

export function createBrowserStream(deps: BrowserStreamDeps, opts: BrowserStreamOptions = {}): BrowserStreamHandle {
  const now = deps.now ?? Date.now;
  const tickets = createTicketStore(now);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  const live = new Set<Viewer>();

  const viewersOf = (sessionId: string): Viewer[] => [...live].filter((v) => v.sessionId === sessionId);

  const holdsPage = (viewer: Viewer): boolean =>
    viewer.client !== '' && deps.isTakenOver(viewer.sessionId) && watch.holder(viewer.sessionId) === viewer.client;

  /** Tell each viewer of the session whether the page is held, and whether by its own window. */
  const announce = (sessionId: string): void => {
    for (const viewer of viewersOf(sessionId)) {
      if (viewer.ws.readyState !== WebSocket.OPEN) continue;
      viewer.ws.send(JSON.stringify({
        type: TAKEOVER_MESSAGE, takenOver: deps.isTakenOver(sessionId), mine: holdsPage(viewer),
      }));
    }
  };

  const watch: TakeoverWatch = createTakeoverWatch({
    isTakenOver: deps.isTakenOver,
    hasClient: (sessionId, client) => client !== '' && viewersOf(sessionId).some((v) => v.client === client),
    now,
    graceMs: opts.graceMs ?? TAKEOVER_GRACE_MS,
    idleMs: opts.idleMs ?? TAKEOVER_IDLE_MS,
    release: (sessionId, reason) => {
      void (async () => {
        try {
          await deps.setTakeover(sessionId, false);
        } catch (err) {
          log.warn(`could not hand ${sessionId} back: ${(err as Error).message}`);
          return;
        }
        log.info(`browser handed back automatically (${reason === 'idle' ? 'no input' : 'window gone'}): ${sessionId}`);
        announce(sessionId);
      })();
    },
  });

  const routes: Record<string, CustomRouteHandler> = {
    [BROWSER_SESSIONS_PATH]: async (req, res) => {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
      sendJson(res, 200, { ok: true, data: { sessions: deps.listSessions().map(publicView) } }, { 'Cache-Control': 'no-store' });
    },

    [BROWSER_TICKET_PATH]: async (req, res) => {
      const target = await readSessionBody(req, res, deps);
      if (!target) return;
      const client = parseClientId(target.body.client);
      if (client === null) return sendError(res, 400, 'bad-client', 'client must be 1-64 letters, digits, _ or -');
      sendJson(res, 200, { ok: true, data: { ticket: tickets.mint(target.sessionId, client) } }, { 'Cache-Control': 'no-store' });
    },

    [BROWSER_TAKEOVER_PATH]: async (req, res) => {
      const target = await readSessionBody(req, res, deps);
      if (!target) return;
      const on = target.body.on;
      if (typeof on !== 'boolean') return sendError(res, 400, 'bad-on', 'on must be a boolean');
      const client = parseClientId(target.body.client);
      // A takeover is held by a window, so taking one needs to say which.
      if (client === null || (on && client === '')) {
        return sendError(res, 400, 'bad-client', 'client must be 1-64 letters, digits, _ or -');
      }
      await deps.setTakeover(target.sessionId, on);
      if (on) watch.begin(target.sessionId, client);
      else watch.end(target.sessionId);
      log.info(`browser ${on ? 'taken over' : 'handed back'}: ${target.sessionId}`);
      announce(target.sessionId);
      sendJson(res, 200, { ok: true, data: { takenOver: deps.isTakenOver(target.sessionId) } });
    },

    [BROWSER_INSERT_TEXT_PATH]: async (req, res) => {
      const target = await readSessionBody(req, res, deps);
      if (!target) return;
      const text = typeof target.body.text === 'string' ? target.body.text : '';
      if (!text) return sendError(res, 400, 'missing-text', 'text is required');
      if (text.length > MAX_INSERT_TEXT_CHARS) {
        return sendError(res, 400, 'text-too-long', `text exceeds ${MAX_INSERT_TEXT_CHARS} characters`);
      }
      // Typing into the page is the person's move, so it needs the page to be theirs.
      if (!deps.isTakenOver(target.sessionId)) return sendError(res, 409, 'not-taken-over', 'Take over the browser first');
      watch.input(target.sessionId);
      try {
        await deps.insertText(target.sessionId, text);
      } catch (err) {
        return sendError(res, 502, 'insert-failed', (err as Error).message);
      }
      sendJson(res, 200, { ok: true, data: {} });
    },
  };

  const attach = async (viewer: Viewer, target: StreamTarget): Promise<void> => {
    const { ws } = viewer;
    let port: number | null = null;
    try {
      port = await deps.streamPort(target.sessionId);
    } catch (err) {
      log.warn(`stream port lookup failed for ${target.sessionId}: ${(err as Error).message}`);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (port === null) {
      ws.close(CLOSE_NO_STREAM, 'no stream');
      return;
    }
    // Ack pacing end to end: the app acks each frame once drawn, so a slow tunnel holds one frame in
    // flight instead of a queue of stale ones.
    const upstream = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=${target.fps}&pacing=ack`, {
      handshakeTimeout: UPSTREAM_CONNECT_TIMEOUT_MS,
    });
    let opened = false;
    const finish = (code: number, reason: string): void => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
    };
    upstream.on('open', () => {
      opened = true;
    });
    upstream.on('message', (data: RawData, isBinary: boolean) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_DOWNSTREAM_BUFFER) return;
      ws.send(data, { binary: isBinary });
    });
    upstream.on('close', () => finish(opened ? CLOSE_UPSTREAM_GONE : CLOSE_NO_STREAM, opened ? 'stream ended' : 'no stream'));
    upstream.on('error', (err) => {
      log.warn(`upstream stream error for ${target.sessionId}: ${err.message}`);
      finish(opened ? CLOSE_UPSTREAM_GONE : CLOSE_NO_STREAM, opened ? 'stream ended' : 'no stream');
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary || upstream.readyState !== WebSocket.OPEN) return;
      const admitted = admitClientMessage(data.toString(), holdsPage(viewer));
      if (!admitted) return;
      if (admitted.input) watch.input(target.sessionId);
      upstream.send(admitted.message);
    });
    ws.on('close', () => finish(1000, 'viewer closed'));
  };

  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const target = parseStreamTarget(req.url ?? '');
    const redeemed = target ? tickets.redeem(target.ticket, target.sessionId) : null;
    if (!target || !redeemed) {
      log.warn('browser stream refused: missing or invalid ticket');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (live.size >= MAX_STREAMS) {
      log.warn(`browser stream refused (${live.size} already open)`);
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const viewer: Viewer = { ws, sessionId: target.sessionId, client: redeemed.client };
      live.add(viewer);
      watch.connected(viewer.sessionId, viewer.client);
      ws.on('close', () => {
        live.delete(viewer);
        watch.disconnected(viewer.sessionId, viewer.client);
      });
      ws.on('error', () => ws.terminate());
      // Before any frame: whether this window may steer the page.
      ws.send(JSON.stringify({ type: TAKEOVER_MESSAGE, takenOver: deps.isTakenOver(viewer.sessionId), mine: holdsPage(viewer) }));
      void attach(viewer, target);
    });
  };

  const close = (): void => {
    watch.close();
    for (const viewer of live) viewer.ws.terminate();
    live.clear();
    wss.close();
  };

  return { routes, handleUpgrade, close };
}
