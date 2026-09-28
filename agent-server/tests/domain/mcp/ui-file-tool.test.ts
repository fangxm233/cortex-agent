import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerUiFileTools } from '../../../src/domain/mcp/tools/ui-file.js';
import { toolContextFromEnv } from '../../../src/domain/mcp/tools/context.js';

type Body = Record<string, any>;

/** Daemon stub: answers like /webhook/ui-file — an array for a `files` group, one meta otherwise. */
async function withSendFile(run: (call: (args: Body) => Promise<any>, received: Body[]) => Promise<void>): Promise<void> {
  const received: Body[] = [];
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(body);
      const meta = (p: string) => ({ name: path.basename(p), size: 3 });
      const data = body.files ? body.files.map((f: Body) => meta(f.filePath)) : meta(body.filePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    });
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const ctx = toolContextFromEnv({
    WEBHOOK_PORT: String((http.address() as AddressInfo).port),
    CORTEX_WEBHOOK_TOKEN: 't', CORTEX_SESSION_ID: 'sess-ui',
  });
  const server = new McpServer({ name: 'test-web', version: '0' });
  registerUiFileTools(server, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    await run(args => client.callTool({ name: 'send_file', arguments: args }), received);
  } finally {
    await client.close();
    await server.close();
    await new Promise<void>(r => http.close(() => r()));
  }
}

async function tmpFiles(...names: string[]): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-file-tool-'));
  return Promise.all(names.map(async n => { const p = path.join(dir, n); await fs.writeFile(p, 'abc'); return p; }));
}

test('send_file sends several files as one group with a single caption', async () => {
  const [a, b] = await tmpFiles('loss.png', 'report.pdf');
  await withSendFile(async (call, received) => {
    const result = await call({ files: [{ file_path: a }, { file_path: b, file_name: 'final.pdf' }], caption: 'results' });
    assert.equal(result.isError ?? false, false);
    assert.deepEqual(received, [{
      sessionId: 'sess-ui', caption: 'results',
      files: [{ filePath: a }, { filePath: b, fileName: 'final.pdf' }],
    }]);
    assert.match(result.content[0].text, /Sent 2 files[\s\S]*loss\.png[\s\S]*report\.pdf/);
  });
});

test('send_file with file_path keeps the single-file wire shape', async () => {
  const [a] = await tmpFiles('run.log');
  await withSendFile(async (call, received) => {
    const result = await call({ file_path: a, caption: 'log' });
    assert.equal(result.isError ?? false, false);
    assert.deepEqual(received, [{ sessionId: 'sess-ui', caption: 'log', filePath: a }]);
    assert.match(result.content[0].text, /Sent file to the user: run\.log/);
  });
});

test('send_file refuses a bad call before it reaches the daemon', async () => {
  const [a] = await tmpFiles('x.txt');
  await withSendFile(async (call, received) => {
    const bad = [
      {},
      { files: [] },
      { file_path: a, files: [{ file_path: a }] },
      { files: [{ file_path: a }, { file_path: '/no/such/file-xyz.bin' }] },
      { files: [{ file_path: 'relative.png' }], device: 'win-pc' },
    ];
    for (const args of bad) {
      const result = await call(args);
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.deepEqual(received, []);
  });
});
