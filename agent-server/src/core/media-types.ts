import * as path from 'node:path';

/** Mimetypes a backend can read as an image attachment. Both the prompt builder (which decides how
 *  an attachment is described to the agent) and the platform file router classify against the same
 *  two sets, so they live below both rather than in either one. */
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska']);

/** Canonical extension per image mime, for naming a file whose declared type turned out to be a lie. */
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
};

/** The mime a file's first bytes actually declare, or null when they are not a known image.
 *
 *  A platform's metadata is a claim, not a fact: Feishu hands every inbound image out as
 *  `image_key` with no type at all (Cortex called them all PNG), Slack can mislabel, and a user
 *  can rename anything. Backends sniff the bytes themselves, so a wrong mime never broke reading —
 *  it broke everything that classifies on the declared value (prompt bucket, UI attachment kind,
 *  the extension the file is stored under). */
export function sniffImageMime(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 6 && head.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (head.length >= 12
    && head.subarray(0, 4).toString('latin1') === 'RIFF'
    && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.length >= 2 && head.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  return null;
}

/** The extension an image mime should be stored under, or null for a mime with no fixed one. */
export function imageMimeExtension(mimeType: string): string | null {
  return IMAGE_MIME_EXTENSIONS[mimeType] ?? null;
}

/** Extension → MIME for the files Cortex serves or hands to a client: the SPA's own build output,
 *  and the workspace files agents and users exchange. One table, so a file the agent sends and the
 *  same file downloaded later can never disagree about what it is. Unknown → octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.xhtml': 'application/xhtml+xml', '.xml': 'application/xml',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json',
  '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown', '.log': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.woff2': 'font/woff2',
};

export const OCTET_STREAM = 'application/octet-stream';

/** MIME type for a file name or path, by extension (case-insensitive). */
export function mimeTypeForPath(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? OCTET_STREAM;
}

/** The `Content-Type` header value for a MIME type: text-like types declare UTF-8. */
export function contentTypeHeader(mimeType: string): string {
  const textLike = mimeType.startsWith('text/') || mimeType === 'application/json'
    || mimeType === 'application/xml' || mimeType === 'application/xhtml+xml';
  return textLike ? `${mimeType}; charset=utf-8` : mimeType;
}
