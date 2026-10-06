import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createOtaRoutes,
  UI_OTA_MANIFEST_PATH,
  UI_OTA_BUNDLE_PATH,
} from '@platform/ui-http/ui-ota.js';
import { fakeReq, fakeRes, type FakeRes } from '../helpers/http.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function makeSpa(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-ota-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

async function callRoute(
  routes: Record<string, any>,
  method: string,
  urlPath: string,
): Promise<FakeRes> {
  const handler = routes[urlPath];
  assert.ok(handler, `route ${urlPath} must be registered`);
  const res = fakeRes();
  await handler(fakeReq(method, urlPath), res);
  return res;
}

test('no routes when spaDir is undefined', () => {
  const routes = createOtaRoutes(undefined);
  assert.deepEqual(Object.keys(routes), []);
});

test('no routes when spaDir does not exist on disk', () => {
  const routes = createOtaRoutes('/nonexistent/path/to/spa-xyz');
  assert.deepEqual(Object.keys(routes), []);
});

test('manifest: returns JSON with version/sha256/size/url', async () => {
  const dir = makeSpa({ 'index.html': '<html>hi</html>', 'app.js': 'x=1' });
  const routes = createOtaRoutes(dir);
  const res = await callRoute(routes, 'GET', UI_OTA_MANIFEST_PATH);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /application\/json/);
  const m = res.json();
  assert.equal(typeof m.version, 'string');
  assert.ok(m.version.length > 0);
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(m.size) && m.size > 0);
  // Version-stamped bundle URL (cache-busting) — path is UI_OTA_BUNDLE_PATH + `?v=<version>`.
  assert.equal(m.url, `${UI_OTA_BUNDLE_PATH}?v=${m.version}`);
  // Manifest must be marked uncacheable so an edge cache can't desync it from the bundle.
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('bundle: application/zip whose bytes match the manifest size and sha256', async () => {
  const dir = makeSpa({ 'index.html': '<html>hi</html>', 'assets/app.js': 'console.log(1)' });
  const routes = createOtaRoutes(dir);
  const manifest = (await callRoute(routes, 'GET', UI_OTA_MANIFEST_PATH)).json();
  const res = await callRoute(routes, 'GET', UI_OTA_BUNDLE_PATH);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /application\/zip/);
  assert.equal(res.body.length, manifest.size, 'bundle length must equal manifest.size');
  const sha = crypto.createHash('sha256').update(res.body).digest('hex');
  assert.equal(sha, manifest.sha256, 'bundle sha256 must equal manifest.sha256');
  // Sanity: the archive is a real ZIP.
  assert.equal(res.body.readUInt32LE(0), 0x04034b50);
  // Bundle must be marked uncacheable so an edge cache can't serve a stale build.
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('version is content-addressed: stable for identical content across separate builds', async () => {
  const files = { 'index.html': '<html>same</html>', 'a.js': 'a=1' };
  const dirA = makeSpa(files);
  const dirB = makeSpa(files);
  const mA = (await callRoute(createOtaRoutes(dirA), 'GET', UI_OTA_MANIFEST_PATH)).json();
  const mB = (await callRoute(createOtaRoutes(dirB), 'GET', UI_OTA_MANIFEST_PATH)).json();
  assert.equal(mA.version, mB.version, 'identical content must yield identical version');
});

test('version changes when a file changes', async () => {
  const dir1 = makeSpa({ 'index.html': '<html>v1</html>' });
  const dir2 = makeSpa({ 'index.html': '<html>v2</html>' });
  const m1 = (await callRoute(createOtaRoutes(dir1), 'GET', UI_OTA_MANIFEST_PATH)).json();
  const m2 = (await callRoute(createOtaRoutes(dir2), 'GET', UI_OTA_MANIFEST_PATH)).json();
  assert.notEqual(m1.version, m2.version, 'changed content must change the version');
});

test('method guard: a non-GET request is rejected 405', async () => {
  const dir = makeSpa({ 'index.html': '<html>hi</html>' });
  const routes = createOtaRoutes(dir);
  const res = await callRoute(routes, 'POST', UI_OTA_MANIFEST_PATH);
  assert.equal(res.statusCode, 405);
});

/** Age every file and directory under `dir`, as if the build finished `seconds` ago. */
function settle(dir: string, seconds = 10): void {
  const then = new Date(Date.now() - seconds * 1000);
  const walk = (p: string): void => {
    for (const d of readdirSync(p, { withFileTypes: true })) {
      const child = path.join(p, d.name);
      if (d.isDirectory()) walk(child);
      utimesSync(child, then, then);
    }
    utimesSync(p, then, then);
  };
  walk(dir);
}

test('a web/dist rebuild without a restart is served to the shells', async () => {
  const dir = makeSpa({ 'index.html': '<html>v1</html>', 'assets/app.js': 'a=1' });
  settle(dir, 20);
  const routes = createOtaRoutes(dir);
  const manifest = async () => (await callRoute(routes, 'GET', UI_OTA_MANIFEST_PATH)).json();
  const first = await manifest();
  assert.equal((await manifest()).version, first.version, 'unchanged build stays cached');

  // A rebuild that is still landing (fresh mtimes) keeps the last complete bundle…
  writeFileSync(path.join(dir, 'assets/app.js'), 'a=2');
  writeFileSync(path.join(dir, 'index.html'), '<html>v2</html>');
  assert.equal((await manifest()).version, first.version);
  // …and once it has settled, the new build is what the shells get.
  settle(dir);
  const rebuilt = await manifest();
  assert.notEqual(rebuilt.version, first.version);

  // Mid-rebuild with index.html not written yet: still the last complete bundle.
  rmSync(path.join(dir, 'index.html'));
  writeFileSync(path.join(dir, 'assets/app.js'), 'a=3');
  settle(dir);
  assert.equal((await manifest()).version, rebuilt.version);
});
