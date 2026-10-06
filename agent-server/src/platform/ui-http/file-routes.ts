// File routes: composer uploads into the workspace, workspace downloads (agent-sent files and the
// user's own uploads), and commission board assets. Every one of them is mounted through
// `customRoutes`, so the server's auth gate runs before any handler here.

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { contentTypeHeader, mimeTypeForPath } from '@core/media-types.js';
import {
  resolveAvailablePath,
  sanitizeDisplayFilename,
  sanitizeStorageFilename,
} from '@core/workspace-filenames.js';
import { declaredLength, rejectAndDrain, sendError, sendJson, sendMethodNotAllowed } from './http-json.js';
import type { CustomRouteHandler } from './ui-http-server.js';

export const UPLOAD_PATH = '/api/attachments/upload';
export const DOWNLOAD_PATH = '/api/files/download';
export const COMMISSION_ASSET_PATH = '/api/commissions/asset';

/** Max upload size: 100 MB. The web composer mirrors this to refuse a file before sending it. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** An upload bucket is a session id (UUID) or a composer draft id (`crypto.randomUUID()`): one
 *  plain path component. Anything else — `..`, separators, dots — never reaches the filesystem. */
const UPLOAD_BUCKET_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Types a browser would run as a document (scripts, event handlers) when the file is opened
 * directly. They are served under a CSP sandbox: the page gets an opaque origin, so it cannot read
 * the app's cookies or storage or call the API as the user. PDF is deliberately absent — Chrome's
 * PDF viewer refuses to render a sandboxed document — and images/video/text are inert under nosniff.
 */
const ACTIVE_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml']);
const ACTIVE_CONTENT_CSP = 'sandbox allow-scripts';

/**
 * The file routes reach into domain state (projects, the memory path guard), which platform may
 * not import; the entry layer injects it.
 */
export interface FileRouteDeps {
  /** Physical directory behind the UI-relative `workspace/attachments/` prefix. */
  attachmentsDir: string;
  /** `workspace/…` → absolute path inside the workspace, or null when it escapes. */
  resolveWorkspaceRelPath: (rel: string) => string | null;
  /** A project's context directory, or undefined for an unknown project. */
  projectContextDir: (projectId: string) => string | undefined;
  /** Confine `rel` under `root` (absolute, `..` and symlink escapes rejected); throws on escape. */
  resolveMemoryFilePath: (root: string, rel: string) => string;
  /** Test seam; defaults to MAX_UPLOAD_BYTES. */
  maxUploadBytes?: number;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
}

function decodeFileName(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded; // malformed percent-encoding: keep the literal
  }
}

function classifyMime(mimeType: string): 'image' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

type UploadOutcome = { kind: 'stored'; size: number } | { kind: 'too-large' } | { kind: 'failed'; error: Error };

/**
 * Stream the request body into `destPath`, stopping at `maxBytes`. On overflow the partial file is
 * removed and the request is left FLOWING (the caller drains it) — destroying it here would destroy
 * the socket, and the client would never see the 413.
 */
function receiveUpload(req: IncomingMessage, destPath: string, maxBytes: number): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(destPath, { flags: 'wx' });
    let size = 0;
    let settled = false;
    const settle = (outcome: UploadOutcome): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      if (outcome.kind !== 'stored') {
        out.destroy();
        fs.promises.unlink(destPath).catch(() => {});
      }
      resolve(outcome);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) return settle({ kind: 'too-large' });
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    };
    const onEnd = (): void => { out.end(); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', (error) => settle({ kind: 'failed', error }));
    req.on('close', () => { if (!req.complete) settle({ kind: 'failed', error: new Error('upload aborted') }); });
    out.on('error', (error) => settle({ kind: 'failed', error }));
    out.on('finish', () => settle({ kind: 'stored', size }));
  });
}

/** Stat + stream an already-validated absolute file path with download headers. */
async function streamFile(res: ServerResponse, target: string, disposition: 'inline' | 'attachment'): Promise<void> {
  let size: number;
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    sendError(res, 404, 'not-found', 'File not found');
    return;
  }

  const mimeType = mimeTypeForPath(target);
  const name = path.basename(target);
  res.writeHead(200, {
    'Content-Type': contentTypeHeader(mimeType),
    'Content-Length': String(size),
    'Content-Disposition': `${disposition}; filename="${name.replace(/"/g, '')}"`,
    'Cache-Control': 'private, max-age=3600',
    // The declared type is the only type: a `.png` that holds HTML must never be sniffed into a page.
    'X-Content-Type-Options': 'nosniff',
    ...(ACTIVE_MIME_TYPES.has(mimeType) ? { 'Content-Security-Policy': ACTIVE_CONTENT_CSP } : {}),
  });
  const stream = fs.createReadStream(target);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
  stream.pipe(res);
}

function parseQuery(req: IncomingMessage, res: ServerResponse): URLSearchParams | null {
  try {
    return new URL(req.url ?? '', 'http://localhost').searchParams;
  } catch {
    sendError(res, 400, 'bad-request', 'Malformed URL');
    return null;
  }
}

export function createFileRoutes(deps: FileRouteDeps): Record<string, CustomRouteHandler> {
  const maxUploadBytes = deps.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const tooLarge = (req: IncomingMessage, res: ServerResponse): void =>
    rejectAndDrain(req, res, 413, 'too-large', `File exceeds ${maxUploadBytes / 1024 / 1024}MB limit`, maxUploadBytes);

  /** POST /api/attachments/upload — stores under an ASCII path, answers with the decoded Unicode name. */
  const upload: CustomRouteHandler = async (req, res) => {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
    const bucket = header(req, 'x-session-id');
    const encodedName = header(req, 'x-file-name');
    const mimeType = (header(req, 'content-type') ?? 'application/octet-stream').split(';')[0].trim();
    if (!bucket) return sendError(res, 400, 'missing-session', 'X-Session-Id header required');
    if (!encodedName) return sendError(res, 400, 'missing-name', 'X-File-Name header required');
    const root = path.resolve(deps.attachmentsDir);
    const dir = path.resolve(root, bucket);
    if (!UPLOAD_BUCKET_RE.test(bucket) || path.dirname(dir) !== root) {
      return sendError(res, 400, 'bad-session', 'X-Session-Id is not a session id');
    }
    if ((declaredLength(req) ?? 0) > maxUploadBytes) return tooLarge(req, res);

    const displayName = sanitizeDisplayFilename(decodeFileName(encodedName));
    await fs.promises.mkdir(dir, { recursive: true });
    const { destPath, finalName } = await resolveAvailablePath(dir, sanitizeStorageFilename(displayName));
    const outcome = await receiveUpload(req, destPath, maxUploadBytes);
    if (outcome.kind === 'too-large') return tooLarge(req, res);
    if (outcome.kind === 'failed') return sendError(res, 500, 'upload-failed', outcome.error.message);
    sendJson(res, 200, {
      ok: true,
      data: {
        name: displayName,
        path: `workspace/attachments/${bucket}/${finalName}`,
        size: outcome.size,
        mimeType,
        type: classifyMime(mimeType),
      },
    });
  };

  /** GET /api/files/download?path=workspace/…&disposition=inline|attachment */
  const download: CustomRouteHandler = async (req, res) => {
    const query = parseQuery(req, res);
    if (!query) return;
    const rel = (query.get('path') ?? '').trim();
    const disposition = query.get('disposition') === 'inline' ? 'inline' : 'attachment';
    if (!rel) return sendError(res, 400, 'missing-path', 'path query param required');
    const target = deps.resolveWorkspaceRelPath(rel);
    if (!target) return sendError(res, 403, 'forbidden', 'Path escapes the workspace root');
    await streamFile(res, target, disposition);
  };

  /**
   * GET /api/commissions/asset?projectId=…&path=commissions/<slug>/assets/…&disposition=…
   *
   * Binary assets from a project's commissions/ tree (ledger-referenced images etc.). The rel path
   * must start with `commissions/` and passes the same absolute/`..`/symlink guard as memory.file.
   * `.html` assets are FETCHED by the board and rendered via srcdoc — an iframe never points here.
   */
  const commissionAsset: CustomRouteHandler = async (req, res) => {
    const query = parseQuery(req, res);
    if (!query) return;
    const projectId = (query.get('projectId') ?? '').trim();
    const rel = (query.get('path') ?? '').trim();
    const disposition = query.get('disposition') === 'attachment' ? 'attachment' : 'inline';
    if (!projectId || !rel) return sendError(res, 400, 'missing-params', 'projectId and path query params required');
    if (!rel.startsWith('commissions/')) return sendError(res, 403, 'forbidden', 'path must be under commissions/');
    const contextDir = deps.projectContextDir(projectId);
    let target: string;
    try {
      if (!contextDir) throw new Error('unknown project');
      target = deps.resolveMemoryFilePath(fs.realpathSync(contextDir), rel);
    } catch {
      return sendError(res, 404, 'not-found', 'File not found');
    }
    await streamFile(res, target, disposition);
  };

  return {
    [UPLOAD_PATH]: upload,
    [DOWNLOAD_PATH]: download,
    [COMMISSION_ASSET_PATH]: commissionAsset,
  };
}
