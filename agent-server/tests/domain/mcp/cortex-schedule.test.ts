import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpBundleName } from '../../../src/core/mcp-bundles.js';
import { MCP_TOOLS_BY_SERVER, parseMcpToolAllowlist, RETIRED_MCP_TOOLS } from '../../../src/core/mcp-tool-gate.js';
import { createBundledServer } from '../../../src/domain/mcp/bundled-server.js';
import { toolContextFromEnv } from '../../../src/domain/mcp/tools/context.js';

const SCHEDULE_TOOLS = ['add', 'list', 'get', 'remove', 'pause', 'resume'].map(name => `cortex_schedule_${name}`);
const EXT_TOOLS = ['cortex_context', 'cost_query', 'query_executions', 'wait_cancel', 'wait_check', 'wait_create'];

async function withBundledClient(
  allowlist: string[] | undefined, run: (client: Client) => Promise<void>,
  bundles: McpBundleName[] = ['cortex-ext'],
): Promise<void> {
  const ctx = toolContextFromEnv({
    CORTEX_SESSION_ID: 'test-session', CORTEX_SESSION_NAME: 'cortex-test', CORTEX_PROJECT: 'nimbus',
    CORTEX_PROFILE: 'test-profile', CORTEX_BACKEND: 'pi',
    ...(allowlist ? { CORTEX_MCP_TOOL_ALLOWLIST: JSON.stringify(allowlist) } : {}),
  });
  const server = await createBundledServer(bundles, ctx);
  const client = new Client({ name: 'schedule-retirement-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test('schedule names are retired compatibility entries, not offered tools', () => {
  assert.deepEqual([...MCP_TOOLS_BY_SERVER['cortex-ext']].sort(), EXT_TOOLS);
  for (const name of SCHEDULE_TOOLS) assert.equal(RETIRED_MCP_TOOLS.has(name), true, name);
  assert.deepEqual([...parseMcpToolAllowlist(JSON.stringify([...SCHEDULE_TOOLS, 'cortex_context']))!], ['cortex_context']);
});

test('the actual ext surface omits all six schedule tools and preserves context', async () => {
  await withBundledClient(undefined, async client => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), EXT_TOOLS);
    assert.doesNotMatch(tools.find(tool => tool.name === 'cortex_context')!.description!, /cortex_schedule/);
    const result = await client.callTool({ name: 'cortex_context', arguments: {} });
    assert.equal(result.isError ?? false, false);
    const context = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.deepEqual(context, {
      sessionId: 'test-session', sessionName: 'cortex-test', profile: 'test-profile', project: 'nimbus',
      backend: 'pi', scheduleTaskId: null, callbackSource: null,
    });
  });
});

test('the direct Web composition omits schedule tools across the full bundle surface', async () => {
  const bundles: McpBundleName[] = ['cortex-core', 'cortex-ext', 'cortex-interaction-bridge', 'cortex-web'];
  await withBundledClient(undefined, async client => {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, bundles.flatMap(bundle => [...MCP_TOOLS_BY_SERVER[bundle]]).sort());
    assert.ok(names.includes('cortex_context'));
    for (const name of SCHEDULE_TOOLS) assert.equal(names.includes(name), false, name);
  }, bundles);
});

test('an old allowlist can keep context without resurrecting schedule tools', async () => {
  await withBundledClient([...SCHEDULE_TOOLS, 'cortex_context'], async client => {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['cortex_context']);
  });
});

test('a schedule-only old allowlist produces an empty surface', async () => {
  await withBundledClient(SCHEDULE_TOOLS, async client => {
    assert.equal(client.getServerCapabilities()?.tools, undefined);
    await assert.rejects(client.listTools(), { code: -32601 });
  });
});
