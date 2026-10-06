import * as path from 'node:path';
import { promises as fs } from 'node:fs';

// Naming rules for files stored under the workspace: a Unicode display name the user sees, and a
// narrow ASCII storage name that is safe on every filesystem and in every shell an agent runs.

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
export async function resolveAvailablePath(dir: string, base: string): Promise<{ destPath: string; finalName: string }> {
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
