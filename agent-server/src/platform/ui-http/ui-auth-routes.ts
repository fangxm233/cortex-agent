// input:  a UiSessionStore, the accepted clientToken, and the gate's own authorize() predicate
// output: createUiAuthRoutes(...) -> { '/api/ui/login', '/api/ui/logout', '/api/ui/session' }
//         plus UI_LOGIN_PATH / UI_LOGOUT_PATH / UI_SESSION_PATH / UI_SESSION_COOKIE
// pos:    Token-login leg of the Web UI auth gate (platform/ui-http). A browser posts the
//         clientToken ONCE to /api/ui/login; on a constant-time match the server mints a session
//         and returns it in an HttpOnly cookie, so the secret never lives in the page. Every later
//         request rides the cookie (see ui-http-server.ts), with exactly the authority of the
//         Cloudflare Access JWT leg — and, like that leg, it is NOT accepted on the /forward
//         WebSocket upgrade, which stays token-only.
//
//         /api/ui/login and /api/ui/session are the only PUBLIC routes on this server (they must be
//         reachable by a browser that has nothing yet). /api/ui/logout sits behind the gate.

import type * as http from 'http';
import { timingSafeEqualStr } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { parseCookie, type UiSessionStore } from './ui-session.js';

const log = createLogger('ui-http');

/** Cookie carrying the opaque session id. Name is stable — the SPA never reads it (HttpOnly). */
export const UI_SESSION_COOKIE = 'cortex_ui';

export const UI_LOGIN_PATH = '/api/ui/login';
export const UI_LOGOUT_PATH = '/api/ui/logout';
export const UI_SESSION_PATH = '/api/ui/session';

/**
 * Fixed delay on every failed login. Deliberately NOT an IP ban or a lockout: behind a tunnel every
 * request arrives from 127.0.0.1 so per-IP counting is meaningless, and a global lockout would hand
 * anyone a way to lock the owner out. The token is 32 random bytes (core/auth.ts), so a fixed delay
 * is already enough to make online guessing hopeless.
 */
export const LOGIN_FAILURE_DELAY_MS = 250;

/** Max login body we will read. The body is one short field. */
const MAX_BODY_BYTES = 8192;

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export interface UiAuthRouteDeps {
  /** Live session store. */
  store: UiSessionStore;
  /** Accessor for the accepted clientToken (same one the header gate compares against). */
  getToken: () => string;
  /** The gate's own predicate — used by the public /api/ui/session probe so the SPA's answer and
   *  the gate's answer can never disagree. */
  authorize: (req: http.IncomingMessage) => Promise<boolean>;
  /** Session lifetime, mirrored into the cookie's Max-Age. */
  ttlMs: number;
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * CSRF guard for the credential POST: a cross-site form/fetch carries an `Origin` that is not our
 * own host, and we refuse it. A request with no `Origin` at all (curl, a native client) is allowed
 * — those are not browsers and are not what CSRF is about. Combined with SameSite=Strict on the
 * cookie itself, a hostile page can neither mint a session nor ride an existing one.
 */
export function isSameOrigin(req: http.IncomingMessage): boolean {
  const origin = firstHeader(req.headers.origin);
  if (!origin) return true;
  try {
    return new URL(origin).host === firstHeader(req.headers.host);
  } catch {
    return false;
  }
}

/**
 * Whether this request arrived over a channel where a `Secure` cookie will actually be stored:
 * real HTTPS (a tunnel/proxy tells us via X-Forwarded-Proto) or a loopback host, which browsers
 * treat as a trustworthy origin. Plain HTTP to a LAN address gets the cookie WITHOUT `Secure` —
 * otherwise the browser would silently drop it and login would appear to do nothing.
 */
export function isSecureRequest(req: http.IncomingMessage): boolean {
  if (firstHeader(req.headers['x-forwarded-proto'])?.split(',')[0].trim() === 'https') return true;
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  const host = (firstHeader(req.headers.host) ?? '').replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Build the Set-Cookie value for a freshly minted session (or, with maxAge 0, for a logout). */
export function sessionCookie(sid: string, maxAgeSec: number, secure: boolean): string {
  // HttpOnly: the page's JS can never read it, so an XSS cannot exfiltrate a reusable credential.
  // SameSite=Strict: no cross-site request carries it, which is the whole CSRF story. It costs
  // nothing here because the SPA's own calls are same-origin and the static shell needs no auth.
  const parts = [
    `${UI_SESSION_COOKIE}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Read the session id a request presents, if any. */
export function sessionIdFrom(req: http.IncomingMessage): string | undefined {
  return parseCookie(req.headers.cookie, UI_SESSION_COOKIE);
}

/**
 * The three token-login routes. `/api/ui/login` and `/api/ui/session` MUST be registered as public
 * routes on the server (a browser with no credential has to be able to reach them); `/api/ui/logout`
 * is an ordinary gated route.
 */
export function createUiAuthRoutes(deps: UiAuthRouteDeps): Record<string, RouteHandler> {
  const maxAgeSec = Math.floor(deps.ttlMs / 1000);

  return {
    [UI_LOGIN_PATH]: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
      if (!isSameOrigin(req)) {
        log.warn(`ui login rejected: cross-origin request from ${firstHeader(req.headers.origin)}`);
        return json(res, 403, { ok: false, error: 'cross-origin login refused' });
      }

      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (err) {
        return json(res, 400, { ok: false, error: (err as Error).message });
      }

      const presented = typeof body.token === 'string' ? body.token.trim() : '';
      if (!timingSafeEqualStr(deps.getToken(), presented)) {
        await new Promise((resolve) => setTimeout(resolve, LOGIN_FAILURE_DELAY_MS));
        log.warn('ui login rejected: wrong token');
        return json(res, 401, { ok: false, error: 'invalid token' });
      }

      const sid = deps.store.create();
      const secure = isSecureRequest(req);
      if (!secure) {
        log.warn(
          'ui login over plain HTTP to a non-loopback host — the session cookie is issued without ' +
            'Secure, so anyone on this network path can read it. Use HTTPS (a tunnel) for real use.',
        );
      }
      log.info('ui login accepted — session issued');
      json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(sid, maxAgeSec, secure) });
    },

    [UI_LOGOUT_PATH]: async (req, res) => {
      deps.store.revoke(sessionIdFrom(req));
      json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, isSecureRequest(req)) });
    },

    // Public probe. Answers only two booleans — "am I already in?" and "is there a form worth
    // showing?" — so an unauthenticated caller learns nothing it could not learn by trying.
    [UI_SESSION_PATH]: async (req, res) => {
      json(res, 200, { ok: true, data: { authenticated: await deps.authorize(req), tokenLogin: true } });
    },
  };
}

/**
 * The probe alone, for a server with token login DISABLED: it still has to answer the SPA, which
 * otherwise cannot tell "no form here" from "server too old / broken" and would show a form that
 * can never work.
 */
export function createUiSessionProbeRoute(
  authorize: (req: http.IncomingMessage) => Promise<boolean>,
): Record<string, RouteHandler> {
  return {
    [UI_SESSION_PATH]: async (req, res) => {
      json(res, 200, { ok: true, data: { authenticated: await authorize(req), tokenLogin: false } });
    },
  };
}
