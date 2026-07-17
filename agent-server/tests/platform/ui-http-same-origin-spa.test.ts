// input:  Node test runner + startUiHttpServer (package wiring) + a FAKE UiService + a temp SPA dir
// output: integration test — a SINGLE port serves BOTH the built SPA (index.html) same-origin AND
//         the token-gated /trpc endpoint. Covers the new default-spaDir resolution (opts.spaDir ??
//         CORTEX_UI_SPA_DIR) so agent-server's UI-on path serves web/dist without extra wiring.
// pos:    Regression guard for task 3606 same-origin serving (done_when 5). Fake UiService — no
//         store/@trpc-real-router dependency beyond the package's own AppRouter binding.
// >>> If I am updated, update the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before the core logger's paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startUiHttpServer } from '@entry/start-ui-http.js';
import type { UiService, UiEvent } from '@domain/ui-service/types.js';

const TOKEN = 'test-same-origin-token';
const INDEX_MARKER = '<!-- CORTEX-UI-SAME-ORIGIN-INDEX -->';

function makeFakeUiService(): UiService {
  const oneShot = (): AsyncIterable<UiEvent> & { close(): void } => ({
    async *[Symbol.asyncIterator]() { /* no events */ },
    close() { /* noop */ },
  });
  return {
    query: (async (scope: string) => {
      if (scope === 'projects.list') return { ok: true, data: [] };
      return { ok: false, code: 'not-found', message: `unexpected scope ${scope}` };
    }) as UiService['query'],
    mutate: (async () => ({ ok: false, code: 'not-found', message: 'n/a' })) as UiService['mutate'],
    subscribe: () => oneShot(),
    subscribeExecutionLog: () => oneShot(),
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {});
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

async function boot(env: Record<string, string>) {
  const inst = startUiHttpServer({ uiService: makeFakeUiService(), getToken: () => TOKEN, env });
  assert.ok(inst, 'expected a server when CORTEX_UI_HTTP is enabled');
  servers.push(inst!);
  if (!inst!.server.listening) {
    await new Promise<void>((resolve, reject) => {
      inst!.server.once('listening', () => resolve());
      inst!.server.once('error', reject);
    });
  }
  const addr = inst!.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no TCP address');
  return addr.port;
}

test('same-origin: one port serves index.html (from CORTEX_UI_SPA_DIR) AND gates /trpc', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-web-dist-'));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, 'index.html'), `<html><body>${INDEX_MARKER}</body></html>`);

  // No opts.spaDir — the package must resolve it from CORTEX_UI_SPA_DIR (the default-spaDir path).
  const port = await boot({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0', CORTEX_UI_SPA_DIR: dir });

  // SPA served same-origin at /
  const index = await get(port, '/');
  assert.equal(index.statusCode, 200);
  assert.ok(index.body.includes(INDEX_MARKER), 'GET / must serve index.html from the resolved spaDir');

  // Same port also hosts /trpc, still token-gated (401 without a token).
  const trpcNoAuth = await get(port, `/trpc/projects.list?input=${encodeURIComponent('{}')}`);
  assert.equal(trpcNoAuth.statusCode, 401);

  // With the token, /trpc returns 200 from the injected UiService.
  const trpcAuth = await get(port, `/trpc/projects.list?input=${encodeURIComponent('{}')}`, { 'x-cortex-token': TOKEN });
  assert.equal(trpcAuth.statusCode, 200);
  assert.deepEqual(JSON.parse(trpcAuth.body).result.data, []);
});
