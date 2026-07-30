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
//         tRPC directly. Also mounts the frontend-OTA custom routes (createOtaRoutes(spaDir)) so the
//         desktop shell can self-update its SPA (disabled cleanly when the SPA is not built), and
//         the app-update manifest route (createAppUpdateRoutes) for native shell self-update.
// >>> If I am updated, update CORTEX.md <<<

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAppRouter } from '@domain/ui-service/app-router.js';
import { createUiHttpServer } from '@platform/ui-http/ui-http-server.js';
import type { UiHttpServer, CustomRouteHandler } from '@platform/ui-http/ui-http-server.js';
import { createOtaRoutes } from '@platform/ui-http/ui-ota.js';
import { createAppUpdateRoutes } from '@platform/ui-http/app-update.js';
import { accessVerifierFromEnv } from '@platform/ui-http/access-jwt.js';
import type { AccessJwtVerifier } from '@platform/ui-http/access-jwt.js';
import type { UiService } from '@domain/ui-service/types.js';
import { getClientToken } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { WORKSPACE_DIR, resolveWorkspaceRelPath } from '@core/paths.js';

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

/** File upload handler: reads raw file bytes from the body, saves the file physically under
 *  WORKSPACE_DIR/attachments/<sessionId>/<filename> (WORKSPACE_DIR = <DATA_DIR>/tmp), and returns
 *  AttachmentMeta whose `path` is the UI-relative `workspace/attachments/...` alias (resolved back to
 *  the absolute path via resolveWorkspaceRelPath by both the download route and the agent-runner).
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
    // UI-relative alias: `workspace/` maps to WORKSPACE_DIR's contents (the file physically lives at
    // WORKSPACE_DIR/attachments/…, i.e. <DATA_DIR>/tmp/attachments/…). Consumers resolve it via
    // resolveWorkspaceRelPath — never by treating `workspace` as a literal <DATA_DIR> subdirectory.
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

// ── File download route (15a user uploads + 20a agent-sent files) ─────────────
// Serves a file stored under WORKSPACE_DIR by its UI-relative `workspace/…` path. Used by both the
// agent-sent file cards (workspace/outputs/…) and, going forward, the user-upload cards
// (workspace/attachments/…). Auth-gated by the same dual-path check as every custom route. The path
// is confined to WORKSPACE_DIR with a single-root traversal guard, so no filesystem location outside
// the workspace is ever reachable.

const DOWNLOAD_PATH = '/api/files/download';

/** Content types for inline preview / correct download naming. Unknown → octet-stream. */
const DOWNLOAD_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.zip': 'application/zip',
};

/** Resolve a UI-relative `workspace/…` path to an absolute path strictly inside WORKSPACE_DIR.
 *  Thin wrapper over the shared `resolveWorkspaceRelPath` (core/paths) so the download route and the
 *  agent-runner attachment mapping resolve the `workspace/` alias identically. Returns null when the
 *  prefix is wrong or the resolved target escapes the workspace root. Exported for the traversal-guard
 *  unit test. */
export function resolveWorkspacePath(rel: string): string | null {
  return resolveWorkspaceRelPath(rel);
}

/** GET /api/files/download?path=workspace/…&disposition=inline|attachment — streams the file. */
async function handleDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '', 'http://localhost');
  } catch {
    jsonReply(res, 400, { ok: false, code: 'bad-request', message: 'Malformed URL' });
    return;
  }
  const rel = (url.searchParams.get('path') ?? '').trim();
  const disposition = url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';
  if (!rel) {
    jsonReply(res, 400, { ok: false, code: 'missing-path', message: 'path query param required' });
    return;
  }
  const target = resolveWorkspacePath(rel);
  if (!target) {
    jsonReply(res, 403, { ok: false, code: 'forbidden', message: 'Path escapes the workspace root' });
    return;
  }

  let size: number;
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    jsonReply(res, 404, { ok: false, code: 'not-found', message: 'File not found' });
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const name = path.basename(target);
  res.writeHead(200, {
    'Content-Type': DOWNLOAD_CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': String(size),
    'Content-Disposition': `${disposition}; filename="${name.replace(/"/g, '')}"`,
    'Cache-Control': 'private, max-age=3600',
  });
  const stream = createReadStream(target);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
  stream.pipe(res);
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
      [DOWNLOAD_PATH]: handleDownload,
      // Frontend OTA: serves the built SPA as a manifest + ZIP bundle so the desktop shell can
      // self-update its frontend. Empty (disabled) when the SPA is not built. Same auth gate as tRPC.
      ...createOtaRoutes(spaDir),
      // App shell self-update: advertises the newest GitHub release carrying native app assets
      // (capped at this server's version) so the shell can offer a one-prompt update. JSON only —
      // the binaries download straight from the GitHub CDN. Same auth gate as tRPC.
      ...createAppUpdateRoutes(),
    },
  });
}
