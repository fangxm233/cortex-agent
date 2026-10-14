import { describe, test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createFileRoutes,
  BOARD_ASSET_PATH,
  DOWNLOAD_PATH,
  UPLOAD_PATH,
} from '@platform/ui-http/file-routes.js';
import { resolveMemoryFilePath } from '@domain/ui-service/query/memory.js';

const MAX = 4096;

let base: string;
let workspace: string;
let attachments: string;
let projectDir: string;
let server: http.Server;
let port: number;

beforeAll(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), 'cortex-file-routes-'));
  workspace = path.join(base, 'workspace');
  attachments = path.join(workspace, 'attachments');
  projectDir = path.join(base, 'project');
  mkdirSync(attachments, { recursive: true });
  mkdirSync(path.join(projectDir, 'boards', 'b1', 'assets'), { recursive: true });
  writeFileSync(path.join(projectDir, 'boards', 'b1', 'assets', 'chart.svg'), '<svg/>');
  writeFileSync(path.join(projectDir, 'mission.md'), 'secret');
  writeFileSync(path.join(base, 'outside.md'), 'secret');
  symlinkSync(path.join(base, 'outside.md'), path.join(projectDir, 'boards', 'b1', 'assets', 'escape.md'));

  const routes = createFileRoutes({
    attachmentsDir: attachments,
    resolveWorkspaceRelPath: (rel) => {
      if (!rel.startsWith('workspace/')) return null;
      const target = path.resolve(workspace, rel.slice('workspace/'.length));
      return target.startsWith(workspace + path.sep) ? target : null;
    },
    projectContextDir: (id) => (id === 'p1' ? projectDir : undefined),
    resolveMemoryFilePath,
    maxUploadBytes: MAX,
  });
  server = http.createServer((req, res) => {
    const handler = routes[(req.url ?? '').split('?')[0]];
    if (!handler) { res.writeHead(404); res.end(); return; }
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

interface Res { status: number; body: string; headers: http.IncomingHttpHeaders }

function request(
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body?: Buffer | Buffer[],
  pauseMs = 0,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    // agent: false — a rejected upload may close its socket once the drain cap is hit, so a
    // pooled keep-alive socket would leak one test's teardown into the next.
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf, headers: res.headers }));
    });
    r.on('error', reject);
    void (async () => {
      for (const chunk of Array.isArray(body) ? body : body ? [body] : []) {
        if (r.destroyed) return;
        r.write(chunk);
        if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
      r.end();
    })();
  });
}

const upload = (bucket: string, body: Buffer | Buffer[], extra: Record<string, string> = {}, pauseMs = 0) =>
  request('POST', UPLOAD_PATH, {
    'x-session-id': bucket,
    'x-file-name': encodeURIComponent('notes.txt'),
    'content-type': 'text/plain',
    ...extra,
  }, body, pauseMs);

const get = (urlPath: string) => request('GET', urlPath, {});

describe('upload', () => {
  test('stores the file under its bucket and answers with the workspace path', async () => {
    const res = await upload('3f2b8c1e-aaaa-4bbb-8ccc-123456789abc', Buffer.from('hello'));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).data, {
      name: 'notes.txt',
      path: 'workspace/attachments/3f2b8c1e-aaaa-4bbb-8ccc-123456789abc/notes.txt',
      size: 5,
      mimeType: 'text/plain',
      type: 'file',
    });
  });

  test('a session id that is not one path component never reaches the filesystem', async () => {
    for (const bucket of ['..', '../escaped', '../../escaped', 'a/b', 'a\\b', '.', 'x/../../escaped']) {
      const res = await upload(bucket, Buffer.from('pwned'));
      assert.equal(res.status, 400, `bucket ${JSON.stringify(bucket)}`);
      assert.equal(JSON.parse(res.body).code, 'bad-session');
    }
    assert.equal(existsSync(path.join(workspace, 'escaped')), false);
    assert.equal(existsSync(path.join(base, 'escaped')), false);
    assert.deepEqual(readdirSync(workspace), ['attachments']);
  });

  test('only POST uploads', async () => {
    const res = await request('GET', UPLOAD_PATH, { 'x-session-id': 's1', 'x-file-name': 'a.txt' });
    assert.equal(res.status, 405);
  });

  test('a declared length over the limit is refused before anything is written', async () => {
    const res = await upload('too-big-declared', Buffer.alloc(MAX * 2, 1), { 'content-length': String(MAX * 2) });
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.body).code, 'too-large');
    assert.equal(existsSync(path.join(attachments, 'too-big-declared')), false);
  });

  test('a body that outgrows the limit mid-stream gets a readable 413, not a reset', async () => {
    // No Content-Length (chunked), sent in pieces: the server only learns the size while reading.
    // It must answer on a live socket — a client whose connection is reset first sees a network
    // error, not "file too large".
    const chunks = Array.from({ length: 6 }, () => Buffer.alloc(1024, 2));
    const res = await upload('too-big-streamed', chunks, { 'transfer-encoding': 'chunked' }, 15);
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.body).code, 'too-large');
    assert.deepEqual(readdirSync(path.join(attachments, 'too-big-streamed')), [], 'partial file removed');
  });
});

describe('upload failure', () => {
  test('a storage error is answered, not left hanging or reset', async () => {
    const dir = path.join(attachments, 'read-only');
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      const res = await upload('read-only', Array.from({ length: 4 }, () => Buffer.alloc(512, 3)), {}, 5);
      assert.equal(res.status, 500);
      assert.equal(JSON.parse(res.body).code, 'upload-failed');
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('download', () => {
  beforeAll(() => {
    const dir = path.join(workspace, 'outputs', 's1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'page.html'), '<script>alert(1)</script>');
    writeFileSync(path.join(dir, 'icon.svg'), '<svg onload="alert(1)"/>');
    writeFileSync(path.join(dir, 'shot.png'), '<html>not really a png</html>');
    writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-1.4');
  });

  const fetchInline = (name: string) =>
    get(`${DOWNLOAD_PATH}?path=${encodeURIComponent(`workspace/outputs/s1/${name}`)}&disposition=inline`);

  test('HTML and SVG opened directly run sandboxed, never as the app origin', async () => {
    for (const name of ['page.html', 'icon.svg']) {
      const res = await fetchInline(name);
      assert.equal(res.status, 200);
      assert.match(String(res.headers['content-security-policy']), /^sandbox\b/, name);
      assert.doesNotMatch(String(res.headers['content-security-policy']), /allow-same-origin/, name);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', name);
    }
  });

  test('passive types are not sniffed, and PDFs stay viewable (no sandbox)', async () => {
    const png = await fetchInline('shot.png');
    assert.equal(png.headers['content-type'], 'image/png');
    assert.equal(png.headers['x-content-type-options'], 'nosniff');
    assert.equal(png.headers['content-security-policy'], undefined);
    const pdf = await fetchInline('paper.pdf');
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.headers['content-security-policy'], undefined);
  });

  test('a path outside the workspace is 403, a missing file 404', async () => {
    assert.equal((await get(`${DOWNLOAD_PATH}?path=${encodeURIComponent('workspace/../../etc/passwd')}`)).status, 403);
    assert.equal((await get(`${DOWNLOAD_PATH}?path=${encodeURIComponent('workspace/outputs/none.txt')}`)).status, 404);
  });
});

describe('board asset', () => {
  test('serves a file under boards/ with the same headers as a download', async () => {
    const res = await get(`${BOARD_ASSET_PATH}?projectId=p1&path=${encodeURIComponent('boards/b1/assets/chart.svg')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body, '<svg/>');
    assert.match(String(res.headers['content-security-policy']), /^sandbox\b/);
  });

  test('refuses paths outside boards/, traversal, symlink escape and unknown projects', async () => {
    assert.equal((await get(`${BOARD_ASSET_PATH}?projectId=p1&path=mission.md`)).status, 403);
    assert.equal((await get(`${BOARD_ASSET_PATH}?projectId=nope&path=boards/b1/assets/chart.svg`)).status, 404);
    assert.equal((await get(`${BOARD_ASSET_PATH}?projectId=p1&path=${encodeURIComponent('boards/../../x')}`)).status, 404);
    assert.equal((await get(`${BOARD_ASSET_PATH}?projectId=p1&path=${encodeURIComponent('boards/../mission.md')}`)).status, 404);
    assert.equal((await get(`${BOARD_ASSET_PATH}?projectId=p1&path=${encodeURIComponent('boards/b1/assets/escape.md')}`)).status, 404);
    assert.equal((await get(`${BOARD_ASSET_PATH}?projectId=p1&path=${encodeURIComponent('/etc/passwd')}`)).status, 403);
  });
});
