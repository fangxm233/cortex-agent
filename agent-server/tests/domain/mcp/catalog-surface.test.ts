import { beforeEach, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { CONFIG_DIR } from '../../../src/core/paths.js';
import type { McpBundleName } from '../../../src/core/mcp-bundles.js';
import { createBundledServer } from '../../../src/domain/mcp/bundled-server.js';
import { toolContextFromEnv } from '../../../src/domain/mcp/tools/context.js';
import { installToolShims } from '../../../src/agent-adapter/pi/tool-shims.js';
import { createMcpBridgeDeps, installMcpBridge } from '../../../src/agent-adapter/pi/mcp-bridge.js';

const catalogEnv = {
  CORTEX_SUBAGENT_CLAUDE_MODELS: JSON.stringify([{ backend: 'claude', id: 'known-claude' }]),
  CORTEX_CLAUDE_MODEL: 'parent-claude',
  CORTEX_SUBAGENT_PI_MODELS: JSON.stringify([{ backend: 'pi', provider: 'cached', id: 'daemon-model' }]),
};
const bundles: McpBundleName[] = ['cortex-core', 'cortex-workers'];

beforeEach(() => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(`${CONFIG_DIR}/machines.json`, JSON.stringify({ offlineBox: {}, winBox: { win: true } }));
});

async function listTools(allowlist?: string[], selected = bundles) {
  const ctx = toolContextFromEnv({ ...catalogEnv,
    ...(allowlist ? { CORTEX_MCP_TOOL_ALLOWLIST: JSON.stringify(allowlist) } : {}),
  });
  const server = await createBundledServer(selected, ctx);
  const client = new Client({ name: 'catalog-test', version: '1' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  try { return client.getServerCapabilities()?.tools ? (await client.listTools()).tools : []; }
  finally { await client.close(); await server.close(); }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test.each([
  { allowlist: undefined, selected: bundles, owner: 'agent', remote: 'remote_bash' },
  { allowlist: ['worker_spawn', 'remote_read'], selected: bundles, owner: 'worker_spawn', remote: 'remote_read' },
  { allowlist: ['agent', 'worker_spawn', 'remote_grep'], selected: bundles, owner: 'agent', remote: 'remote_grep' },
  { allowlist: undefined, selected: ['cortex-workers'] as McpBundleName[], owner: 'worker_spawn', remote: undefined },
])('visible surface chooses $owner and $remote as catalog owners', async ({ allowlist, selected, owner, remote }) => {
  const tools = await listTools(allowlist, selected);
  const json = JSON.stringify(tools);
  const description = tools.find(t => t.name === owner)!.description!;
  for (const model of ['known-claude', 'parent-claude', 'cached/daemon-model']) {
    assert.equal(occurrences(json, model), 1);
    assert.ok(description.includes(model));
  }
  assert.equal(occurrences(json, 'offlineBox'), remote ? 1 : 0);
  if (remote) assert.match(tools.find(t => t.name === remote)!.description!, /offlineBox, winBox \(Windows\)/);
  for (const tool of tools) assert.doesNotMatch(JSON.stringify(tool.inputSchema), /known-claude|offlineBox/);
});

test('no applicable tools means no catalog, including a leaf-like restricted surface', async () => {
  const tools = await listTools(['agent_stop', 'worker_list', 'current_time']);
  assert.doesNotMatch(JSON.stringify(tools), /Known models|Known devices|known-claude|offlineBox/);
  assert.deepEqual(await listTools([]), []);
});

function piHarness() {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(event: object, ctx: any) => unknown>>();
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: object, ctx: any) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const emit = async (name: string, ctx: object = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
  };
  return { pi, tools, emit };
}

async function piSurface(allowed: string, leaf = false) {
  const harness = piHarness();
  const env = { ...catalogEnv, CORTEX_PI_ALLOWED_TOOLS: allowed, CORTEX_PI_MCP_COMPOSITION: 'direct',
    CORTEX_PI_TEAM_LEAD: '1', ...(leaf ? { CORTEX_PI_SUBAGENT: '1' } : {}),
  };
  installToolShims(harness.pi, env);
  const deps = createMcpBridgeDeps(env, [], (selected, context) => createBundledServer(
    selected, toolContextFromEnv({ ...catalogEnv, ...context }),
  ));
  deps.reportFailure = error => { throw error; };
  await installMcpBridge(harness.pi, deps);
  await harness.emit('session_start', {
    model: { provider: 'runtime', id: 'parent-pi' },
    modelRegistry: { getAvailable: () => [{ provider: 'runtime', id: 'registry-model' }] },
  });
  try { await harness.emit('before_agent_start'); return [...harness.tools.values()]; }
  finally { await harness.emit('session_shutdown'); }
}

test('Pi native agent owns its runtime catalog; bridged workers do not repeat the daemon cache', async () => {
  const tools = await piSurface('Agent,Read');
  assert.ok(tools.some(t => t.name === 'worker_spawn'));
  assert.equal(tools.filter(t => t.name === 'agent').length, 1);
  const json = JSON.stringify(tools);
  for (const model of ['known-claude', 'parent-claude', 'runtime/registry-model', 'runtime/parent-pi']) {
    assert.equal(occurrences(json, model), 1);
    assert.ok(tools.find(t => t.name === 'agent')!.description.includes(model));
  }
  assert.doesNotMatch(json, /cached\/daemon-model/);
});

test('Pi with Agent withheld gives the bridged worker the daemon catalog', async () => {
  const tools = await piSurface('Read');
  assert.ok(!tools.some(t => t.name === 'agent'));
  assert.match(tools.find(t => t.name === 'worker_spawn')!.description, /cached\/daemon-model/);
  assert.equal(occurrences(JSON.stringify(tools), 'Known models'), 1);
});

test('Pi leaf exposes no delegation tools or model directory', async () => {
  const tools = await piSurface('Agent,Read', true);
  assert.ok(!tools.some(t => ['agent', 'worker_spawn'].includes(t.name)));
  assert.doesNotMatch(JSON.stringify(tools), /Known models|known-claude|registry-model/);
});


test.each([{ allowlist: undefined }, { allowlist: ['worker_spawn', 'remote_grep'] }])(
  'source stdio exposes deduplicated catalogs with gate $allowlist', async ({ allowlist }) => {
  const entry = fileURLToPath(new URL('../../../src/domain/mcp/bundled-server.ts', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', entry],
    env: { ...process.env, ...catalogEnv, CORTEX_MCP_BUNDLES: JSON.stringify(bundles),
      ...(allowlist ? { CORTEX_MCP_TOOL_ALLOWLIST: JSON.stringify(allowlist) } : {}),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'source-catalog-test', version: '1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(occurrences(JSON.stringify(tools), 'known-claude'), 1);
    assert.equal(occurrences(JSON.stringify(tools), 'offlineBox'), 1);
    if (allowlist) assert.deepEqual(tools.map(t => t.name).sort(), allowlist.slice().sort());
  } finally { await client.close(); await transport.close(); }
});
