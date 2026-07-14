// input:  Node test runner + createOtaRoutes (frontend OTA custom routes) + fake req/res
// output: unit tests — no-SPA → no routes; manifest shape (version/sha256/size/url) + content-type;
//         bundle content-type + bytes match manifest (size + sha256); content-addressed version
//         (stable for identical content, changes when a file changes); method guard (405 on POST).
// pos:    Regression guard for the server side of desktop frontend OTA (unit A). Routes are mounted
//         via ui-http-server customRoutes (auth-gated there); these tests exercise the handlers.
// >>> If I am updated, update the parent folder's CORTEX.md <<<

import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createOtaRoutes,
  UI_OTA_MANIFEST_PATH,
  UI_OTA_BUNDLE_PATH,
} from '@platform/ui-http/ui-ota.js';

const tmpDirs: string[] = [];
test.after(() => {
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

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  headersSent: boolean;
  writeHead(status: number, headers?: Record<string, string>): FakeRes;
  setHeader(k: string, v: string): void;
  write(chunk: Buffer | string): boolean;
  end(chunk?: Buffer | string): void;
  readonly body: Buffer;
}

function fakeRes(): FakeRes {
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
      this.headersSent = true;
      return this;
    },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
    get body() { return Buffer.concat(chunks); },
  };
}

function fakeReq(method: string, url: string): any {
  return { method, url, headers: {} };
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

test('registers both manifest and bundle routes when spaDir exists', () => {
  const dir = makeSpa({ 'index.html': '<html>hi</html>' });
  const routes = createOtaRoutes(dir);
  assert.ok(UI_OTA_MANIFEST_PATH in routes);
  assert.ok(UI_OTA_BUNDLE_PATH in routes);
});

test('manifest: returns JSON with version/sha256/size/url', async () => {
  const dir = makeSpa({ 'index.html': '<html>hi</html>', 'app.js': 'x=1' });
  const routes = createOtaRoutes(dir);
  const res = await callRoute(routes, 'GET', UI_OTA_MANIFEST_PATH);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /application\/json/);
  const m = JSON.parse(res.body.toString('utf8'));
  assert.equal(typeof m.version, 'string');
  assert.ok(m.version.length > 0);
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(m.size) && m.size > 0);
  assert.equal(m.url, UI_OTA_BUNDLE_PATH);
});

test('bundle: application/zip whose bytes match the manifest size and sha256', async () => {
  const dir = makeSpa({ 'index.html': '<html>hi</html>', 'assets/app.js': 'console.log(1)' });
  const routes = createOtaRoutes(dir);
  const manifest = JSON.parse((await callRoute(routes, 'GET', UI_OTA_MANIFEST_PATH)).body.toString('utf8'));
  const res = await callRoute(routes, 'GET', UI_OTA_BUNDLE_PATH);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /application\/zip/);
  assert.equal(res.body.length, manifest.size, 'bundle length must equal manifest.size');
  const sha = crypto.createHash('sha256').update(res.body).digest('hex');
  assert.equal(sha, manifest.sha256, 'bundle sha256 must equal manifest.sha256');
  // Sanity: the archive is a real ZIP.
  assert.equal(res.body.readUInt32LE(0), 0x04034b50);
});

test('version is content-addressed: stable for identical content across separate builds', async () => {
  const files = { 'index.html': '<html>same</html>', 'a.js': 'a=1' };
  const dirA = makeSpa(files);
  const dirB = makeSpa(files);
  const mA = JSON.parse((await callRoute(createOtaRoutes(dirA), 'GET', UI_OTA_MANIFEST_PATH)).body.toString('utf8'));
  const mB = JSON.parse((await callRoute(createOtaRoutes(dirB), 'GET', UI_OTA_MANIFEST_PATH)).body.toString('utf8'));
  assert.equal(mA.version, mB.version, 'identical content must yield identical version');
});

test('version changes when a file changes', async () => {
  const dir1 = makeSpa({ 'index.html': '<html>v1</html>' });
  const dir2 = makeSpa({ 'index.html': '<html>v2</html>' });
  const m1 = JSON.parse((await callRoute(createOtaRoutes(dir1), 'GET', UI_OTA_MANIFEST_PATH)).body.toString('utf8'));
  const m2 = JSON.parse((await callRoute(createOtaRoutes(dir2), 'GET', UI_OTA_MANIFEST_PATH)).body.toString('utf8'));
  assert.notEqual(m1.version, m2.version, 'changed content must change the version');
});

test('method guard: a non-GET request is rejected 405', async () => {
  const dir = makeSpa({ 'index.html': '<html>hi</html>' });
  const routes = createOtaRoutes(dir);
  const res = await callRoute(routes, 'POST', UI_OTA_MANIFEST_PATH);
  assert.equal(res.statusCode, 405);
});
