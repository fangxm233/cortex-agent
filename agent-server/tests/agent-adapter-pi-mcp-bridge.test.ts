// input:  PI MCP bridge logic plus a compiled ext-server transport
// output: content mapping, channel-loading policy, and cost_query call behavior
// pos:    bridge behavior tests; tool/export inventories and build-path smoke checks are excluded
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  mapMcpContent,
  shouldLoadFeishu,
  shouldLoadSlack,
  shouldLoadWeb,
} from '../src/agent-adapter/pi/mcp-bridge-logic.js';

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
