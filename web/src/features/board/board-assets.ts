import { resolveBoardRef } from './board-paths';

// The board frame has an opaque origin and no credentials, so it cannot fetch `assets/x.png`
// itself. The parent resolves every relative image reference against the board directory, fetches
// it through the authenticated asset route, and inlines it as a data URI before the body goes in.
// Images and videos also keep the reference as written, so a click in the frame can open the file
// itself in the app's viewer (see the bootstrap in board-document.ts).

export const ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const ASSETS_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
export const ASSETS_MAX_COUNT = 64;

export interface FetchedAsset {
  mime: string;
  bytes: Uint8Array;
}

/** Fetches one project-relative path, capped at `limit` bytes; null when missing or too large. */
export type AssetFetcher = (projectRelPath: string, limit: number) => Promise<FetchedAsset | null>;

// `src` / `poster` on media tags, `href` on SVG <image>, and `url(...)` in styles.
const MEDIA_TAG = /<(img|source|video|audio|image|input|track)\b[^>]*>/gi;
const MEDIA_ATTR = /(\s(?:src|poster|href|xlink:href)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi;
// What a comment wraps never renders, so it is never fetched (the scaffold's notes show an <img>).
// An unclosed comment runs to the end, as it does in the browser.
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/** Apply `edit` to the html between comments, leaving the comments as written. */
function outsideComments(html: string, edit: (part: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of html.matchAll(COMMENT)) {
    out += edit(html.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + edit(html.slice(last));
}

function eachRef(source: string, visit: (ref: string) => void): void {
  const html = source.replace(COMMENT, '');
  for (const tag of html.matchAll(MEDIA_TAG)) {
    for (const attr of tag[0].matchAll(MEDIA_ATTR)) visit(attr[2] ?? attr[3] ?? '');
  }
  for (const url of html.matchAll(CSS_URL)) visit(url[1] ?? url[2] ?? url[3] ?? '');
}

/** Board-directory paths the body references as media, deduplicated, in first-seen order. */
export function assetRefs(html: string, slug: string): string[] {
  const out = new Set<string>();
  eachRef(html, (ref) => {
    const path = resolveBoardRef(slug, ref);
    if (path) out.add(path);
  });
  return [...out];
}

// Tags whose own `src` is what a click opens: an image to zoom, a video to play at full size.
const OPENABLE_TAG = /^<(?:img|video|source)\b/i;
const SRC_ATTR = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** `data-board-src` keeps the reference as written once `src` is a data URI; `data-board-missing`
 *  marks a source that was not inlined (absent, over a cap), which the frame then shows as such. */
function openMarks(tag: string, slug: string, uris: Map<string, string>): string {
  if (!OPENABLE_TAG.test(tag)) return '';
  const src = tag.match(SRC_ATTR);
  const ref = src ? src[1] ?? src[2] ?? '' : '';
  const path = resolveBoardRef(slug, ref);
  if (!path) return '';
  const mark = ` data-board-src="${ref.replace(/"/g, '&quot;')}"`;
  return uris.has(path) ? mark : `${mark} data-board-missing=""`;
}

function replaceRefs(html: string, slug: string, uris: Map<string, string>): string {
  const swap = (ref: string): string | null => {
    const path = resolveBoardRef(slug, ref);
    return path ? uris.get(path) ?? null : null;
  };
  const swapTag = (tag: string): string => {
    const marks = openMarks(tag, slug, uris);
    const swapped = tag.replace(MEDIA_ATTR, (whole, lead: string, dq?: string, sq?: string) => {
      const uri = swap(dq ?? sq ?? '');
      return uri ? `${lead}"${uri}"` : whole;
    });
    return marks ? swapped.replace(/^<[a-z]+/i, (name) => name + marks) : swapped;
  };
  return outsideComments(html, (part) => part
    .replace(MEDIA_TAG, swapTag)
    .replace(CSS_URL, (whole, dq?: string, sq?: string, bare?: string) => {
      const uri = swap(dq ?? sq ?? bare ?? '');
      return uri ? `url("${uri}")` : whole;
    }));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Data URIs for the fetched assets that fit the per-asset cap and the running total. */
function dataUris(refs: string[], fetched: Array<FetchedAsset | null>): Map<string, string> {
  const uris = new Map<string, string>();
  let total = 0;
  refs.forEach((path, i) => {
    const asset = fetched[i];
    if (!asset || asset.bytes.byteLength > ASSET_MAX_BYTES) return;
    total += asset.bytes.byteLength;
    if (total > ASSETS_TOTAL_MAX_BYTES) return;
    const mime = asset.mime.split(';')[0]!.trim() || 'application/octet-stream';
    uris.set(path, `data:${mime};base64,${bytesToBase64(asset.bytes)}`);
  });
  return uris;
}

/**
 * Inline the body's board-relative media as data URIs. A reference that is outside the board is
 * left alone; one that is missing, over the per-asset cap, or past the count/total budget is left
 * as written and marked `data-board-missing` (it fails to load inside the frame, but a click still
 * opens the file).
 */
export async function inlineBoardAssets(html: string, slug: string, fetchAsset: AssetFetcher): Promise<string> {
  const refs = assetRefs(html, slug).slice(0, ASSETS_MAX_COUNT);
  if (refs.length === 0) return html;
  const fetched = await Promise.all(refs.map((path) => fetchAsset(path, ASSET_MAX_BYTES).catch(() => null)));
  return replaceRefs(html, slug, dataUris(refs, fetched));
}
