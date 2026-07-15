// input:  an AnyRouter (injected) + a token accessor + optional Access-JWT verifier + core/auth +
//          @trpc/server standalone adapter
// output: createUiHttpServer({ router, getToken, port, host?, spaDir?, corsOrigins?, verifyAccessJwt? }) -> { server, close() }
// pos:    Web UI transport-host, in-core (agent-server platform/ui-http). Mounts the injected tRPC
//         router on the standalone HTTP adapter (query/mutate over HTTP, subscription over SSE —
//         tRPC v11), gated by a DUAL-PATH auth check BEFORE tRPC, and serves the built SPA static
//         files for non-tRPC paths. Generic over AnyRouter — the concrete AppRouter is injected by
//         start-ui-http.ts, keeping this file router-agnostic. Bound 127.0.0.1 by default. Reads
//         AUTH_HEADER / timingSafeEqualStr and createLogger from the core package's built dist.
//         Auth gate: (1) a matching x-cortex-token (desktop/machine clients — byte-for-byte the
//         prior behaviour, checked first, synchronous) OR (2) a validly-signed Cf-Access-Jwt-Assertion
//         (Cloudflare Access JWT — the browser path; verified via the injected verifyAccessJwt).
//         Neither/invalid → 401. When no verifier is injected, only the token path is live.
//         CORS allow-list: optional corsOrigins[] lets the Tauri desktop webview (cross-origin,
//         e.g. tauri://localhost) reach tRPC endpoints directly without a proxy. Non-wildcard only
//         — the origin is echoed verbatim when it's in the allow-list.
// >>> If I am updated, update CORTEX.md <<<

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import type { AnyRouter } from '@trpc/server';
import { AUTH_HEADER, timingSafeEqualStr } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import type { AccessJwtVerifier } from './access-jwt.js';

const log = createLogger('ui-http');

/** Header carrying the Cloudflare Access assertion JWT the edge injects (lowercased by Node). */
const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/** tRPC is mounted under this base path (matches the web client `httpBatchLink({ url: '/trpc' })`). */
const TRPC_BASE_PATH = '/trpc/';

/** CORS headers emitted for both preflight and regular responses from an allowed origin. */
const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';
const CORS_ALLOW_HEADERS = `${AUTH_HEADER}, content-type`;
const CORS_MAX_AGE = '86400'; // 24 h preflight cache

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
  corsOrigins?: string[];
  /**
   * Optional Cloudflare Access JWT verifier. When present, a request that fails the x-cortex-token
   * check is admitted if it carries a valid `Cf-Access-Jwt-Assertion` (signature/aud/iss/exp all
   * pass). When absent, only the token path is live — the browser (Access) path is disabled, so an
   * unconfigured Access deployment degrades to token-only rather than admitting requests.
   */
  verifyAccessJwt?: AccessJwtVerifier;
  /**
   * Optional map of custom API route paths to handlers (for non-tRPC endpoints like
   * file upload). Auth-gated with the same dual-path check as tRPC paths.
   */
  customRoutes?: Record<string, CustomRouteHandler>;
}

/** Handler for a custom API route mounted on the HTTP server. Receives the raw request
 *  and response after the auth gate passes; responsible for the full lifecycle
 *  (parse, respond, error-handle). */
export type CustomRouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export interface UiHttpServer {
  server: http.Server;
  close: () => Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

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

/**
 * If the request `Origin` is in the allow-list, add CORS headers to `res` via `setHeader`.
 * Using `setHeader` (not `writeHead`) ensures the headers survive any downstream `writeHead` call
 * that sets its own headers — Node.js merges `setHeader` values with `writeHead` headers, and
 * `writeHead` only overrides the same-name entries. Returns the matched origin (or undefined).
 */
function applyCorsHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsOrigins: string[] | undefined,
): string | undefined {
  if (!corsOrigins || corsOrigins.length === 0) return undefined;
  const origin = Array.isArray(req.headers['origin'])
    ? req.headers['origin'][0]
    : req.headers['origin'];
  if (!origin || !corsOrigins.includes(origin)) return undefined;

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

  const ext = path.extname(target).toLowerCase();
  const stream = fs.createReadStream(target);
  // A file removed between existsSync and read would emit 'error' — end the response, never crash.
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end();
  });
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
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

  const server = createHTTPServer({
    router: opts.router,
    basePath: TRPC_BASE_PATH,
    createContext: () => ({}),
    // Runs BEFORE the tRPC handler. tRPC paths are auth-gated here; everything else is the SPA stub.
    middleware: async (req, res, next) => {
      const url = req.url ?? '/';

      // ── CORS ──────────────────────────────────────────────────────────────────
      // Apply headers early so they survive all downstream writeHead/write calls.
      // Node.js merges setHeader entries with any explicit headers map passed to
      // writeHead later — the ACAO header we set here will appear on 200, 401, and 204.
      applyCorsHeaders(req, res, opts.corsOrigins);

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

      // ── Custom API routes ─────────────────────────────────────────────────────
      // Auth-gated non-tRPC endpoints (e.g. file upload). Handled BEFORE tRPC so
      // custom routes can shadow tRPC base-path prefixes if needed.
      if (isCustomRoute) {
        const authorized =
          isAuthorized(req, opts.getToken) || (await isAccessAuthorized(req, opts.verifyAccessJwt));
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
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, code: 'internal', message: 'Internal server error' }));
          }
        }
        return;
      }

      // ── tRPC paths ────────────────────────────────────────────────────────────
      // Dual-path auth: a matching x-cortex-token (desktop/machine — checked first, synchronous, so
      // that path is byte-for-byte unchanged and never awaits) OR a valid Cf-Access-Jwt-Assertion
      // (Cloudflare Access — the browser path). Neither → 401.
      if (url.startsWith(TRPC_BASE_PATH)) {
        const authorized =
          isAuthorized(req, opts.getToken) || (await isAccessAuthorized(req, opts.verifyAccessJwt));
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

  server.listen(opts.port, host, () => {
    const addr = server.address();
    const boundPort = addr && typeof addr !== 'string' ? addr.port : opts.port;
    log.info(`Listening on ${host}:${boundPort}${TRPC_BASE_PATH}`);
  });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      // Force-close keep-alive + live SSE sockets, else server.close() would hang on them.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

  return { server, close };
}
