// input:  domain/mcp/server module
// output: server module loads without Slack env, unknown tool behavior unchanged
// pos:    regression guard — split may change server initialization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { importFresh } from '../../module-loader.js';

test('server module loads without Slack env vars', async () => {
  const originalToken = process.env.SLACK_BOT_TOKEN;
  const originalChannel = process.env.SLACK_CHANNEL;

  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CHANNEL;

  try {
    const mod = await importFresh('../src/domain/mcp/server.js');
    assert.ok(mod, 'server module loaded successfully');
    assert.ok(Array.isArray(mod.TOOL_NAMES), 'TOOL_NAMES is an array');
  } finally {
    if (originalToken !== undefined) process.env.SLACK_BOT_TOKEN = originalToken;
    else delete process.env.SLACK_BOT_TOKEN;
    if (originalChannel !== undefined) process.env.SLACK_CHANNEL = originalChannel;
    else delete process.env.SLACK_CHANNEL;
  }
});

test('unknown tool behavior is unchanged via MCP SDK (no custom catch-all handler registered)', async () => {
  // The MCP SDK's default behavior for unknown tool names is to return a JSON-RPC
  // error with code -32601 (Method Not Found). The server adds no catch-all — it
  // registers 10 named tools (slack + cost + executions + cortex_context + 6 cortex_schedule_*)
  // and delegates everything else to the SDK. This test verifies the registration shape
  // (no wildcards, no duplicates) without locking the count, so adding a future tool
  // doesn't trip this regression in addition to tools-registration.test.ts.
  const mod = await import('../../../src/domain/mcp/server.js');
  const names: readonly string[] = mod.TOOL_NAMES;

  assert.ok(names.length > 0, 'at least one tool registered');
  assert.equal(new Set(names).size, names.length, 'no duplicate registrations');

  // Verify no tool name looks like a catch-all (empty, wildcard, regex, etc.)
  for (const name of names) {
    assert.ok(name.length > 0, 'tool name is non-empty');
    assert.ok(!name.includes('*'), 'no wildcard tool names');
    assert.ok(!name.includes('?'), 'no pattern tool names');
  }
});
