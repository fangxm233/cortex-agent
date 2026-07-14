// input:  a real UiService (injected) + env (CORTEX_UI_HTTP gate, CORTEX_UI_PORT,
//          CORTEX_UI_CORS_ORIGINS, CORTEX_UI_SPA_DIR)
// output: startUiHttpServer(opts) -> UiHttpServer | null — builds the tRPC AppRouter over the
//         injected UiService and starts the Web UI HTTP+SSE transport-host behind the dual-path
//         auth gate — x-cortex-token (getClientToken) OR a Cloudflare Access JWT verifier built
//         from env (accessVerifierFromEnv) — bound 127.0.0.1. Returns null (clean skip) when the
//         env gate is off. Same-origin: serves the built SPA (web/dist) and /trpc on one port.
// pos:    Web UI wiring, in-core (entry layer). The only place that binds the AppRouter
//         (createAppRouter, domain/ui-service) to the transport-host (createUiHttpServer,
//         platform/ui-http) — kept out of both so the router stays transport-agnostic and the
//         transport-host stays router-agnostic; the wiring sits in entry, the one layer allowed to
//         depend on both domain and platform. app.ts loads this on demand via a CORTEX_UI_HTTP-gated
//         dynamic import (entry/ui-http-gate.ts), so @trpc/server + jose stay runtime-lazy, and
//         closes the returned handle on shutdown. SPA dir: opts.spaDir ?? CORTEX_UI_SPA_DIR ??
//         web/dist resolved relative to this module's compiled location (installed-package root,
//         else the monorepo repo-root — see defaultSpaDir).
//         CORS: resolves the transport-host's allow-list from opts.corsOrigins else the
//         CORTEX_UI_CORS_ORIGINS env var (comma-separated) — lets the Tauri desktop webview reach
//         tRPC directly.
// >>> If I am updated, update CORTEX.md <<<

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAppRouter } from '@domain/ui-service/app-router.js';
import { createUiHttpServer } from '@platform/ui-http/ui-http-server.js';
import type { UiHttpServer, CustomRouteHandler } from '@platform/ui-http/ui-http-server.js';
import { accessVerifierFromEnv } from '@platform/ui-http/access-jwt.js';
import type { AccessJwtVerifier } from '@platform/ui-http/access-jwt.js';
import type { UiService } from '@domain/ui-service/types.js';
import { getClientToken } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { WORKSPACE_DIR } from '@core/paths.js';

const log = createLogger('ui-http');

/** Default TCP port for the Web UI tRPC endpoint (loopback-only; exposure is via a tunnel). */
const DEFAULT_UI_PORT = 3004;

/** Opt-in gate: the Web UI HTTP server starts only when CORTEX_UI_HTTP is truthy (skip cleanly otherwise). */
function isEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.CORTEX_UI_HTTP || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
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
  /** Env to read the gate/port from. Defaults to process.env (injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /**
   * Directory of the built SPA to serve for non-tRPC paths. When omitted, resolved from
   * CORTEX_UI_SPA_DIR else the monorepo web/dist. Absent/missing on disk → 404 stub.
   */
  spaDir?: string;
  /**
   * Explicit CORS allow-list forwarded to the transport-host. When omitted, the list is parsed
   * from the CORTEX_UI_CORS_ORIGINS env var (comma-separated; entries trimmed, empties dropped).
   * Env-driven so the running-server path (agent-server) can enable CORS for the Tauri desktop
   * webview (e.g. tauri://localhost) with no code change — just the env var. Absent/empty → no
   * CORS headers.
   */
  corsOrigins?: string[];
  /**
   * Explicit Cloudflare Access JWT verifier forwarded to the transport-host (the browser auth path).
   * When omitted, it is built from env via accessVerifierFromEnv (CORTEX_ACCESS_TEAM_DOMAIN +
   * CORTEX_ACCESS_AUD, optional CORTEX_ACCESS_CERTS_URL). When those are unset the verifier is
   * undefined and the gate degrades to token-only. Injectable for tests.
   */
  verifyAccessJwt?: AccessJwtVerifier;
}

/**
 * Parse a comma-separated origin list (from CORTEX_UI_CORS_ORIGINS) into a trimmed, empties-dropped
 * array. Returns undefined when the raw value is absent or yields no entries, so the transport-host
 * keeps its backward-compatible "no CORS headers" default rather than an empty allow-list.
 */
function parseCorsOrigins(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const origins = raw.split(',').map((o) => o.trim()).filter((o) => o.length > 0);
  return origins.length > 0 ? origins : undefined;
}

// ── File upload route (15a attachments) ───────────────────────────────────────

const ATTACHMENTS_DIR = path.join(WORKSPACE_DIR, 'attachments');
const UPLOAD_PATH = '/api/attachments/upload';

/** Max upload size: 100 MB. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Classify a MIME type into the AttachmentMeta `type` bucket. */
function classifyMime(mimeType: string): 'image' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

/** Sanitize a filename: keep alphanumeric, dot, hyphen, underscore; replace rest with underscore. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+/, '').substring(0, 200) || 'file';
}

/** Find an available filename in `dir`: if `name` exists, try `name_1`, `name_2`, …
 *  Returns the first non-existing path and the final basename. */
async function resolveAvailablePath(dir: string, base: string): Promise<{ destPath: string; finalName: string }> {
  const extIdx = base.lastIndexOf('.');
  const stem = extIdx > 0 ? base.slice(0, extIdx) : base;
  const ext = extIdx > 0 ? base.slice(extIdx) : '';
  let candidate = base;
  let counter = 0;
  while (true) {
    const p = path.join(dir, candidate);
    try {
      await fs.promises.access(p, fs.constants.F_OK);
      // Exists — try next suffix
      counter++;
      candidate = `${stem}_${counter}${ext}`;
    } catch {
      return { destPath: p, finalName: candidate };
    }
  }
}

function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}

/** File upload handler: reads raw file bytes from the body, saves to
 *  tmp/attachments/<sessionId>/<filename>, returns AttachmentMeta.
 *  Auto-renames on name collision (file.png → file_1.png, file_2.png, …). */
async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = (req.headers['x-session-id'] as string | undefined)?.trim();
  const rawName = (req.headers['x-file-name'] as string | undefined)?.trim();
  const mimeType = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();

  if (!sessionId) {
    jsonReply(res, 400, { ok: false, code: 'missing-session', message: 'X-Session-Id header required' });
    return;
  }
  if (!rawName) {
    jsonReply(res, 400, { ok: false, code: 'missing-name', message: 'X-File-Name header required' });
    return;
  }

  const baseName = sanitizeFilename(rawName);
  const dir = path.join(ATTACHMENTS_DIR, sessionId);
  await fs.promises.mkdir(dir, { recursive: true });

  const { destPath, finalName } = await resolveAvailablePath(dir, baseName);
  const writeStream = createWriteStream(destPath, { flags: 'wx' });

  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      writeStream.destroy(new Error('File too large'));
      req.destroy();
    }
  });

  try {
    await pipeline(req, writeStream);
    const relPath = `workspace/attachments/${sessionId}/${finalName}`;
    jsonReply(res, 200, {
      ok: true,
      data: { name: finalName, path: relPath, size, mimeType, type: classifyMime(mimeType) },
    });
  } catch (err: any) {
    // Clean up partial file on error (e.g. size exceeded).
    try { await fs.promises.unlink(destPath); } catch {}
    if (!res.headersSent) {
      if (size > MAX_UPLOAD_BYTES) {
        jsonReply(res, 413, { ok: false, code: 'too-large', message: `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit` });
      } else {
        jsonReply(res, 500, { ok: false, code: 'upload-failed', message: err.message });
      }
    }
  }
}

/**
 * Build the AppRouter from the injected UiService and start the Web UI HTTP+SSE transport-host
 * on CORTEX_UI_PORT (default 3004), bound 127.0.0.1, behind the x-cortex-token gate, serving the
 * built SPA same-origin. Returns the running server handle, or null when the CORTEX_UI_HTTP env
 * gate is off (clean skip). The caller owns the handle and must call close() on shutdown.
 */
export function startUiHttpServer(opts: StartUiHttpOptions): UiHttpServer | null {
  const env = opts.env ?? process.env;
  if (!isEnabled(env)) return null;

  // parseInt(undefined/'')→NaN falls back; a valid 0 (ephemeral, for tests) is preserved.
  const parsedPort = parseInt(env.CORTEX_UI_PORT ?? '', 10);
  const port = Number.isNaN(parsedPort) ? DEFAULT_UI_PORT : parsedPort;
  const router = createAppRouter(opts.uiService);
  const corsOrigins = opts.corsOrigins ?? parseCorsOrigins(env.CORTEX_UI_CORS_ORIGINS);
  const spaDir = opts.spaDir ?? env.CORTEX_UI_SPA_DIR ?? defaultSpaDir();
  const verifyAccessJwt = opts.verifyAccessJwt ?? accessVerifierFromEnv(env);
  log.info(
    `Web UI enabled — starting tRPC HTTP+SSE on 127.0.0.1:${port}` +
      (spaDir ? ` (SPA: ${spaDir})` : ' (SPA: not built — non-tRPC paths 404)') +
      (corsOrigins ? ` (CORS allow-list: ${corsOrigins.join(', ')})` : '') +
      (verifyAccessJwt ? ' (Cloudflare Access JWT path enabled)' : ''),
  );
  return createUiHttpServer({
    router,
    getToken: opts.getToken ?? getClientToken,
    port,
    host: '127.0.0.1',
    spaDir,
    corsOrigins,
    verifyAccessJwt,
    customRoutes: {
      [UPLOAD_PATH]: handleUpload,
    },
  });
}
