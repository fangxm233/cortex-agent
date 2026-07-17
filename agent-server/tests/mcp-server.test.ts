// input:  Node test runner + dispatch-utils module
// output: MCP import safety + launch format tests
// pos:    Verify ext-server (server.ts) can be safely imported without Slack env
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { importFresh } from './module-loader.js';

async function loadMcpServerWithMissingEnv() {
  const originalToken = process.env.SLACK_BOT_TOKEN;
  const originalChannel = process.env.SLACK_CHANNEL;

  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CHANNEL;

  try {
    return importFresh('../src/domain/mcp/server.js');
  } finally {
    if (originalToken !== undefined) process.env.SLACK_BOT_TOKEN = originalToken;
    else delete process.env.SLACK_BOT_TOKEN;
    if (originalChannel !== undefined) process.env.SLACK_CHANNEL = originalChannel;
    else delete process.env.SLACK_CHANNEL;
  }
}

test('mcp-server can be imported without Slack env vars', async () => {
  // Should not throw — main() now warns instead of throwing
  const mod = await loadMcpServerWithMissingEnv();
  assert.ok(mod, 'mcp-server module loaded successfully');
});

