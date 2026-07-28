// input:  PI MCP bridge, fake clients, compiled MCP transport
// output: mapping, loading, retry, and stdio verification
// pos:    PI MCP bridge behavior tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  installMcpBridge,
  type McpBridgeDeps,
} from '../src/agent-adapter/pi/mcp-bridge.js';
import {
  mapMcpContent,
  shouldLoadFeishu,
  shouldLoadSlack,
  shouldLoadThreadControl,
  shouldLoadWeb,
} from '../src/agent-adapter/pi/mcp-bridge-logic.js';
import type { ExtensionAPI } from '../src/agent-adapter/pi/pi-ext-types.js';

// The CORE_SERVER_PATH / EXT_SERVER_PATH exported from mcp-bridge resolves relative to its own
// location: when loaded via tsx from src/ those siblings don't exist; when running compiled from
// dist/ they do. For the integration tests below we always target the compiled dist/ files so the
// test verifies the deployed (npm install) behavior — `npm run build` must have run first.
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(TESTS_DIR, '../dist');
const EXT_SERVER_PATH = resolve(DIST_DIR, 'domain/mcp/server.js');

// --- Test C: mapMcpContent pure unit tests ---

test('mapMcpContent: text item passes through', () => {
  assert.deepEqual(mapMcpContent({ type: 'text', text: 'hello' }), { type: 'text', text: 'hello' });
});

test('mapMcpContent: image item produces base64-length description', () => {
  const r = mapMcpContent({ type: 'image', data: 'abc', mimeType: 'image/png' });
  assert.equal(r.type, 'text');
  assert.ok(r.text.includes('image/png'), 'includes mimeType');
  assert.ok(r.text.includes('3'), 'includes data length');
});

test('mapMcpContent: resource with text passthrough', () => {
  const r = mapMcpContent({ type: 'resource', resource: { uri: 'f://x', text: 'content' } });
  assert.deepEqual(r, { type: 'text', text: 'content' });
});

test('mapMcpContent: resource with blob produces binary description', () => {
  const r = mapMcpContent({ type: 'resource', resource: { uri: 'f://x', blob: 'b64', mimeType: 'application/pdf' } });
  assert.equal(r.type, 'text');
  assert.ok(r.text.includes('f://x'), 'includes uri');
  assert.ok(r.text.includes('application/pdf'), 'includes mimeType');
});

test('mapMcpContent: unknown type falls back to JSON', () => {
  const item = { type: 'exotic', foo: 42 };
  const r = mapMcpContent(item);
  assert.equal(r.type, 'text');
  assert.equal(r.text, JSON.stringify(item));
});

// --- shouldLoadFeishu: gate the cortex-feishu server on Feishu-originated sessions ---

test('shouldLoadFeishu: true when channel carries the feishu: prefix', () => {
  assert.equal(shouldLoadFeishu('feishu:oc_abc123'), true);
});

test('shouldLoadFeishu: false for slack / bare / empty channels', () => {
  assert.equal(shouldLoadFeishu('slack:C0123'), false);
  assert.equal(shouldLoadFeishu('C0123'), false);
  assert.equal(shouldLoadFeishu(''), false);
  assert.equal(shouldLoadFeishu(undefined), false);
});

// --- shouldLoadWeb: gate the cortex-web server on Web-UI-originated sessions ---

test('shouldLoadWeb: true when channel carries the web: prefix', () => {
  assert.equal(shouldLoadWeb('web:abc123'), true);
});

test('shouldLoadWeb: false for slack / feishu / bare / empty channels', () => {
  assert.equal(shouldLoadWeb('slack:C0123'), false);
  assert.equal(shouldLoadWeb('feishu:oc_abc'), false);
  assert.equal(shouldLoadWeb('C0123'), false);
  assert.equal(shouldLoadWeb(''), false);
  assert.equal(shouldLoadWeb(undefined), false);
});

// --- shouldLoadSlack: gate the cortex-slack server on Slack-originated sessions ---

test('shouldLoadSlack: true when channel carries the slack: prefix', () => {
  assert.equal(shouldLoadSlack('slack:C0123ABC'), true);
});

test('shouldLoadSlack: false for feishu / bare / empty channels', () => {
  assert.equal(shouldLoadSlack('feishu:oc_abc123'), false);
  assert.equal(shouldLoadSlack('C0123'), false);
  assert.equal(shouldLoadSlack(''), false);
  assert.equal(shouldLoadSlack(undefined), false);
});

// --- shouldLoadThreadControl: gate lifecycle tools on thread context ---

test('shouldLoadThreadControl: true when CORTEX_THREAD_ID is present', () => {
  assert.equal(shouldLoadThreadControl('thr_abc123'), true);
});

test('shouldLoadThreadControl: false for empty or missing thread ids', () => {
  assert.equal(shouldLoadThreadControl(''), false);
  assert.equal(shouldLoadThreadControl(undefined), false);
});

type BridgeEvent = 'before_agent_start' | 'session_shutdown';
type BridgeHandler = (event: Record<string, never>, ctx: Record<string, never>) => Promise<void> | void;

function createPiHarness() {
  const handlers = new Map<BridgeEvent, BridgeHandler>();
  const registered: string[] = [];
  const pi = {
    on(event: BridgeEvent, handler: BridgeHandler) {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    registered,
    fire: async (event: BridgeEvent) => handlers.get(event)?.({}, {}),
  };
}

function fakeHandle(name: string, listTools: () => Promise<unknown> = async () => ({
  tools: [{ name: `${name}_tool`, description: name, inputSchema: { type: 'object' } }],
})) {
  return {
    client: {
      listTools,
      callTool: async () => ({ content: [{ type: 'text', text: name }] }),
    },
    transport: { close: async () => undefined },
  } as any;
}

function retryDeps(overrides: Partial<McpBridgeDeps>): McpBridgeDeps {
  return {
    env: { CORTEX_THREAD_ID: 'thr_retry' },
    reportFailure: () => undefined,
    spawnClient: async (_path, name) => fakeHandle(name),
    ...overrides,
  };
}

test('required MCP connect failure retries next turn without duplicate tools', async () => {
  const harness = createPiHarness();
  const attempts = new Map<string, number>();
  const failures: unknown[] = [];
  const deps = retryDeps({
    reportFailure: (error) => failures.push(error),
    spawnClient: async (_path, name) => {
      const attempt = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, attempt);
      if (name === 'tasks' && attempt === 1) throw new Error('tasks unavailable');
      return fakeHandle(name);
    },
  });

  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  assert.deepEqual(harness.registered, []);
  assert.equal(failures.length, 1);
  assert.match((failures[0] as Error).message, /tasks.*connect/);

  await harness.fire('before_agent_start');
  assert.deepEqual(harness.registered.sort(), ['core_tool', 'ext_tool', 'tasks_tool', 'thread_tool']);
  await harness.fire('before_agent_start');
  assert.equal(harness.registered.length, 4);
  assert.deepEqual(Object.fromEntries(attempts), { core: 1, tasks: 2, thread: 1, ext: 1 });
});

test('required MCP list failure retries discovery before registering tools', async () => {
  const harness = createPiHarness();
  const listAttempts = new Map<string, number>();
  const failures: unknown[] = [];
  const deps = retryDeps({
    reportFailure: (error) => failures.push(error),
    spawnClient: async (_path, name) => fakeHandle(name, async () => {
      const attempt = (listAttempts.get(name) ?? 0) + 1;
      listAttempts.set(name, attempt);
      if (name === 'thread' && attempt === 1) throw new Error('list unavailable');
      return { tools: [{ name: `${name}_tool`, description: name, inputSchema: { type: 'object' } }] };
    }),
  });

  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  assert.deepEqual(harness.registered, []);
  assert.equal(failures.length, 1);
  assert.match((failures[0] as Error).message, /thread.*list/);

  await harness.fire('before_agent_start');
  assert.deepEqual(harness.registered.sort(), ['core_tool', 'ext_tool', 'tasks_tool', 'thread_tool']);
  await harness.fire('before_agent_start');
  assert.equal(harness.registered.length, 4);
  assert.deepEqual(Object.fromEntries(listAttempts), { core: 2, tasks: 2, thread: 2, ext: 1 });
});

// Real transport integration: invoking one tool exercises server startup, registration, RPC, and mapping.

test('cost_query tool returns text content when called', { timeout: 15000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [EXT_SERVER_PATH],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-ext-server-cost', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'cost_query', arguments: {} });
    const mapped = (result.content as any[]).map(mapMcpContent);
    assert.ok(mapped.length > 0, 'cost_query should return at least one content item');
    assert.ok(mapped.every((c: any) => c.type === 'text'), 'all mapped content items should be text');
  } finally {
    await transport.close();
  }
});
