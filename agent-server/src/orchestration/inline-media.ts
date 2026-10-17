import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, resolveWorkspaceRelPath } from '@core/paths.js';
import { getMachineRegistry } from '@domain/remote/machine-registry.js';
import { fetchRemoteFile, prepareRemoteFetch } from '@domain/remote/device-file.js';
import type { InlineMediaErrorCode, ResolveMediaInput, ResolveMediaResult } from '@domain/ui-service/inline-media-types.js';

export const MAX_INLINE_MEDIA_BYTES = 200 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const inFlight = new Map<string, Promise<ResolveMediaResult>>();

type FileSource = { type: 'local'; filePath: string } | { type: 'device'; device: string; filePath: string };
export type MediaSource = FileSource | { type: 'workspace'; path: string } | { type: 'https'; url: string };

class MediaError extends Error {
  constructor(readonly code: InlineMediaErrorCode, reason: string) { super(reason); }
}

/** Device names are configuration keys, not arbitrary URI schemes or currently-online devices. */
export function parseMediaSrc(src: string): MediaSource {
  if (!src || src.includes('\0')) throw new MediaError('unsupported', 'Invalid media source');
  if (/^https:\/\//i.test(src)) return { type: 'https', url: new URL(src).href };
  if (src.startsWith('workspace/')) {
    if (!resolveWorkspaceRelPath(src)) throw new MediaError('unsupported', 'Invalid workspace path');
    return { type: 'workspace', path: src };
  }
  return parseFileSource(src);
}

function parseFileSource(src: string): FileSource {
  if (src.startsWith('~/')) return { type: 'local', filePath: path.join(os.homedir(), src.slice(2)) };
  if (path.isAbsolute(src)) return { type: 'local', filePath: src };
  const device = /^([^:/\\]+):(.*)$/s.exec(src);
  if (!device) return { type: 'local', filePath: path.resolve(DATA_DIR, src) };
  return parseDeviceSource(device[1], device[2]);
}

function parseDeviceSource(device: string, filePath: string): FileSource {
  const registered = Object.hasOwn(getMachineRegistry(), device);
  const absolute = path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
  if (!registered || !absolute) throw new MediaError('unsupported', 'Unknown device or non-absolute device path');
  return { type: 'device', device, filePath };
}

function mediaKind(ext: string): 'image' | 'video' {
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  throw new MediaError('unsupported', 'Unsupported image or video extension');
}

/** Remote transport predates structured errors; translate its boundary messages in one place. */
function mediaFailure(error: unknown): ResolveMediaResult {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof MediaError) return { error: { code: error.code, reason } };
  const codes: Array<[RegExp, InlineMediaErrorCode]> = [
    [/not online|disconnected|offline/i, 'offline'],
    [/ENOENT|ENOTDIR|File not found|Not a file/i, 'not_found'],
    [/over the \d+-byte limit/i, 'too_large'],
    [/client too old/i, 'unsupported'],
  ];
  const code = codes.find(([pattern]) => pattern.test(reason))?.[1] ?? 'load_failed';
  return { error: { code, reason } };
}

async function assertMediaFile(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new MediaError('not_found', 'Not a file');
  if (stat.size > MAX_INLINE_MEDIA_BYTES) throw new MediaError('too_large', 'Media exceeds the 200 MiB limit');
}

/** First successful snapshot wins for this message/source; failures are retryable. */
export async function snapshotInlineMedia(input: ResolveMediaInput): Promise<ResolveMediaResult> {
  try {
    if (!/^[\w-]+$/.test(input.sessionId)) throw new MediaError('unsupported', 'Invalid session ID');
    const source = parseMediaSrc(input.src);
    if (source.type === 'https') throw new MediaError('unsupported', 'HTTPS media must be loaded directly by the browser');
    return await resolveSource(input, source);
  } catch (error) {
    return mediaFailure(error);
  }
}

async function resolveSource(input: ResolveMediaInput, source: Exclude<MediaSource, { type: 'https' }>): Promise<ResolveMediaResult> {
  const filePath = source.type === 'workspace' ? source.path : source.filePath;
  const name = filePath.split(/[/\\]/).pop()!;
  const ext = path.extname(name).toLowerCase();
  const kind = mediaKind(ext);
  if (source.type === 'workspace') {
    await assertMediaFile(resolveWorkspaceRelPath(source.path)!);
    return { path: source.path, name, kind };
  }
  const hash = createHash('sha1').update(input.ts + input.src).digest('hex').slice(0, 16);
  const relPath = `workspace/outputs/${input.sessionId}/inline/${hash}${ext}`;
  const pending = inFlight.get(relPath);
  if (pending) return pending;
  const result = landSnapshot(source, relPath).then(() => ({ path: relPath, name, kind }));
  inFlight.set(relPath, result);
  try { return await result; } finally { inFlight.delete(relPath); }
}

async function exists(filePath: string): Promise<boolean> {
  try { await assertMediaFile(filePath); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Like outputs-store's local copy, but deterministic naming and staging preserve message versions. */
async function landSnapshot(source: FileSource, relPath: string): Promise<void> {
  const destPath = resolveWorkspaceRelPath(relPath)!;
  if (await exists(destPath)) return;
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const partial = `${destPath}.part`;
  try {
    await receiveSource(source, partial);
    // A local producer may have grown the file between stat and copy.
    await assertMediaFile(partial);
    await fs.rename(partial, destPath);
  } finally {
    await fs.rm(partial, { force: true }).catch(() => {});
  }
}

async function receiveSource(source: FileSource, destPath: string): Promise<void> {
  if (source.type === 'local') {
    await assertMediaFile(source.filePath);
    await fs.copyFile(source.filePath, destPath);
    return;
  }
  const args = { device: source.device, filePath: source.filePath, maxBytes: MAX_INLINE_MEDIA_BYTES };
  const stat = await prepareRemoteFetch(args);
  await fetchRemoteFile({ ...args, destPath, stat });
}
