// input:  vitest + createAppUpdateRoutes / buildAppUpdateManifest / parseAppAssetName + fake releases
// output: unit tests — asset-name parsing (six shipped forms + rejects); release selection (newest
//         with app assets ≤ server version, digest fail-closed, -N suffix ordering); manifest route
//         (shape, no-store, method guard, {} on no release, TTL caching, failure fallback).
// pos:    Regression guard for the server side of app shell self-update. Routes are mounted via
//         ui-http-server customRoutes (auth-gated there); these tests exercise the handlers.
// >>> If I am updated, update the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  APP_UPDATE_MANIFEST_PATH,
  buildAppUpdateManifest,
  createAppUpdateRoutes,
  parseAppAssetName,
  type GhRelease,
} from '@platform/ui-http/app-update.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SHA = 'a'.repeat(64);

function asset(name: string, opts: { digest?: string | null; size?: number } = {}) {
  return {
    name,
    size: opts.size ?? 1000,
    digest: opts.digest === undefined ? `sha256:${SHA}` : opts.digest,
    browser_download_url: `https://github.com/o/r/releases/download/x/${name}`,
  };
}

function release(version: string, assetNames: string[], opts: { body?: string } = {}): GhRelease {
  return {
    tag_name: `server-v${version}`,
    html_url: `https://github.com/o/r/releases/tag/server-v${version}`,
    published_at: '2026-07-30T00:00:00Z',
    body: opts.body ?? `notes for ${version}`,
    assets: assetNames.map((n) => asset(n)),
  };
}

const SIX_ASSETS = [
  'Cortex-2026.7.30-Linux-x86_64.AppImage',
  'Cortex-2026.7.30-Linux-amd64.deb',
  'Cortex-2026.7.30-Linux-x86_64.rpm',
  'Cortex-2026.7.30-Windows-x86_64-setup.exe',
  'Cortex-2026.7.30-macOS-universal.dmg',
  'Cortex-2026.7.30-Android-arm64.apk',
];

// ─── parseAppAssetName ──────────────────────────────────────────────────────

test('parseAppAssetName: parses all six shipped asset forms', () => {
  assert.deepEqual(parseAppAssetName('Cortex-2026.7.30-Linux-x86_64.AppImage'), {
    version: '2026.7.30', os: 'linux', arch: 'x86_64', kind: 'appimage',
  });
  // deb arch spelling amd64 is normalized to x86_64 so the shell matches on one arch name.
  assert.deepEqual(parseAppAssetName('Cortex-2026.7.30-Linux-amd64.deb'), {
    version: '2026.7.30', os: 'linux', arch: 'x86_64', kind: 'deb',
  });
  assert.deepEqual(parseAppAssetName('Cortex-2026.7.30-Linux-x86_64.rpm'), {
    version: '2026.7.30', os: 'linux', arch: 'x86_64', kind: 'rpm',
  });
  assert.deepEqual(parseAppAssetName('Cortex-2026.7.30-Windows-x86_64-setup.exe'), {
    version: '2026.7.30', os: 'windows', arch: 'x86_64', kind: 'nsis',
  });
  assert.deepEqual(parseAppAssetName('Cortex-2026.7.30-macOS-universal.dmg'), {
    version: '2026.7.30', os: 'macos', arch: 'universal', kind: 'dmg',
  });
  // arm64 is normalized to aarch64 (the Rust target_arch spelling the shell matches on).
  assert.deepEqual(parseAppAssetName('Cortex-2026.7.30-Android-arm64.apk'), {
    version: '2026.7.30', os: 'android', arch: 'aarch64', kind: 'apk',
  });
});

test('parseAppAssetName: keeps the -N hotfix suffix inside the version', () => {
  assert.equal(parseAppAssetName('Cortex-2026.7.30-2-Linux-x86_64.AppImage')?.version, '2026.7.30-2');
});

test('parseAppAssetName: rejects non-app assets', () => {
  assert.equal(parseAppAssetName('SHA256SUMS.txt'), null);
  assert.equal(parseAppAssetName('cortex-2026.7.30-Linux-x86_64.AppImage'), null); // wrong prefix case
  assert.equal(parseAppAssetName('Cortex-2026.7.30-FreeBSD-x86_64.tar.gz'), null); // unknown OS/ext
  assert.equal(parseAppAssetName('Cortex-2026.7.30-Linux-x86_64.zip'), null); // unknown ext
});

// ─── buildAppUpdateManifest ─────────────────────────────────────────────────

test('manifest selection: newest release with app assets not above the server version', () => {
  const releases = [
    release('2026.8.5', SIX_ASSETS), // above server version — must be skipped
    release('2026.7.30', SIX_ASSETS),
    release('2026.7.20', ['Cortex-2026.7.20-Linux-x86_64.AppImage']),
  ];
  const m = buildAppUpdateManifest(releases, '2026.7.30');
  assert.ok(m);
  assert.equal(m.version, '2026.7.30');
  assert.equal(m.assets.length, 6);
  assert.equal(m.releaseUrl, 'https://github.com/o/r/releases/tag/server-v2026.7.30');
  assert.equal(m.notes, 'notes for 2026.7.30');
  const apk = m.assets.find((a) => a.kind === 'apk');
  assert.ok(apk);
  assert.equal(apk.os, 'android');
  assert.equal(apk.sha256, SHA);
  assert.equal(apk.url, `https://github.com/o/r/releases/download/x/${apk.name}`);
});

test('manifest selection: releases without app assets are skipped over', () => {
  const releases = [
    release('2026.7.29', []), // SPA-only release — no native assets
    release('2026.7.20', ['Cortex-2026.7.20-Linux-x86_64.AppImage']),
  ];
  const m = buildAppUpdateManifest(releases, '2026.7.29');
  assert.equal(m?.version, '2026.7.20');
});

test('manifest selection: -N hotfix suffix sorts above the plain version', () => {
  const releases = [
    release('2026.7.30', ['Cortex-2026.7.30-Linux-x86_64.AppImage']),
    release('2026.7.30-2', ['Cortex-2026.7.30-2-Linux-x86_64.AppImage']),
  ];
  const m = buildAppUpdateManifest(releases, '2026.7.30-2');
  assert.equal(m?.version, '2026.7.30-2');
});

test('manifest selection: an asset without a sha256 digest is excluded (fail closed)', () => {
  const rel = release('2026.7.30', []);
  rel.assets = [
    asset('Cortex-2026.7.30-Linux-x86_64.AppImage', { digest: null }),
    asset('Cortex-2026.7.30-Android-arm64.apk'),
  ];
  const m = buildAppUpdateManifest([rel], '2026.7.30');
  assert.equal(m?.assets.length, 1);
  assert.equal(m?.assets[0]?.kind, 'apk');
});

test('manifest selection: null when nothing qualifies', () => {
  assert.equal(buildAppUpdateManifest([], '2026.7.30'), null);
  assert.equal(
    buildAppUpdateManifest([release('2026.8.1', SIX_ASSETS)], '2026.7.30'),
    null,
    'only-above-server releases must yield null',
  );
  // A qualifying release whose every asset lacks a digest offers nothing installable.
  const rel = release('2026.7.20', []);
  rel.assets = [asset('Cortex-2026.7.20-Linux-x86_64.AppImage', { digest: null })];
  assert.equal(buildAppUpdateManifest([rel], '2026.7.30'), null);
});

test('manifest selection: non-server tags and malformed tags are ignored', () => {
  const rel = release('2026.7.20', ['Cortex-2026.7.20-Linux-x86_64.AppImage']);
  const clientRel = { ...release('2026.7.25', SIX_ASSETS), tag_name: 'client-v2026.7.25' };
  const m = buildAppUpdateManifest([clientRel, rel], '2026.7.30');
  assert.equal(m?.version, '2026.7.20');
});

// ─── Route ──────────────────────────────────────────────────────────────────

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, headers?: Record<string, string>): FakeRes;
  end(chunk?: Buffer | string): void;
}

function fakeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = String(v);
      return this;
    },
    end(chunk) { if (chunk) this.body += chunk.toString(); },
  };
}

async function callManifest(routes: Record<string, any>, method = 'GET'): Promise<FakeRes> {
  const handler = routes[APP_UPDATE_MANIFEST_PATH];
  assert.ok(handler, 'manifest route must be registered');
  const res = fakeRes();
  await handler({ method, url: APP_UPDATE_MANIFEST_PATH, headers: {} }, res);
  return res;
}

test('route: serves the manifest as no-store JSON', async () => {
  const routes = createAppUpdateRoutes({
    serverVersion: '2026.7.30',
    fetchReleases: async () => [release('2026.7.30', SIX_ASSETS)],
  });
  const res = await callManifest(routes);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const m = JSON.parse(res.body);
  assert.equal(m.version, '2026.7.30');
  assert.equal(m.assets.length, 6);
});

test('route: serves {} when no qualifying release exists', async () => {
  const routes = createAppUpdateRoutes({
    serverVersion: '2026.7.30',
    fetchReleases: async () => [],
  });
  const res = await callManifest(routes);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {});
});

test('route: serves {} when the GitHub fetch fails', async () => {
  const routes = createAppUpdateRoutes({
    serverVersion: '2026.7.30',
    fetchReleases: async () => { throw new Error('github down'); },
  });
  const res = await callManifest(routes);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {});
});

test('route: method guard rejects POST with 405', async () => {
  const routes = createAppUpdateRoutes({
    serverVersion: '2026.7.30',
    fetchReleases: async () => [],
  });
  const res = await callManifest(routes, 'POST');
  assert.equal(res.statusCode, 405);
});

test('route: caches the release list within the TTL, refetches after expiry', async () => {
  let calls = 0;
  let nowMs = 1_000_000;
  const routes = createAppUpdateRoutes({
    serverVersion: '2026.7.30',
    fetchReleases: async () => { calls += 1; return [release('2026.7.30', SIX_ASSETS)]; },
    ttlMs: 60_000,
    now: () => nowMs,
  });
  await callManifest(routes);
  await callManifest(routes);
  assert.equal(calls, 1, 'second call within the TTL must not refetch');
  nowMs += 61_000;
  await callManifest(routes);
  assert.equal(calls, 2, 'a call after TTL expiry must refetch');
});

test('route: a failed refetch keeps serving the last good manifest', async () => {
  let calls = 0;
  let nowMs = 0;
  const routes = createAppUpdateRoutes({
    serverVersion: '2026.7.30',
    fetchReleases: async () => {
      calls += 1;
      if (calls > 1) throw new Error('github down');
      return [release('2026.7.30', SIX_ASSETS)];
    },
    ttlMs: 60_000,
    now: () => nowMs,
  });
  const first = JSON.parse((await callManifest(routes)).body);
  nowMs += 61_000;
  const second = JSON.parse((await callManifest(routes)).body);
  assert.equal(calls, 2);
  assert.deepEqual(second, first, 'stale-but-good beats empty on refetch failure');
});
