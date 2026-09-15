// input:  a file a platform adapter has just written into a directory this module owns
// output: that file under `workspace/attachments/<inbound key>/`, named after what the user sent
//         it as, typed by what its bytes actually are — plus the age sweep that reclaims the space
// pos:    orchestration — the inbound half of `outputs-store.ts` (which owns the agent-sent
//         `workspace/outputs/` side) and the server-side twin of the web upload route, which
//         stores composer uploads under `workspace/attachments/<sessionId>/`. Platform downloads
//         used to land flat in WORKSPACE_DIR's root under their opaque platform id
//         (`img_v3_02n4….png`), mixed in with agent scratch, never cleaned, and with the user's
//         own filename dropped on the floor.

import * as path from 'path';
import { promises as fs } from 'fs';
import { WORKSPACE_DIR } from '@core/paths.js';
import { imageMimeExtension, sniffImageMime } from '@core/media-types.js';
import { createLogger } from '@core/log.js';
import { sanitizeDisplayFilename, sanitizeStorageFilename } from './outputs-store.js';
import { classifyAttachment, extToMime } from './agent-file-send.js';
import type { DownloadedFile } from '@platform/types.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';

const log = createLogger('attachments-store');

/** Physical directory backing the UI-relative `workspace/attachments/` prefix. */
export const ATTACHMENTS_DIR = path.join(WORKSPACE_DIR, 'attachments');

/** Bytes read to identify a file's real type. */
const SNIFF_BYTES = 16;

/** Marks the directories this module owns. A web composer upload lands under a bare `<sessionId>`
 *  in the same root and its files are linked from the transcript forever, so the age sweep must be
 *  able to tell the two apart by name alone. */
const INBOUND_PREFIX = 'in-';

/** One inbound message's own directory, so two files of the same name cannot collide across
 *  messages and the whole set can be reclaimed as a unit. */
function inboundDirName(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 120);
  return `${INBOUND_PREFIX}${safe || 'message'}`;
}

export function inboundAttachmentDir(key: string): string {
  return path.join(ATTACHMENTS_DIR, inboundDirName(key));
}

export async function prepareInboundAttachmentDir(key: string): Promise<string> {
  const dir = inboundAttachmentDir(key);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** The UI-relative `workspace/…` alias for a path inside the workspace, or null when it is outside
 *  (a TUI attachment is the user's own file, referenced where it already lives). */
export function workspaceRelPath(absPath: string): string | null {
  const root = path.resolve(WORKSPACE_DIR);
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(root + path.sep)) return null;
  return `workspace/${path.relative(root, resolved).split(path.sep).join('/')}`;
}

/** Find an available filename in `dir`: on collision try `name_1`, `name_2`, … */
async function availablePath(dir: string, base: string): Promise<string> {
  const extIdx = base.lastIndexOf('.');
  const stem = extIdx > 0 ? base.slice(0, extIdx) : base;
  const ext = extIdx > 0 ? base.slice(extIdx) : '';
  let candidate = base;
  let counter = 0;
  for (;;) {
    const p = path.join(dir, candidate);
    try {
      await fs.access(p);
      counter++;
      candidate = `${stem}_${counter}${ext}`;
    } catch {
      return p;
    }
  }
}

/** The storage name for a download: the user's filename, ASCII-folded, re-extensioned when the
 *  bytes disagree with what it claimed to be. The Unicode original travels on `DownloadedFile.name`
 *  and reaches the model through the prompt and the UI through the attachment card. */
function storageName(displayName: string, sniffed: string | null): string {
  const base = sanitizeStorageFilename(displayName);
  const wantExt = sniffed ? imageMimeExtension(sniffed) : null;
  if (!wantExt) return base;
  const ext = path.extname(base).toLowerCase();
  if (ext === wantExt || (wantExt === '.jpg' && ext === '.jpeg')) return base;
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem || 'file'}${wantExt}`;
}

async function sniffFile(filePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    return sniffImageMime(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Settle a freshly downloaded file: believe its bytes over its metadata, and store it under the
 * name the user sent it as.
 *
 * Only files the adapter wrote into `ownedDir` are renamed — an adapter that hands back a
 * reference to a file it does not own (the TUI passes the user's own path through) keeps its
 * location, and only its mimetype is corrected.
 */
export async function finalizeInboundFile(file: DownloadedFile, ownedDir: string): Promise<DownloadedFile> {
  const displayName = sanitizeDisplayFilename(file.name || path.basename(file.localPath));
  const sniffed = await sniffFile(file.localPath);
  // Bytes first, then what the platform said, then the name — Feishu hands a `file` message over
  // with no mimetype at all, and an empty string reaches the UI as an undownloadable card.
  const mimetype = sniffed ?? (file.mimetype || extToMime(displayName));
  const owned = path.resolve(path.dirname(file.localPath)) === path.resolve(ownedDir);
  if (!owned) return { localPath: file.localPath, mimetype, name: displayName };

  const target = await availablePath(ownedDir, storageName(displayName, sniffed));
  if (path.resolve(target) !== path.resolve(file.localPath)) {
    try {
      await fs.rename(file.localPath, target);
    } catch (error) {
      log.warn(`could not rename ${file.localPath}: ${(error as Error).message}`);
      return { localPath: file.localPath, mimetype, name: displayName };
    }
  }
  return { localPath: target, mimetype, name: displayName };
}

/**
 * Delete inbound attachment directories older than `maxAgeDays`.
 *
 * Age, not liveness: an attachment is read during the turn it arrives on (the backend is handed a
 * path, and it reads the file within that turn), so nothing that matters is still pending days
 * later. Only the per-message directories this module creates are swept — `<sessionId>/` uploads
 * from the web composer are the UI's to keep, since its file cards link to them for as long as the
 * transcript lives.
 */
export async function pruneInboundAttachments(
  maxAgeDays: number,
  now: () => number = Date.now,
): Promise<number> {
  if (!(maxAgeDays > 0)) return 0;
  const cutoff = now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(ATTACHMENTS_DIR);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(INBOUND_PREFIX)) continue;
    const dir = path.join(ATTACHMENTS_DIR, entry);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed++;
    } catch (error) {
      log.warn(`could not prune ${dir}: ${(error as Error).message}`);
    }
  }
  return removed;
}

/** The transcript card for an inbound attachment, or null for a file stored outside the workspace
 *  (the UI serves `workspace/…` paths only, so a TUI passthrough has nothing to link to). */
export async function inboundAttachmentMeta(file: DownloadedFile): Promise<AttachmentMeta | null> {
  const relPath = workspaceRelPath(file.localPath);
  if (!relPath) return null;
  let size = 0;
  try {
    size = (await fs.stat(file.localPath)).size;
  } catch {
    return null;
  }
  return {
    name: file.name || path.basename(file.localPath),
    path: relPath,
    size,
    mimeType: file.mimetype,
    type: classifyAttachment(file.mimetype),
  };
}
