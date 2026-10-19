import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { Duplex } from 'stream';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import type { AnyRouter } from '@trpc/server';
import { AUTH_HEADER, timingSafeEqualStr } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { contentTypeHeader, mimeTypeForPath } from '@core/media-types.js';
import type { AccessJwtVerifier } from './access-jwt.js';
import { sendError } from './http-json.js';
import { FORWARD_PATH, createPortForward } from './port-forward.js';
import { sessionIdFrom } from './ui-auth-routes.js';

const log = createLogger('ui-http');

/** Header carrying the Cloudflare Access assertion JWT the edge injects (lowercased by Node). */
const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/** tRPC is mounted under this base path (matches the web client `httpBatchLink({ url: '/trpc' })`). */
const TRPC_BASE_PATH = '/trpc/';

/** CORS headers emitted for both preflight and regular responses from an allowed origin. */
const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';
// `x-session-id` / `x-file-name` are the custom headers the file-upload route reads; the app's
// upload is cross-origin (webview `cortexui://localhost` → server), so its CORS preflight fails
// unless these are allow-listed alongside the auth token and content-type.
const CORS_ALLOW_HEADERS = `${AUTH_HEADER}, content-type, x-session-id, x-file-name`;
const CORS_MAX_AGE = '86400'; // 24 h preflight cache

/**
 * Largest tRPC request body. The big legitimate payloads are a pasted message (`sessions.send`,
 * unbounded in the schema) and a skill file (512 KB); a message past this is several times any
 * model's context window. Files never travel here — they go through the upload route.
 */
const TRPC_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Methods that never change state. Everything else is checked against the request's Origin. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface UiHttpServerOptions {
  /** The tRPC router to host (query/mutate/subscribe). Injected — kept generic over AnyRouter. */
  router: AnyRouter;
  /** Accessor for the bearer token the server accepts (wiring passes getClientToken). */
  getToken: () => string;
  /** TCP port to listen on (0 = ephemeral, useful in tests). */
  port: number;
  /** Host to bind. Defaults to 127.0.0.1 (loopback only — exposure is via a tunnel). */
  host?: string;
  /** Directory of the built SPA to serve for non-tRPC paths. When absent/missing → 404 stub. */
  spaDir?: string;
  /**
   * Explicit allow-list of origins permitted for cross-origin tRPC requests.
   * Designed for the Tauri desktop webview (e.g. `tauri://localhost`) that connects
   * directly to a remote server without a same-origin proxy. When present, a matching
   * `Origin` request header causes `Access-Control-Allow-Origin` to be echoed back
   * (non-wildcard). OPTIONS preflight is answered 204 with CORS headers (no auth required).
   * When absent or empty, no CORS headers are emitted — backward-compatible default.
   */
  corsOrigins?: string[] | (() => string[] | undefined);
  /**
   * Optional map of custom API route paths to handlers (for non-tRPC endpoints like
   * file upload). Auth-gated with the same dual-path check as tRPC paths.
   */
  customRoutes?: Record<string, CustomRouteHandler>;
  /**
   * Custom-route paths served WITHOUT the auth gate. Only the login and session-probe routes belong
   * here: a browser that holds no credential yet must be able to reach them, and each answers with
   * nothing more than a boolean or a 401.
   */
  publicRoutes?: string[];
  /**
   * The gate predicate for tRPC and custom routes, built with createAuthorizer. The caller builds
   * it (rather than this server) so the public /api/ui/session probe can answer with the exact
   * predicate the gate uses, instead of a second copy that could drift.
   */
  authorize: Authorizer;
  /**
   * Mount the TCP-over-WebSocket port forward on `/forward` (desktop shell → a loopback service on
   * this host). Defaults to on; `CORTEX_PORT_FORWARD=0` at the call site turns it off.
   */
  portForward?: boolean;
  /**
   * WebSocket endpoints beyond the port forward, by exact path. Each authenticates its own handshake
   * (a page cannot set `x-cortex-token` on one); the server only applies the Origin check first, the
   * same one every state-changing request gets, and closes each route on shutdown.
   */
  upgradeRoutes?: Record<string, UpgradeRoute>;
}

/** A WebSocket endpoint mounted on the server's `upgrade` event. */
export interface UpgradeRoute {
  handleUpgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => void;
}

/** Handler for a custom API route mounted on the HTTP server. Receives the raw request
 *  and response after the auth gate passes; responsible for the full lifecycle
 *  (parse, respond, error-handle). */
export type CustomRouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export interface UiHttpServer {
  server: http.Server;
  close: () => Promise<void>;
}

/** Bearer gate for a tRPC request: constant-time compare of the accepted token vs the header. */
function isAuthorized(req: http.IncomingMessage, getToken: () => string): boolean {
  const provided = req.headers[AUTH_HEADER];
  const headerVal = Array.isArray(provided) ? provided[0] : provided;
  return timingSafeEqualStr(getToken(), headerVal);
}

/**
 * Cloudflare Access path: verify the `Cf-Access-Jwt-Assertion` JWT the edge injects. Returns false
 * when no verifier is configured, the header is absent, or verification fails — so this leg only
 * ever admits a genuinely valid Access assertion.
 */
async function isAccessAuthorized(
  req: http.IncomingMessage,
  verifyAccessJwt: AccessJwtVerifier | undefined,
): Promise<boolean> {
  if (!verifyAccessJwt) return false;
  const provided = req.headers[ACCESS_JWT_HEADER];
  const jwt = Array.isArray(provided) ? provided[0] : provided;
  if (!jwt) return false;
  return verifyAccessJwt(jwt);
}

/** Decides whether one request may pass the gate. Async only because the JWT leg is. */
export type Authorizer = (req: http.IncomingMessage) => Promise<boolean>;

/**
 * Build the gate predicate: **token → session cookie → Access JWT**, first match wins.
 *
 * The order is load-bearing. The token leg is synchronous and unchanged, so the desktop/machine
 * path never pays an await; the cookie leg is a synchronous in-memory check; only the JWT leg —
 * which may touch a remote JWKS — can suspend. An unconfigured leg is simply absent, so a
 * deployment that enables neither browser path degrades to token-only exactly as before.
 */
export function createAuthorizer(opts: {
  getToken: () => string;
  verifySession?: (sid: string | undefined) => boolean;
  verifyAccessJwt?: AccessJwtVerifier;
}): Authorizer {
  return async (req) => {
    if (isAuthorized(req, opts.getToken)) return true;
    if (opts.verifySession?.(sessionIdFrom(req))) return true;
    return isAccessAuthorized(req, opts.verifyAccessJwt);
  };
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * CSRF guard for a state-changing request. A browser page always sends `Origin` on one, and it
 * must be this server's own origin (the SPA) or one in the CORS allow-list (the native shells'
 * `cortexui` pages). SameSite cookies alone are not enough: every subdomain of a shared parent
 * domain is "same site", and the Cloudflare Access assertion rides along regardless. A request
 * with no `Origin` at all (CLI, cortex-signal, a device, the shells' native side) is not a page
 * acting on someone's cookie and is left to the auth gate. `Origin: null` (sandboxed frames,
 * opaque documents) is refused.
 */
function isTrustedOrigin(req: http.IncomingMessage, allowList: readonly string[] | undefined): boolean {
  const origin = firstHeader(req.headers.origin);
  if (origin === undefined) return true;
  if (allowList?.includes(origin)) return true;
  try {
    return new URL(origin).host === firstHeader(req.headers.host);
  } catch {
    return false;
  }
}

/**
 * If the request `Origin` is in the allow-list, add CORS headers to `res` via `setHeader`.
 * Using `setHeader` (not `writeHead`) ensures the headers survive any downstream `writeHead` call
 * that sets its own headers — Node.js merges `setHeader` values with `writeHead` headers, and
 * `writeHead` only overrides the same-name entries. Returns the matched origin (or undefined).
 */
function applyCorsHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowList: readonly string[] | undefined,
): string | undefined {
  if (!allowList || allowList.length === 0) return undefined;
  const origin = firstHeader(req.headers.origin);
  if (!origin || !allowList.includes(origin)) return undefined;

  // Non-wildcard: echo the exact origin so the response is origin-specific and cacheable.
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  res.setHeader('Access-Control-Max-Age', CORS_MAX_AGE);
  return origin;
}

/**
 * SPA static serving. For a non-tRPC path:
 *  - no spaDir / missing dir  → 404 plain-text placeholder.
 *  - spaDir present           → serve an existing file under it (path-traversal safe); otherwise
 *    fall back to index.html (SPA client-side routing); if index.html is absent → 404.
 */
function serveSpaStub(req: http.IncomingMessage, res: http.ServerResponse, spaDir?: string): void {
  if (!spaDir || !fs.existsSync(spaDir)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Cortex UI not built');
    return;
  }

  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    // Malformed percent-encoding (e.g. `/%FF`) throws URIError — reject, never crash the process.
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  const root = path.resolve(spaDir);
  const requested = path.resolve(root, '.' + (urlPath === '/' ? '/index.html' : urlPath));

  // Path-traversal guard: the resolved target must stay inside the SPA root.
  if (requested !== root && !requested.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const indexPath = path.join(root, 'index.html');
  const target = fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : indexPath;
  if (!fs.existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const stream = fs.createReadStream(target);
  // A file removed between existsSync and read would emit 'error' — end the response, never crash.
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end();
  });
  res.writeHead(200, { 'Content-Type': contentTypeHeader(mimeTypeForPath(target)) });
  stream.pipe(res);
}

/**
 * Build (but do not stop) an HTTP server exposing the injected tRPC router over HTTP+SSE behind
 * the dual-path auth gate (x-cortex-token OR a verified Cf-Access-Jwt-Assertion), plus the SPA
 * static server. The server is already listening when this returns. Call `close()` for a clean
 * shutdown (force-closes live SSE sockets).
 *
 * CORS: if `corsOrigins` is provided, a matching `Origin` header causes non-wildcard CORS headers
 * to be set on all responses (including 401s, so the browser can read the error body). OPTIONS
 * preflight for tRPC paths is answered 204 without requiring the auth token — the token is the
 * header being pre-flighted.
 */
export function createUiHttpServer(opts: UiHttpServerOptions): UiHttpServer {
  const host = opts.host ?? '127.0.0.1';
  const authorize = opts.authorize;
  const publicRoutes = new Set(opts.publicRoutes ?? []);

  const server = createHTTPServer({
    router: opts.router,
    basePath: TRPC_BASE_PATH,
    createContext: () => ({}),
    maxBodySize: TRPC_MAX_BODY_BYTES,
    // Runs BEFORE the tRPC handler. tRPC paths are auth-gated here; everything else is the SPA stub.
    middleware: async (req, res, next) => {
      const url = req.url ?? '/';

      // ── CORS ──────────────────────────────────────────────────────────────────
      // Apply headers early so they survive all downstream writeHead/write calls.
      // Node.js merges setHeader entries with any explicit headers map passed to
      // writeHead later — the ACAO header we set here will appear on 200, 401, and 204.
      const allowList = typeof opts.corsOrigins === 'function' ? opts.corsOrigins() : opts.corsOrigins;
      applyCorsHeaders(req, res, allowList);

      // ── CORS preflight ────────────────────────────────────────────────────────
      // OPTIONS for a tRPC path is answered 204 here WITHOUT an auth check.
      // The browser sends the preflight BEFORE attaching x-cortex-token to learn
      // whether the server allows it — requiring the token on the preflight itself
      // would create a bootstrapping impossibility.
      // Match custom routes on the PATHNAME (query string stripped) so routes that take query
      // params (e.g. /api/files/download?path=…) still resolve. Exact-path routes (upload, OTA)
      // are unaffected — they carry no query.
      const pathname = url.split('?')[0];
      const isCustomRoute = !!(opts.customRoutes && pathname in opts.customRoutes);
      if (req.method === 'OPTIONS' && (url.startsWith(TRPC_BASE_PATH) || isCustomRoute)) {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── CSRF ──────────────────────────────────────────────────────────────────
      // Before the gate, so a cross-site page cannot even probe whether a credential rides along.
      const isApi = isCustomRoute || url.startsWith(TRPC_BASE_PATH);
      if (isApi && !SAFE_METHODS.has(req.method ?? 'GET') && !isTrustedOrigin(req, allowList)) {
        log.warn(`ui-http cross-origin request refused: ${req.method} ${pathname} from ${firstHeader(req.headers.origin)}`);
        sendError(res, 403, 'cross-origin', 'Cross-origin request refused');
        return;
      }

      // ── Custom API routes ─────────────────────────────────────────────────────
      // Auth-gated non-tRPC endpoints (e.g. file upload). Handled BEFORE tRPC so
      // custom routes can shadow tRPC base-path prefixes if needed.
      if (isCustomRoute) {
        // The login / session-probe routes run the gate themselves (or need no credential at all),
        // so they are reached before the check rather than through it.
        const authorized = publicRoutes.has(pathname) || (await authorize(req));
        if (!authorized) {
          log.warn(`ui-http auth rejected (custom route): ${req.method} ${url}`);
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Unauthorized');
          return;
        }
        try {
          await opts.customRoutes![pathname](req, res);
        } catch (e) {
          log.error(`Custom route ${url} error:`, (e as Error).message);
          sendError(res, 500, 'internal', 'Internal server error');
        }
        return;
      }

      // ── tRPC paths ────────────────────────────────────────────────────────────
      // Triple-path auth: a matching x-cortex-token (desktop/machine — checked first, synchronous,
      // so that path is byte-for-byte unchanged and never awaits) OR a live session cookie (the
      // token-login browser path) OR a valid Cf-Access-Jwt-Assertion (Cloudflare Access — the other
      // browser path). None → 401.
      if (url.startsWith(TRPC_BASE_PATH)) {
        const authorized = await authorize(req);
        if (!authorized) {
          log.warn(`ui-http auth rejected: ${req.method} ${url}`);
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Unauthorized');
          return;
        }
        next();
        return;
      }

      // ── Non-tRPC (SPA static files) ───────────────────────────────────────────
      serveSpaStub(req, res, opts.spaDir);
    },
  });

  // ── Port forward (upgrade path) ─────────────────────────────────────────────
  // Deliberately TOKEN-ONLY: neither browser leg is accepted here. A browser page riding an Access
  // SSO cookie — or our own `cortex_ui` session cookie — must never be able to open a raw TCP
  // forward, and only a native client can set `x-cortex-token` on a WebSocket handshake anyway.
  // Note that a browser WOULD attach the session cookie to this handshake automatically: calling
  // `authorize(req)` here instead of `isAuthorized` would silently hand every logged-in page a raw
  // socket to any loopback service on this host. See plan/embedded-browser.md §10.
  const forward = opts.portForward === false ? null : createPortForward();
  const upgradeRoutes = opts.upgradeRoutes ?? {};
  if (forward || Object.keys(upgradeRoutes).length > 0) {
    server.on('upgrade', (req, socket, head) => {
      const pathname = (req.url ?? '').split('?')[0];
      if (forward && pathname === FORWARD_PATH) {
        if (!isAuthorized(req, opts.getToken)) {
          log.warn(`forward auth rejected: ${req.url}`);
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        forward.handleUpgrade(req, socket, head);
        return;
      }
      const route = Object.hasOwn(upgradeRoutes, pathname) ? upgradeRoutes[pathname] : undefined;
      if (!route) {
        socket.destroy();
        return;
      }
      // A handshake carries cookies like any request, so a foreign page is refused before the route
      // ever sees it.
      const allowList = typeof opts.corsOrigins === 'function' ? opts.corsOrigins() : opts.corsOrigins;
      if (!isTrustedOrigin(req, allowList)) {
        log.warn(`ui-http cross-origin upgrade refused: ${pathname} from ${firstHeader(req.headers.origin)}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      route.handleUpgrade(req, socket, head as Buffer);
    });
  }

  server.listen(opts.port, host, () => {
    const addr = server.address();
    const boundPort = addr && typeof addr !== 'string' ? addr.port : opts.port;
    log.info(`Listening on ${host}:${boundPort}${TRPC_BASE_PATH}`);
  });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      forward?.close();
      for (const route of Object.values(upgradeRoutes)) route.close();
      // Force-close keep-alive + live SSE sockets, else server.close() would hang on them.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

  return { server, close };
}
