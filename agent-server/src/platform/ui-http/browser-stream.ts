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
 * input passes only while the person holds the page, so a watcher can never steer it by accident.
 * Everything else (a `config` raising the frame rate, unknown types) is dropped.
 */
export function admitClientMessage(raw: string, takenOver: boolean): string | null {
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
    return typeof seq === 'number' && Number.isFinite(seq) ? JSON.stringify({ type: 'ack', seq }) : null;
  }
  if (typeof type === 'string' && INPUT_TYPES.has(type)) return takenOver ? raw : null;
  return null;
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
  mint: (sessionId: string) => string;
  /** Spend a ticket. True only for a live ticket minted for this very session. */
  redeem: (ticket: string, sessionId: string) => boolean;
  size: () => number;
}

export function createTicketStore(now: () => number = Date.now): TicketStore {
  const tickets = new Map<string, { sessionId: string; expiresAt: number }>();
  const prune = (): void => {
    const t = now();
    for (const [id, entry] of tickets) if (entry.expiresAt <= t) tickets.delete(id);
  };
  return {
    mint(sessionId) {
      prune();
      // A burst past the cap drops the oldest: a ticket is cheap to ask for again.
      while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
      const id = crypto.randomBytes(32).toString('hex');
      tickets.set(id, { sessionId, expiresAt: now() + TICKET_TTL_MS });
      return id;
    },
    // A constant-time walk rather than a Map lookup, as the UI session store does: the ticket is a
    // credential for a few seconds, and the set is a handful of entries.
    redeem(ticket, sessionId) {
      prune();
      let hit: string | null = null;
      for (const id of tickets.keys()) if (timingSafeEqualStr(id, ticket)) hit = id;
      if (hit === null) return false;
      const entry = tickets.get(hit)!;
      tickets.delete(hit);
      return entry.sessionId === sessionId;
    },
    size: () => {
      prune();
      return tickets.size;
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

export function createBrowserStream(deps: BrowserStreamDeps): BrowserStreamHandle {
  const tickets = createTicketStore(deps.now);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  const live = new Set<WebSocket>();

  const routes: Record<string, CustomRouteHandler> = {
    [BROWSER_SESSIONS_PATH]: async (req, res) => {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
      sendJson(res, 200, { ok: true, data: { sessions: deps.listSessions().map(publicView) } }, { 'Cache-Control': 'no-store' });
    },

    [BROWSER_TICKET_PATH]: async (req, res) => {
      const target = await readSessionBody(req, res, deps);
      if (!target) return;
      sendJson(res, 200, { ok: true, data: { ticket: tickets.mint(target.sessionId) } }, { 'Cache-Control': 'no-store' });
    },

    [BROWSER_TAKEOVER_PATH]: async (req, res) => {
      const target = await readSessionBody(req, res, deps);
      if (!target) return;
      if (typeof target.body.on !== 'boolean') return sendError(res, 400, 'bad-on', 'on must be a boolean');
      await deps.setTakeover(target.sessionId, target.body.on);
      log.info(`browser ${target.body.on ? 'taken over' : 'handed back'}: ${target.sessionId}`);
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
      try {
        await deps.insertText(target.sessionId, text);
      } catch (err) {
        return sendError(res, 502, 'insert-failed', (err as Error).message);
      }
      sendJson(res, 200, { ok: true, data: {} });
    },
  };

  const attach = async (ws: WebSocket, target: StreamTarget): Promise<void> => {
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
      const admitted = admitClientMessage(data.toString(), deps.isTakenOver(target.sessionId));
      if (admitted !== null) upstream.send(admitted);
    });
    ws.on('close', () => finish(1000, 'viewer closed'));
  };

  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const target = parseStreamTarget(req.url ?? '');
    if (!target || !tickets.redeem(target.ticket, target.sessionId)) {
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
      live.add(ws);
      ws.on('close', () => live.delete(ws));
      ws.on('error', () => ws.terminate());
      void attach(ws, target);
    });
  };

  const close = (): void => {
    for (const ws of live) ws.terminate();
    live.clear();
    wss.close();
  };

  return { routes, handleUpgrade, close };
}
