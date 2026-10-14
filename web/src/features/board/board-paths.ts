// A board lives in `<project>/boards/<slug>/`. Everything the body references — an image under
// `assets/`, a `data-open` link — is written relative to that directory, and resolving it is the
// one check between agent-written HTML and the board asset route: the result must stay inside the
// board's own directory.

export function boardDir(slug: string): string {
  return `boards/${slug}/`;
}

export function boardBodyPath(slug: string): string {
  return `${boardDir(slug)}board.html`;
}

/** Legacy files a migrated board may carry instead of a body. */
export const LEGACY_BOARD_FILES = ['ledger.md', 'contract.md'] as const;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve a body-relative reference to a project-relative path inside `boards/<slug>/`, or null.
 * Rejects schemes (`https:`, `data:`, `javascript:`), absolute and protocol-relative paths,
 * fragments, backslashes, and any `..` that climbs out of the board directory.
 */
export function resolveBoardRef(slug: string, ref: string): string | null {
  let raw = ref.trim();
  if (!raw || !slug || slug.includes('/') || slug === '..' || slug === '.') return null;
  if (SCHEME.test(raw) || raw.startsWith('/') || raw.startsWith('#')) return null;
  raw = raw.split('#')[0]!.split('?')[0]!;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (raw.includes('\\') || raw.includes('\0')) return null;
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return null;
  return boardDir(slug) + out.join('/');
}

export function fileNameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);

/** How a linked board file previews: as media, or (null) left to the document classifier. */
export function mediaKindOfName(name: string): 'image' | 'video' | null {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}
