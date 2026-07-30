// input:  GitHub Releases API (injectable), @core/calver, @core/version
// output: createAppUpdateRoutes() -> GET /api/app-update/manifest.json custom route;
//         buildAppUpdateManifest / parseAppAssetName (pure, unit-tested)
// pos:    Server side of app shell self-update: advertises the newest GitHub release carrying
//         native app assets whose version is <= the running server version
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Coordination contract: the manifest is CAPPED at the server's own version, so a connected
// app is never offered a shell newer than the server it talks to (no ui-contract skew), and the
// only system-level update decision stays the server's own npm update prompt. Asset integrity
// comes from the GitHub-computed per-asset `digest` (sha256); assets without a digest are
// excluded (fail closed). Download bytes go straight to the GitHub CDN — this route serves JSON
// only. Mounted via ui-http-server customRoutes, so it inherits the same x-cortex-token /
// Access-JWT auth gate as tRPC.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { compareCalVer } from '@core/calver.js';
import { CORTEX_VERSION } from '@core/version.js';
import { createLogger } from '@core/log.js';
import type { CustomRouteHandler } from './ui-http-server.js';

const log = createLogger('app-update');

export const APP_UPDATE_MANIFEST_PATH = '/api/app-update/manifest.json';

const REPO_OWNER = 'fangxm233';
const REPO_NAME = 'cortex-agent';
const RELEASES_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100`;

/** Default manifest cache TTL. One unauthenticated GitHub API call per expiry (limit: 60/h/IP). */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
/** Release notes are surfaced in the app dialog — cap the body so the manifest stays small. */
const MAX_NOTES_CHARS = 8000;

// ─── GitHub API shapes (subset we read) ─────────────────────────────────────

export interface GhReleaseAsset {
  name: string;
  size: number;
  /** GitHub-computed content digest, `sha256:<hex>`. Absent/null on very old assets. */
  digest?: string | null;
  browser_download_url: string;
}

export interface GhRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  body?: string | null;
  assets: GhReleaseAsset[];
}

// ─── Manifest shapes (served to the shell) ──────────────────────────────────

export interface AppUpdateAsset {
  name: string;
  os: 'linux' | 'windows' | 'macos' | 'android';
  /** Normalized arch: x86_64 / aarch64 / universal. */
  arch: string;
  kind: 'appimage' | 'deb' | 'rpm' | 'nsis' | 'dmg' | 'apk';
  /** Direct GitHub CDN download URL. */
  url: string;
  size: number;
  /** SHA-256 (hex) of the asset bytes, from the GitHub asset digest. */
  sha256: string;
}

export interface AppUpdateManifest {
  version: string;
  releaseUrl: string;
  publishedAt: string;
  notes: string;
  assets: AppUpdateAsset[];
}

// ─── Pure parsing / selection ───────────────────────────────────────────────

/** `Cortex-<version>-<OS>-<arch>[-setup].<ext>` → parsed fields, or null for non-app assets. */
const ASSET_RE =
  /^Cortex-(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?)-(Linux|Windows|macOS|Android)-([A-Za-z0-9_]+?)(?:-setup)?\.(AppImage|deb|rpm|exe|dmg|apk)$/;

const KIND_BY_EXT: Record<string, AppUpdateAsset['kind']> = {
  AppImage: 'appimage', deb: 'deb', rpm: 'rpm', exe: 'nsis', dmg: 'dmg', apk: 'apk',
};

/** amd64 (deb spelling) and arm64 are folded onto the Rust target_arch names the shell matches on. */
const ARCH_ALIASES: Record<string, string> = { amd64: 'x86_64', arm64: 'aarch64' };

export function parseAppAssetName(
  name: string,
): { version: string; os: AppUpdateAsset['os']; arch: string; kind: AppUpdateAsset['kind'] } | null {
  const m = ASSET_RE.exec(name);
  if (!m) return null;
  const [, version, os, arch, ext] = m;
  return {
    version,
    os: os.toLowerCase() as AppUpdateAsset['os'],
    arch: ARCH_ALIASES[arch] ?? arch,
    kind: KIND_BY_EXT[ext],
  };
}

/** `sha256:<hex>` → lowercase hex, or null when the digest is absent or not sha256. */
function digestToSha256(digest: string | null | undefined): string | null {
  if (!digest) return null;
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(digest);
  return m ? m[1].toLowerCase() : null;
}

/** Version from a `server-v<version>` tag, or null for any other tag. */
function versionFromTag(tag: string): string | null {
  const m = /^server-v(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?)$/.exec(tag);
  return m ? m[1] : null;
}

/** App assets of one release that are installable (parseable name + sha256 digest present). */
function installableAssets(release: GhRelease): AppUpdateAsset[] {
  const out: AppUpdateAsset[] = [];
  for (const a of release.assets) {
    const parsed = parseAppAssetName(a.name);
    const sha256 = digestToSha256(a.digest);
    if (!parsed || !sha256) continue;
    out.push({
      name: a.name, os: parsed.os, arch: parsed.arch, kind: parsed.kind,
      url: a.browser_download_url, size: a.size, sha256,
    });
  }
  return out;
}

/**
 * Pick the newest release that (a) is a `server-v*` release, (b) carries at least one installable
 * app asset, and (c) is not newer than this server. Returns the manifest for it, or null.
 */
export function buildAppUpdateManifest(
  releases: GhRelease[],
  serverVersion: string,
): AppUpdateManifest | null {
  let best: { version: string; release: GhRelease; assets: AppUpdateAsset[] } | null = null;
  for (const release of releases) {
    const version = versionFromTag(release.tag_name);
    if (!version || compareCalVer(version, serverVersion) > 0) continue;
    const assets = installableAssets(release);
    if (assets.length === 0) continue;
    if (!best || compareCalVer(version, best.version) > 0) best = { version, release, assets };
  }
  if (!best) return null;
  return {
    version: best.version,
    releaseUrl: best.release.html_url,
    publishedAt: best.release.published_at,
    notes: (best.release.body ?? '').slice(0, MAX_NOTES_CHARS),
    assets: best.assets,
  };
}

// ─── Route (fetch + cache + serve) ──────────────────────────────────────────

async function defaultFetchReleases(): Promise<GhRelease[]> {
  const res = await fetch(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cortex-agent' },
  });
  if (!res.ok) throw new Error(`GitHub releases API ${res.status}`);
  return (await res.json()) as GhRelease[];
}

export interface AppUpdateRouteOptions {
  serverVersion?: string;
  fetchReleases?: () => Promise<GhRelease[]>;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Build the app-update custom-route map. The manifest is computed from the GitHub release list,
 * cached for `ttlMs`; a failed (re)fetch is also cached for the TTL (no GitHub hammering) and falls
 * back to the last good manifest, else `{}` — the shell treats a version-less body as "no update".
 */
export function createAppUpdateRoutes(
  opts: AppUpdateRouteOptions = {},
): Record<string, CustomRouteHandler> {
  const serverVersion = opts.serverVersion ?? CORTEX_VERSION;
  const fetchReleases = opts.fetchReleases ?? defaultFetchReleases;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;

  let lastGood: AppUpdateManifest | null = null;
  let fetchedAt: number | null = null;

  const manifest = async (): Promise<AppUpdateManifest | null> => {
    if (fetchedAt !== null && now() - fetchedAt < ttlMs) return lastGood;
    fetchedAt = now();
    try {
      lastGood = buildAppUpdateManifest(await fetchReleases(), serverVersion);
    } catch (e) {
      // Keep serving the previous manifest (stale-but-good beats empty); {} only before first success.
      log.warn(`release fetch failed: ${(e as Error).message}`);
    }
    return lastGood;
  };

  const handler: CustomRouteHandler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'Use GET' });
      return;
    }
    const m = await manifest();
    if (m) log.info(`manifest served: version=${m.version} assets=${m.assets.length}`);
    sendJson(res, 200, m ?? {});
  };

  return { [APP_UPDATE_MANIFEST_PATH]: handler };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    // Never edge-cached: a stale manifest would advertise the wrong version to the shell.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}
