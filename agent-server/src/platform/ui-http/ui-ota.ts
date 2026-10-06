import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createZip, type ZipEntry } from './zip-writer.js';
import { createLogger } from '@core/log.js';
import { sendNoStoreJson } from './http-json.js';
import type { CustomRouteHandler } from './ui-http-server.js';

const log = createLogger('ui-ota');

export const UI_OTA_MANIFEST_PATH = '/api/ui-ota/manifest.json';
export const UI_OTA_BUNDLE_PATH = '/api/ui-ota/bundle.zip';

/** Manifest the desktop shell polls to decide whether to download a new frontend. */
export interface UiOtaManifest {
  /** Content-addressed frontend id. Changes iff the SPA content changes. Opaque to the client. */
  version: string;
  /** SHA-256 (hex) of the ZIP bytes — the client verifies the download against this. */
  sha256: string;
  /** ZIP byte length. */
  size: number;
  /** Path to fetch the bundle from (same-origin). */
  url: string;
}

interface OtaBundle {
  manifest: UiOtaManifest;
  zip: Buffer;
}

/** Recursively collect files under `dir` as ZIP entries with POSIX-relative names, sorted by name. */
function collectEntries(dir: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, dirent.name);
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        walk(childAbs, childRel);
      } else if (dirent.isFile()) {
        entries.push({ name: childRel, data: fs.readFileSync(childAbs) });
      }
    }
  };
  walk(dir, '');
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/** Content digest over sorted `name\0sha256(content)\0` — independent of the ZIP container. */
function contentVersion(entries: ZipEntry[]): string {
  const hash = crypto.createHash('sha256');
  for (const e of entries) {
    hash.update(e.name);
    hash.update('\0');
    hash.update(crypto.createHash('sha256').update(e.data).digest('hex'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Build the ZIP + manifest from the SPA directory. */
function buildBundle(spaDir: string): OtaBundle {
  const entries = collectEntries(spaDir);
  const zip = createZip(entries);
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  const version = contentVersion(entries);
  return {
    zip,
    manifest: {
      version,
      sha256,
      size: zip.length,
      // Version-stamp the bundle URL. `bundle.zip` is a Cloudflare default-cached extension, and the
      // path is otherwise stable across redeploys — so an edge cache would keep serving an OLD bundle
      // against a NEW manifest, and the desktop/Android client would reject it on the sha256 check
      // ("bundle sha256 mismatch"). A per-version query string gives each build a distinct cache key,
      // so a new version is always a cache miss → fetched fresh. The router matches on pathname
      // (query stripped), so this stays the same custom route. Paired with `Cache-Control: no-store`
      // below as belt-and-suspenders.
      url: `${UI_OTA_BUNDLE_PATH}?v=${version}`,
    },
  };
}

/** How long a build must have been left alone before it counts as finished. Rollup writes every
 *  output file in parallel, so a fresh index.html says nothing about the chunks beside it. */
const BUILD_SETTLE_MS = 2000;

interface BuildStamp {
  /** Changes whenever any file or directory under the SPA dir changes. */
  key: string;
  /** Newest mtime seen, directories included — a deletion bumps its directory. */
  newestMs: number;
  hasIndex: boolean;
}

/** Identity of the build on disk, from stat alone (the dir is a few dozen files). */
function buildStamp(spaDir: string): BuildStamp {
  let files = 0;
  let bytes = 0;
  let newestMs = 0;
  const walk = (dir: string): void => {
    newestMs = Math.max(newestMs, fs.statSync(dir).mtimeMs);
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(child);
      } else if (dirent.isFile()) {
        const st = fs.statSync(child);
        files += 1;
        bytes += st.size;
        newestMs = Math.max(newestMs, st.mtimeMs);
      }
    }
  };
  try {
    walk(spaDir);
  } catch {
    // A file vanished mid-walk: a rebuild is under way, and a "now" newest says so.
    newestMs = Date.now();
  }
  return { key: `${files}:${bytes}:${newestMs}`, newestMs, hasIndex: fs.existsSync(path.join(spaDir, 'index.html')) };
}

/**
 * Build the OTA custom-route map for the given SPA directory. Returns an empty map (OTA disabled)
 * when the SPA is not built. The bundle is built lazily and cached per build: the SPA itself is
 * served live from disk, so a `web/dist` rebuild without a server restart must reach the native
 * shells too, not only browsers. While a rebuild is still landing, the last complete bundle keeps
 * being served — a shell that installed a half-written one would show a blank page.
 */
export function createOtaRoutes(spaDir: string | undefined): Record<string, CustomRouteHandler> {
  if (!spaDir || !fs.existsSync(spaDir)) return {};

  let cached: { key: string | null; bundle: OtaBundle } | undefined;
  const bundle = (): OtaBundle => {
    const stamp = buildStamp(spaDir);
    if (cached) {
      if (cached.key === stamp.key) return cached.bundle;
      if (!stamp.hasIndex || Date.now() - stamp.newestMs < BUILD_SETTLE_MS) return cached.bundle;
    }
    const built = buildBundle(spaDir);
    // Changed while we read it: serve it this once, but never file it as the build of record.
    cached = { key: buildStamp(spaDir).key === stamp.key ? stamp.key : null, bundle: built };
    return built;
  };

  const manifestHandler: CustomRouteHandler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendNoStoreJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'Use GET' });
      return;
    }
    const m = bundle().manifest;
    // Positive server-side signal that a client reached (and passed auth on) the OTA endpoint —
    // success was previously silent, so "no log" was ambiguous between not-reached and reached-ok.
    log.info(`manifest served: version=${m.version.slice(0, 12)} size=${m.size} method=${req.method}`);
    sendNoStoreJson(res, 200, m);
  };

  const bundleHandler: CustomRouteHandler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendNoStoreJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'Use GET' });
      return;
    }
    const { zip } = bundle();
    log.info(`bundle served: size=${zip.length} method=${req.method}`);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.length),
      // Prevent edge caching (Cloudflare caches `.zip` by default): a cached bundle served against a
      // newer manifest fails the client sha256 check. The versioned `?v=` URL is the primary guard;
      // this stops the origin response itself from being cached under any key.
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : zip);
  };

  return {
    [UI_OTA_MANIFEST_PATH]: manifestHandler,
    [UI_OTA_BUNDLE_PATH]: bundleHandler,
  };
}
