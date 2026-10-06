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

/**
 * Identity of the build on disk, cheap enough to check per request: Vite rewrites index.html on
 * every build. Null while index.html is absent — the middle of a rebuild that emptied the dir.
 */
function buildStamp(spaDir: string): string | null {
  try {
    const st = fs.statSync(path.join(spaDir, 'index.html'));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * Build the OTA custom-route map for the given SPA directory. Returns an empty map (OTA disabled)
 * when the SPA is not built. The bundle is built lazily and cached per build: the SPA itself is
 * served live from disk, so a `web/dist` rebuild without a server restart must reach the native
 * shells too, not only browsers.
 */
export function createOtaRoutes(spaDir: string | undefined): Record<string, CustomRouteHandler> {
  if (!spaDir || !fs.existsSync(spaDir)) return {};

  // `stamp: null` = not known to match any build; mid-rebuild (no index.html) keeps the last bundle.
  let cached: { stamp: string | null; bundle: OtaBundle } | undefined;
  const bundle = (): OtaBundle => {
    const stamp = buildStamp(spaDir);
    if (cached && (stamp === null || cached.stamp === stamp)) return cached.bundle;
    const built = buildBundle(spaDir);
    // A rebuild that landed while we were reading may have mixed two builds: serve it, but do not
    // file it under this stamp, so the next request reads the settled directory again.
    cached = { stamp: buildStamp(spaDir) === stamp ? stamp : null, bundle: built };
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
