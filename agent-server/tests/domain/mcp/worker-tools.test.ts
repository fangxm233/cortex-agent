import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_TOOLS_BY_SERVER } from '../../../src/core/mcp-tool-gate.js';
import { createBundledServer } from '../../../src/domain/mcp/bundled-server.js';
import { toolContextFromEnv } from '../../../src/domain/mcp/tools/context.js';

test('cortex-workers registers the five worker tools, each proxied to /webhook/team for its session', async () => {
  const received: Array<{ url: string; body: any }> = [];
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body.action === 'stop'
        ? { success: false, error: 'no worker named "x"' }
        : { success: true, data: { text: `did ${body.action}` } }));
    });
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const server = await createBundledServer(['cortex-workers'], toolContextFromEnv({
    WEBHOOK_PORT: String(port), CORTEX_WEBHOOK_TOKEN: 't', CORTEX_SESSION_ID: 'lead-1',
    CORTEX_SUBAGENT_PI_MODELS: JSON.stringify([{ backend: 'pi', provider: 'deepseek', id: 'deepseek-v4-flash' }]),
  }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'workers-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [...MCP_TOOLS_BY_SERVER['cortex-workers']].sort());
    const spawn = tools.find(t => t.name === 'worker_spawn')!;
    assert.match(spawn.description!, /one-shot `agent` tool/);
    assert.match(spawn.description!, /end your turn/);
    assert.match(spawn.description!, /keeps your current model/);
    const props = (spawn.inputSchema as any).properties;
    assert.deepEqual(Object.keys(props).sort(), ['backend', 'model', 'name', 'prompt']);
    assert.deepEqual(props.backend.enum, ['claude', 'pi']);
    assert.match(props.model.description, /^Optional model: provider\/model\[:thinking\] for a pi worker/);
    assert.match(props.model.description, /pi: deepseek\/deepseek-v4-flash/, 'the host catalog is listed');
    assert.match(props.backend.description, /Both backends have models configured/);

    const ok = await client.callTool({ name: 'worker_spawn', arguments: { name: 'a', prompt: 'do it' } });
    assert.equal(ok.isError ?? false, false);
    assert.equal((ok.content as any)[0].text, 'did spawn');
    const failed = await client.callTool({ name: 'worker_stop', arguments: { worker: 'x' } });
    assert.equal(failed.isError, true);
    assert.match((failed.content as any)[0].text, /no worker named/);

    assert.deepEqual(received.map(r => [r.url, r.body.action, r.body.sessionId]), [
      ['/webhook/team', 'spawn', 'lead-1'],
      ['/webhook/team', 'stop', 'lead-1'],
    ]);
    assert.equal(received[0].body.prompt, 'do it');
  } finally {
    await client.close();
    await server.close();
    await new Promise<void>(r => http.close(() => r()));
  }
});

test('cortex-worker-report registers only mark_routine, proxied to /webhook/team for the worker session', async () => {
  const received: any[] = [];
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { text: 'Marked routine.' } }));
    });
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const server = await createBundledServer(['cortex-worker-report'], toolContextFromEnv({
    WEBHOOK_PORT: String(port), CORTEX_WEBHOOK_TOKEN: 't', CORTEX_SESSION_ID: 'worker-1',
  }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'worker-report-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), [...MCP_TOOLS_BY_SERVER['cortex-worker-report']]);
    assert.deepEqual(tools.map(t => t.name), ['mark_routine']);
    assert.match(tools[0].description!, /before your final reply/);
    assert.deepEqual(Object.keys((tools[0].inputSchema as any).properties ?? {}), [], 'no arguments');
    const result = await client.callTool({ name: 'mark_routine', arguments: {} });
    assert.equal((result.content as any)[0].text, 'Marked routine.');
    assert.deepEqual(received.map(b => [b.action, b.sessionId]), [['routine', 'worker-1']]);
  } finally {
    await client.close();
    await server.close();
    await new Promise<void>(r => http.close(() => r()));
  }
});
