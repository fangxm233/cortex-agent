// input:  _test exports from mcp-bridge + MCP SDK
// output: mapMcpContent unit + listTools/cost_query integration
// pos:    PI mcp-bridge content mapping and integration test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { _test } from '../src/agent-adapter/pi/mcp-bridge.js';
// Source-of-truth tool lists — assert the built servers match what the source declares,
// so this test self-maintains instead of drifting against hardcoded counts.
import { TOOL_NAMES as CORE_TOOLS } from '../src/domain/mcp/core-server.js';
import { TOOL_NAMES as SLACK_TOOLS } from '../src/domain/mcp/slack-server.js';
import { TOOL_NAMES as WEB_TOOLS } from '../src/domain/mcp/web-server.js';
import { FEISHU_TOOL_NAMES as FEISHU_TOOLS } from '../src/domain/mcp/feishu/index.js';

const { mapMcpContent, shouldLoadSlack, shouldLoadFeishu, shouldLoadWeb } = _test;

// The CORE_SERVER_PATH / EXT_SERVER_PATH exported from mcp-bridge resolves relative to its own
// location: when loaded via tsx from src/ those siblings don't exist; when running compiled from
// dist/ they do. For the integration tests below we always target the compiled dist/ files so the
// test verifies the deployed (npm install) behavior — `npm run build` must have run first.
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(TESTS_DIR, '../dist');
const CORE_SERVER_PATH = resolve(DIST_DIR, 'domain/mcp/core-server.js');
const EXT_SERVER_PATH = resolve(DIST_DIR, 'domain/mcp/server.js');
const SLACK_SERVER_PATH = resolve(DIST_DIR, 'domain/mcp/slack-server.js');
const FEISHU_SERVER_PATH = resolve(DIST_DIR, 'domain/mcp/feishu-server.js');
const WEB_SERVER_PATH = resolve(DIST_DIR, 'domain/mcp/web-server.js');

const EXT_TOOLS = [
  'cost_query', 'query_executions',
  'cortex_context',
  'cortex_schedule_add', 'cortex_schedule_list', 'cortex_schedule_get',
  'cortex_schedule_remove', 'cortex_schedule_pause', 'cortex_schedule_resume',
];

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

// --- Path constants sanity ---

test('compiled core-server.js exists at expected dist location', () => {
  assert.ok(existsSync(CORE_SERVER_PATH), `expected ${CORE_SERVER_PATH} on disk — run \`npm run build\` first`);
});

test('compiled server.js exists at expected dist location', () => {
  assert.ok(existsSync(EXT_SERVER_PATH), `expected ${EXT_SERVER_PATH} on disk — run \`npm run build\` first`);
});

test('compiled slack-server.js exists at expected dist location', () => {
  assert.ok(existsSync(SLACK_SERVER_PATH), `expected ${SLACK_SERVER_PATH} on disk — run \`npm run build\` first`);
});

test('compiled feishu-server.js exists at expected dist location', () => {
  assert.ok(existsSync(FEISHU_SERVER_PATH), `expected ${FEISHU_SERVER_PATH} on disk — run \`npm run build\` first`);
});

test('compiled web-server.js exists at expected dist location', () => {
  assert.ok(existsSync(WEB_SERVER_PATH), `expected ${WEB_SERVER_PATH} on disk — run \`npm run build\` first`);
});

// --- Test A: listTools integration (real MCP subprocesses) ---

test('core-server exposes its declared TOOL_NAMES via StdioClientTransport', { timeout: 15000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CORE_SERVER_PATH],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-core-server', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of CORE_TOOLS) {
      assert.ok(names.includes(expected), `expected tool '${expected}' in core-server listTools`);
    }
    assert.equal(names.length, CORE_TOOLS.length, `expected exactly ${CORE_TOOLS.length} tools in core-server`);
  } finally {
    await transport.close();
  }
});

test('ext-server exposes 9 non-remote tools via StdioClientTransport', { timeout: 15000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [EXT_SERVER_PATH],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-ext-server', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of EXT_TOOLS) {
      assert.ok(names.includes(expected), `expected tool '${expected}' in ext-server listTools`);
    }
    assert.equal(names.length, EXT_TOOLS.length, `expected exactly ${EXT_TOOLS.length} tools in ext-server`);
  } finally {
    await transport.close();
  }
});

test('slack-server exposes its declared SLACK_TOOL_NAMES via StdioClientTransport', { timeout: 15000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SLACK_SERVER_PATH],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-slack-server', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of SLACK_TOOLS) {
      assert.ok(names.includes(expected), `expected tool '${expected}' in slack-server listTools`);
    }
    assert.equal(names.length, SLACK_TOOLS.length, `expected exactly ${SLACK_TOOLS.length} tools in slack-server`);
  } finally {
    await transport.close();
  }
});

test('web-server exposes its declared TOOL_NAMES via StdioClientTransport', { timeout: 15000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [WEB_SERVER_PATH],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-web-server', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of WEB_TOOLS) {
      assert.ok(names.includes(expected), `expected tool '${expected}' in web-server listTools`);
    }
    assert.equal(names.length, WEB_TOOLS.length, `expected exactly ${WEB_TOOLS.length} tools in web-server`);
  } finally {
    await transport.close();
  }
});

test('feishu-server exposes its declared FEISHU_TOOL_NAMES via StdioClientTransport', { timeout: 15000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [FEISHU_SERVER_PATH],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-feishu-server', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of FEISHU_TOOLS) {
      assert.ok(names.includes(expected), `expected tool '${expected}' in feishu-server listTools`);
    }
    assert.equal(names.length, FEISHU_TOOLS.length, `expected exactly ${FEISHU_TOOLS.length} tools in feishu-server`);
  } finally {
    await transport.close();
  }
});

// --- Test B: cost_query returns text content (via ext-server) ---

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
