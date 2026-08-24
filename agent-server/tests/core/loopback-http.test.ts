// input:  loopback HTTP helper, local HTTP server
// output: JSON request and explicit timeout behavior tests
// pos:    Verifies bounded MCP-to-daemon loopback requests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestLoopbackJson } from '../../src/core/loopback-http.js';

async function withServer(
  handler: RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('requestLoopbackJson sends and parses JSON', async () => {
  await withServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
  }, async (baseUrl) => {
    const result = await requestLoopbackJson('POST', `${baseUrl}/probe`, { value: 7 });
    assert.deepEqual(result, { status: 200, body: { method: 'POST', body: { value: 7 } } });
  });
});

test('requestLoopbackJson destroys a request at its explicit deadline', async () => {
  await withServer((_req, res) => {
    setTimeout(() => res.end('{}'), 100);
  }, async (baseUrl) => {
    await assert.rejects(
      requestLoopbackJson('GET', `${baseUrl}/slow`, undefined, {}, 20),
      /timed out after 20ms/,
    );
  });
});
