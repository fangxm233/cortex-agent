import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { AUTH_HEADER, timingSafeEqualStr } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { TUI_PATH } from '@core/main-port.js';

const log = createLogger('main-http');

export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
export type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;

/** The Web UI: every request that is not a webhook, and the upgrade paths it owns. */
export interface UiMount {
  handleRequest: RequestHandler;
  /** False when the path is not the UI's; the socket is then untouched. */
  handleUpgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => void;
}

export interface MainHttpServerOptions {
  /** 0 picks an ephemeral port (tests). */
  port: number;
  host: string;
  /** The cortex-client token, which the TUI socket also requires. */
  getClientToken: () => string;
}

export interface MainHttpServer {
  readonly server: http.Server;
  mountWebhook(handler: RequestHandler): void;
  mountUi(ui: UiMount): void;
  mountTui(handler: UpgradeHandler): void;
  /** cortex-client: `/client`, `/reverse`, and any upgrade path nothing else claims. */
  mountClient(handler: UpgradeHandler): void;
  /** Resolves with the bound port; rejects with the listen error (EADDRINUSE, EACCES, …). */
  listen(): Promise<number>;
  close(): Promise<void>;
}

interface Mounts {
  webhook?: RequestHandler;
  ui?: UiMount;
  tui?: UpgradeHandler;
  client?: UpgradeHandler;
}

const WEBHOOK_PREFIXES = ['/webhook/', '/hook/'];

/**
 * Headers a reverse proxy or tunnel adds. cloudflared, Tailscale serve and the usual proxies reach
 * this server from loopback, so the peer address alone would let a tunnelled request through.
 */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'];

function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0];
}

function isLoopbackAddress(address: string | undefined): boolean {
  return !!address && (address === '::1' || /^(::ffff:)?127\./.test(address));
}

/** A request made on this machine directly: loopback peer, and not relayed by a proxy or tunnel. */
export function isLocalRequest(req: http.IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  return !FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** No `Origin` (a native client), or one naming this server itself. */
function isSameOrigin(req: http.IncomingMessage): boolean {
  const origin = firstHeader(req.headers.origin);
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === firstHeader(req.headers.host);
  } catch {
    return false;
  }
}

function reply(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function refuseUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

/**
 * Webhook routes serve this machine's own processes (hooks, MCP sidecars, cortex-signal). The UI
 * shares the port and is commonly tunnelled, so they are refused for anything not made locally,
 * before the route's own token check.
 */
function serveWebhook(req: http.IncomingMessage, res: http.ServerResponse, handler: RequestHandler | undefined): void {
  if (!isLocalRequest(req)) {
    log.warn(`webhook refused from ${req.socket?.remoteAddress ?? 'unknown'}: ${req.method} ${pathOf(req.url)}`);
    reply(res, 403, 'Forbidden');
    return;
  }
  if (!handler) { reply(res, 503, 'Starting'); return; }
  handler(req, res);
}

function serveRequest(mounts: Mounts, req: http.IncomingMessage, res: http.ServerResponse): void {
  const pathname = pathOf(req.url);
  if (WEBHOOK_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return serveWebhook(req, res, mounts.webhook);
  if (mounts.ui) return mounts.ui.handleRequest(req, res);
  reply(res, 404, 'Not found');
}

/** The TUI takes the client token and refuses any page but this server's own. */
function upgradeTui(req: http.IncomingMessage, socket: Duplex, head: Buffer, mounts: Mounts, getToken: () => string): void {
  if (!mounts.tui) return refuseUpgrade(socket, '404 Not Found');
  if (!timingSafeEqualStr(getToken(), firstHeader(req.headers[AUTH_HEADER]))) {
    log.warn(`tui auth rejected from ${req.socket?.remoteAddress ?? 'unknown'}`);
    return refuseUpgrade(socket, '401 Unauthorized');
  }
  if (!isSameOrigin(req)) {
    log.warn(`tui cross-origin upgrade refused from ${firstHeader(req.headers.origin)}`);
    return refuseUpgrade(socket, '403 Forbidden');
  }
  mounts.tui(req, socket, head);
}

/**
 * The UI's own paths first (`/forward`, the browser stream), then `/tui`. Everything else is
 * cortex-client — `/client`, the `/reverse` callback, and the root path existing `wss://host`
 * client configs dial — which authenticates with the client token itself.
 */
function serveUpgrade(mounts: Mounts, getToken: () => string, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  if (mounts.ui?.handleUpgrade(req, socket, head)) return;
  if (pathOf(req.url) === TUI_PATH) return upgradeTui(req, socket, head, mounts, getToken);
  if (!mounts.client) return refuseUpgrade(socket, '503 Service Unavailable');
  mounts.client(req, socket, head);
}

function listenOn(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * The instance's one HTTP server. Nothing is served until a part is mounted: a webhook route
 * answers 503 and a client upgrade is refused until theirs are, and without a UI every other
 * request is a 404.
 */
export function createMainHttpServer(opts: MainHttpServerOptions): MainHttpServer {
  const mounts: Mounts = {};
  const server = http.createServer((req, res) => serveRequest(mounts, req, res));
  server.on('upgrade', (req, socket, head) => serveUpgrade(mounts, opts.getClientToken, req, socket, head as Buffer));
  server.on('error', (error) => log.error(`main server error: ${error.message}`));
  return {
    server,
    mountWebhook: (handler) => { mounts.webhook = handler; },
    mountUi: (ui) => { mounts.ui = ui; },
    mountTui: (handler) => { mounts.tui = handler; },
    mountClient: (handler) => { mounts.client = handler; },
    listen: () => listenOn(server, opts.port, opts.host),
    close: () => new Promise<void>((resolve) => {
      mounts.ui?.close();
      // Force-close keep-alive and live SSE sockets, else close() would wait on them.
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
