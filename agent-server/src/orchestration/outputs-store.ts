import * as path from 'path';
import { promises as fs } from 'fs';
import { WORKSPACE_DIR } from '@core/paths.js';

/** Physical directory backing the UI-relative `workspace/outputs/` prefix. */
const OUTPUTS_DIR = path.join(WORKSPACE_DIR, 'outputs');

const MAX_FILENAME_BYTES = 200;

/** Bound a Unicode filename without splitting code points, retaining a short extension when possible. */
function truncateDisplayFilename(name: string): string {
  if (Buffer.byteLength(name) <= MAX_FILENAME_BYTES) return name;
  const ext = path.extname(name);
  const keptExt = Buffer.byteLength(ext) <= 32 ? ext : '';
  const stem = keptExt ? name.slice(0, -keptExt.length) : name;
  let result = '';
  let bytes = Buffer.byteLength(keptExt);
  for (const char of stem) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > MAX_FILENAME_BYTES) break;
    result += char;
    bytes += charBytes;
  }
  return `${result || 'file'}${keptExt}`;
}

/** Preserve a safe Unicode leaf name for display and client-side downloads. */
export function sanitizeDisplayFilename(name: string): string {
  const leaf = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = leaf.replace(/[\u0000-\u001F\u007F]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  return truncateDisplayFilename(cleaned);
}

/** Derive a narrow ASCII-only basename used solely for internal workspace storage. */
export function sanitizeStorageFilename(displayName: string): string {
  const ext = path.extname(displayName);
  const safeExt = /^\.[A-Za-z0-9]{1,16}$/.test(ext) ? ext : '';
  const stem = safeExt ? displayName.slice(0, -ext.length) : displayName;
  const asciiStem = stem
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  const safeStem = asciiStem || 'file';
  return `${safeStem.slice(0, MAX_FILENAME_BYTES - safeExt.length)}${safeExt}`;
}

/** Find an available filename in `dir`: on collision try `name_1`, `name_2`, … */
async function resolveAvailablePath(dir: string, base: string): Promise<{ destPath: string; finalName: string }> {
  const extIdx = base.lastIndexOf('.');
  const stem = extIdx > 0 ? base.slice(0, extIdx) : base;
  const ext = extIdx > 0 ? base.slice(extIdx) : '';
  let candidate = base;
  let counter = 0;
  while (true) {
    const p = path.join(dir, candidate);
    try {
      await fs.access(p);
      counter++;
      candidate = `${stem}_${counter}${ext}`;
    } catch {
      return { destPath: p, finalName: candidate };
    }
  }
}

export interface StoredOutput {
  /** UI-relative path under `workspace/` (what the file card + download endpoint reference). */
  relPath: string;
  name: string;
  size: number;
}

/** Resolve the session's outputs directory, optionally one `subdir` deep. `subdir` is a fixed
 *  caller-supplied literal (`views`), never user or model input, so no traversal check is needed
 *  beyond the one the download endpoint already applies on read. */
function outputsDir(sessionId: string, subdir?: string): { dir: string; relPrefix: string } {
  const parts = subdir ? [sessionId, subdir] : [sessionId];
  return {
    dir: path.join(OUTPUTS_DIR, ...parts),
    relPrefix: `workspace/outputs/${parts.join('/')}`,
  };
}

/** Claim a free destination inside the session's outputs area, creating the directory. Shared by
 *  every lander so naming, collision handling and placement cannot drift between them. */
async function reserveOutputPath(a: { sessionId: string; fileName: string; subdir?: string }): Promise<{
  destPath: string; relPath: string; displayName: string;
}> {
  const displayName = sanitizeDisplayFilename(a.fileName);
  const storageName = sanitizeStorageFilename(displayName);
  const { dir, relPrefix } = outputsDir(a.sessionId, a.subdir);
  await fs.mkdir(dir, { recursive: true });
  const { destPath, finalName } = await resolveAvailablePath(dir, storageName);
  return { destPath, relPath: `${relPrefix}/${finalName}`, displayName };
}

/**
 * Copy an agent-produced file into the session's `workspace/outputs/…` area and return its
 * UI-relative path + final name + byte size. Copying (rather than referencing the source in
 * place) gives every agent-sent file a predictable location strictly under WORKSPACE_DIR, so the
 * download endpoint can serve it with a single-root traversal guard and never expose arbitrary
 * filesystem paths. Throws when the source is missing, is not a regular file, or exceeds `maxBytes`.
 */
export async function copyFileIntoOutputs(a: {
  sessionId: string; filePath: string; fileName?: string; subdir?: string; maxBytes?: number;
}): Promise<StoredOutput> {
  const resolvedSrc = path.isAbsolute(a.filePath) ? a.filePath : path.resolve(process.cwd(), a.filePath);
  let stat: import('fs').Stats;
  try {
    stat = await fs.stat(resolvedSrc);
  } catch {
    throw new Error(`File not found: ${resolvedSrc}`);
  }
  if (!stat.isFile()) throw new Error(`Not a file: ${resolvedSrc}`);
  if (a.maxBytes !== undefined && stat.size > a.maxBytes) {
    throw new Error(`File is ${stat.size} bytes, over the ${a.maxBytes}-byte limit`);
  }

  const { destPath, relPath, displayName } = await reserveOutputPath({
    sessionId: a.sessionId, fileName: a.fileName || path.basename(resolvedSrc), subdir: a.subdir,
  });
  await fs.copyFile(resolvedSrc, destPath);
  const outStat = await fs.stat(destPath);
  return { relPath, name: displayName, size: outStat.size };
}

/**
 * Land a file whose bytes are produced by `receive` (a remote-device transfer) directly in the
 * outputs area. Same placement and naming as `copyFileIntoOutputs`, but written once: staging to a
 * temp file first and copying would double the I/O of every large transfer and leave litter behind
 * when a send fails. A failing `receive` must leave nothing, so the reservation is removed here.
 */
export async function receiveIntoOutputs(
  a: { sessionId: string; fileName: string; subdir?: string },
  receive: (destPath: string) => Promise<void>,
): Promise<StoredOutput> {
  const { destPath, relPath, displayName } = await reserveOutputPath(a);
  try {
    await receive(destPath);
  } catch (e) {
    await fs.rm(destPath, { force: true }).catch(() => {});
    throw e;
  }
  const outStat = await fs.stat(destPath);
  return { relPath, name: displayName, size: outStat.size };
}

/** Write agent-authored text into the session's outputs area under `fileName`, same placement and
 *  naming discipline as `copyFileIntoOutputs`. Used when the payload arrives inline rather than as
 *  a path on disk. */
export async function writeTextIntoOutputs(a: {
  sessionId: string; text: string; fileName: string; subdir?: string;
}): Promise<StoredOutput> {
  const displayName = sanitizeDisplayFilename(a.fileName);
  const storageName = sanitizeStorageFilename(displayName);
  const { dir, relPrefix } = outputsDir(a.sessionId, a.subdir);
  await fs.mkdir(dir, { recursive: true });
  const { destPath, finalName } = await resolveAvailablePath(dir, storageName);
  await fs.writeFile(destPath, a.text, 'utf8');
  const outStat = await fs.stat(destPath);
  return { relPath: `${relPrefix}/${finalName}`, name: displayName, size: outStat.size };
}
