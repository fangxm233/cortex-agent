import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAppRouter } from '@domain/ui-service/app-router.js';
import { createUiHttpServer, createAuthorizer } from '@platform/ui-http/ui-http-server.js';
import type { UiHttpServer } from '@platform/ui-http/ui-http-server.js';
import { createUiSessionStore, DEFAULT_SESSION_TTL_MS } from '@platform/ui-http/ui-session.js';
import {
  createUiAuthRoutes,
  createUiSessionProbeRoute,
  UI_LOGIN_PATH,
  UI_SESSION_PATH,
} from '@platform/ui-http/ui-auth-routes.js';
import { createOtaRoutes } from '@platform/ui-http/ui-ota.js';
import { createAppUpdateRoutes } from '@platform/ui-http/app-update.js';
import { isUpdateDevMode } from '@domain/system/server-update-check.js';
import { createForwardRoutes } from '@platform/ui-http/port-forward.js';
import { createDevicePortRoutes } from '@platform/ui-http/device-ports.js';
import { createFileRoutes } from '@platform/ui-http/file-routes.js';
import { BROWSER_STREAM_PATH, createBrowserStream } from '@platform/ui-http/browser-stream.js';
import {
  insertText, isTakenOver, listBrowserSessions, setTakeover, streamPort,
} from '@domain/browser/broker.js';
import { getOnlineDevices, sendCommand } from '@domain/remote/client-manager.js';
import { openDevicePort, closeDevicePort, listDevicePorts } from '@domain/remote/device-port.js';
import { accessVerifierFromEnv } from '@platform/ui-http/access-jwt.js';
import type { UiService } from '@domain/ui-service/types.js';
import { getClientToken } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { WORKSPACE_DIR, STORE_DIR, resolveWorkspaceRelPath } from '@core/paths.js';
import { projectStore } from '@domain/projects/project-store.js';
import { isUiHttpEnabled } from './ui-http-gate.js';
import { resolveMemoryFilePath } from '@domain/ui-service/query/memory.js';

const log = createLogger('ui-http');

/** Default TCP port for the Web UI tRPC endpoint (loopback-only; exposure is via a tunnel). */
const DEFAULT_UI_PORT = 3004;

/** Where browser sessions survive a daemon restart. Written 0600 by the store. */
const SESSIONS_FILE = path.join(STORE_DIR, 'ui-sessions.json');

/**
 * Token login is ON unless explicitly switched off — a browser reaching this server can log in by
 * pasting the clientToken once. Opting out (`CORTEX_UI_TOKEN_LOGIN=0`) removes the login routes and
 * the cookie leg entirely, leaving the token header and (if configured) Cloudflare Access.
 *
 * Being on by default means every CORTEX_UI_HTTP deployment exposes a public POST /api/ui/login.
 * Behind Access the edge never lets an unauthenticated request reach it; on a directly exposed
 * port it is one more guessable door, guarded by a 32-byte random secret, a constant-time compare
 * and a fixed per-failure delay. See docs/browser-access.md.
 */
function isTokenLoginEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.CORTEX_UI_TOKEN_LOGIN ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Session lifetime from env (days), falling back to the store's 30-day default. */
function sessionTtlMs(env: NodeJS.ProcessEnv): number {
  const days = Number((env.CORTEX_UI_SESSION_TTL_DAYS ?? '').trim());
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : DEFAULT_SESSION_TTL_MS;
}

/**
 * Resolve the built SPA directory relative to this module's compiled location
 * (`agent-server/dist/entry/start-ui-http.js`). Two layouts are supported:
 *  - installed package: `web/dist` sits at the package root (`@cortex-agent/server/web/dist`,
 *    placed there by the `prepack` copy step) → `../../web/dist`.
 *  - monorepo dev-from-source: `web/dist` sits at the repo root → `../../../web/dist`.
 * Workspace/deploy override via `opts.spaDir` or `CORTEX_UI_SPA_DIR` takes precedence. Returns the
 * first candidate that exists on disk, so `serveSpaStub` still 404s cleanly (rather than a bogus
 * path) when web/ is not built. When none is located, returns undefined.
 */
function defaultSpaDir(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, '../../web/dist'), // installed package root
      path.resolve(here, '../../../web/dist'), // monorepo repo root
    ];
    return candidates.find((c) => fs.existsSync(c));
  } catch {
    return undefined;
  }
}

export interface StartUiHttpOptions {
  /** The composed UiService (real domain-backed instance in production; a fake in tests). */
  uiService: UiService;
  /** Token accessor the server accepts. Defaults to getClientToken (the shared secret clients carry). */
  getToken?: () => string;
  /** Env to read the startup gate/port from. Defaults to process.env (injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /**
   * Directory of the built SPA to serve for non-tRPC paths. When omitted, resolved from
   * CORTEX_UI_SPA_DIR else the monorepo web/dist. Absent/missing on disk → 404 stub.
   */
  spaDir?: string;
  /** Explicit static CORS allow-list override; production reads runtime settings per request. */
  corsOrigins?: string[];
}

/**
 * Build the AppRouter from the injected UiService and start the Web UI HTTP+SSE transport-host
 * on CORTEX_UI_PORT (default 3004), bound 127.0.0.1, behind the x-cortex-token gate, serving the
 * built SPA same-origin. Returns the running server handle, or null when the CORTEX_UI_HTTP env
 * gate is off (clean skip). The caller owns the handle and must call close() on shutdown.
 */
export function startUiHttpServer(opts: StartUiHttpOptions): UiHttpServer | null {
  const env = opts.env ?? process.env;
  if (!isUiHttpEnabled(env)) return null;

  // parseInt(undefined/'')→NaN falls back; a valid 0 (ephemeral, for tests) is preserved.
  const parsedPort = parseInt(env.CORTEX_UI_PORT ?? '', 10);
  const port = Number.isNaN(parsedPort) ? DEFAULT_UI_PORT : parsedPort;
  const router = createAppRouter(opts.uiService);
  const corsOrigins = opts.corsOrigins ?? (() => getSettings().uiCorsOrigins);
  const initialCorsOrigins = typeof corsOrigins === 'function' ? corsOrigins() : corsOrigins;
  const spaDir = opts.spaDir ?? env.CORTEX_UI_SPA_DIR ?? defaultSpaDir();
  // Cloudflare Access JWT verifier (the browser auth path), built from CORTEX_ACCESS_TEAM_DOMAIN +
  // CORTEX_ACCESS_AUD (optional CORTEX_ACCESS_CERTS_URL). Unset → undefined, and the gate degrades
  // to token-only.
  const verifyAccessJwt = accessVerifierFromEnv(env);
  const getToken = opts.getToken ?? getClientToken;

  // Token login: one session store, one authorizer. The authorizer is handed to BOTH the gate and
  // the public /api/ui/session probe, so "am I authenticated?" is answered by the same predicate
  // that decides the next request — two copies would eventually disagree.
  const tokenLogin = isTokenLoginEnabled(env);
  const sessionStore = tokenLogin
    ? createUiSessionStore({ file: SESSIONS_FILE, ttlMs: sessionTtlMs(env) })
    : undefined;
  const verifySession = sessionStore ? (sid: string | undefined) => sessionStore.verify(sid) : undefined;
  const authorize = createAuthorizer({ getToken, verifySession, verifyAccessJwt });

  // The agent's browser, live in the app: session list, takeover, typed text, and the stream itself.
  const browserStream = createBrowserStream({
    listSessions: listBrowserSessions, streamPort, setTakeover, isTakenOver, insertText,
  });

  log.info(
    `Web UI enabled — starting tRPC HTTP+SSE on 127.0.0.1:${port}` +
      (spaDir ? ` (SPA: ${spaDir})` : ' (SPA: not built — non-tRPC paths 404)') +
      (initialCorsOrigins.length > 0 ? ` (CORS allow-list: ${initialCorsOrigins.join(', ')})` : '') +
      (verifyAccessJwt ? ' (Cloudflare Access JWT path enabled)' : '') +
      (tokenLogin ? ' (browser token login enabled)' : ' (browser token login disabled)'),
  );
  return createUiHttpServer({
    router,
    getToken,
    port,
    host: '127.0.0.1',
    spaDir,
    corsOrigins,
    authorize,
    // Reachable without a credential: the login endpoint and the boolean probe. Everything else,
    // including logout, goes through the gate.
    publicRoutes: tokenLogin ? [UI_LOGIN_PATH, UI_SESSION_PATH] : [UI_SESSION_PATH],
    customRoutes: {
      // Browser token login. When disabled, only the probe remains — so the SPA can say "token
      // login is off here" instead of showing a form that could never work.
      ...(sessionStore
        ? createUiAuthRoutes({ store: sessionStore, getToken, authorize, ttlMs: sessionTtlMs(env) })
        : createUiSessionProbeRoute(authorize)),
      // Composer uploads, workspace downloads and board assets.
      ...createFileRoutes({
        attachmentsDir: path.join(WORKSPACE_DIR, 'attachments'),
        resolveWorkspaceRelPath,
        projectContextDir: (projectId) => projectStore.get(projectId)?.contextDir,
        resolveMemoryFilePath,
      }),
      // Frontend OTA: serves the built SPA as a manifest + ZIP bundle so the desktop shell can
      // self-update its frontend. Empty (disabled) when the SPA is not built. Same auth gate as tRPC.
      ...createOtaRoutes(spaDir),
      // App shell self-update: advertises the newest GitHub release carrying native app assets
      // (capped at this server's version) so the shell can offer a one-prompt update. JSON only —
      // the binaries download straight from the GitHub CDN. Same auth gate as tRPC.
      // A dev server never advertises app releases: see AppUpdateRouteOptions.devMode.
      ...createAppUpdateRoutes({ devMode: isUpdateDevMode() }),
      // Listening-port discovery for the desktop port forward: tells the shell which loopback
      // services exist here so the Ports list can offer them. Same auth gate as tRPC.
      ...createForwardRoutes(),
      // The same discovery and mapping for ports that live on a connected device instead of here.
      // A device is outbound-only, so the server asks it to dial back and hands out a loopback port
      // that stands in for the remote one (plan/embedded-browser.md §18).
      ...createDevicePortRoutes({
        listDevices: getOnlineDevices,
        runOnDevice: async (device, command) => {
          const result = await sendCommand(device, { action: 'bash', params: { command }, timeout: 10_000 });
          return typeof result?.stdout === 'string' ? result.stdout : '';
        },
        openDevicePort,
        closeDevicePort,
        listDevicePorts,
      }),
      ...browserStream.routes,
    },
    upgradeRoutes: { [BROWSER_STREAM_PATH]: browserStream },
    portForward: env.CORTEX_PORT_FORWARD !== '0',
  });
}
