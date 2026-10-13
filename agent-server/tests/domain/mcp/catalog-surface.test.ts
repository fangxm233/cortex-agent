import { beforeEach, test, vi } from 'vitest';
import * as roles from '../../../src/core/agents/roles.js';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { CONFIG_DIR } from '../../../src/core/paths.js';
import type { McpBundleName } from '../../../src/core/mcp-bundles.js';
import { createBundledServer, openBundledMcpServer } from '../../../src/domain/mcp/bundled-server.js';
import { toolContextFromEnv } from '../../../src/domain/mcp/tools/context.js';
import { createCortexExtensions } from '../../../src/agent-adapter/pi/extensions.js';
import type { PiSessionRequest } from '../../../src/agent-adapter/pi/session-options.js';
import { registerWorkerTools } from '../../../src/domain/mcp/tools/workers.js';

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

test.each([{ allowlist: undefined }, { allowlist: ['agent'] }])('bad MCP roles preserve models without worker ($allowlist)', async ({ allowlist }) => {
  const failedRoles = vi.spyOn(roles, 'loadRoles').mockImplementation(() => { throw new Error('role read failed'); });
  try {
    const tools = await listTools(allowlist);
    const json = JSON.stringify(tools);
    assert.equal(occurrences(json, 'Known models'), 1);
    assert.match(tools.find(tool => tool.name === 'agent')!.description!, /known-claude/);
    assert.equal(occurrences(json, 'cached/daemon-model'), 1);
  } finally { failedRoles.mockRestore(); }
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

function snapshot(number: number): Record<string, string> {
  return {
    CORTEX_SUBAGENT_CLAUDE_MODELS: JSON.stringify([{ backend: 'claude', id: `cache-${number}-only-claude` }]),
    CORTEX_SUBAGENT_PI_MODELS: JSON.stringify([{ backend: 'pi', provider: 'cache', id: `model-${number}` }]),
  };
}

interface PiSurfaceOptions {
  allowed?: string;
  leaf?: boolean;
  mcpAllowlist?: string[];
  getSnapshot?: () => Record<string, string>;
}

async function piSurface(options: PiSurfaceOptions = {}) {
  const harness = piHarness();
  const env = { ...catalogEnv, CORTEX_PI_ALLOWED_TOOLS: options.allowed ?? 'Agent,Read',
    CORTEX_PI_MCP_COMPOSITION: 'direct', CORTEX_PI_TEAM_LEAD: '1',
    ...(options.leaf ? { CORTEX_PI_SUBAGENT: '1' } : {}),
    ...(options.mcpAllowlist ? { CORTEX_MCP_TOOL_ALLOWLIST: JSON.stringify(options.mcpAllowlist) } : {}),
  };
  let workerDescription = '';
  const extensions = createCortexExtensions(
    { env, disableHooks: true, pluginMcpServers: [] } as unknown as PiSessionRequest,
    { getSubagentModelEnv: options.getSnapshot, openBundledMcpServer: (selected, context) => {
      registerWorkerTools({ tool: (name: string, description: string) => {
        if (name === 'worker_spawn') workerDescription = description;
      } } as any, toolContextFromEnv(context));
      return openBundledMcpServer(selected, context);
    } },
  );
  for (const extension of extensions) await (typeof extension === 'function' ? extension : extension.factory)(harness.pi);
  const registry = vi.fn(() => [{ provider: 'runtime', id: 'registry-only-model' }]);
  await harness.emit('session_start', { model: { provider: 'runtime', id: 'parent-pi' }, modelRegistry: { getAvailable: registry } });
  try {
    await harness.emit('before_agent_start');
    return { tools: [...harness.tools.values()], workerDescription, registry, env };
  } finally { await harness.emit('session_shutdown'); }
}

function directory(description: string): string | undefined {
  return description.split(' Known models — ')[1];
}

test('Pi agent and worker take one cached snapshot, never the runtime registry', async () => {
  let version = 0;
  const getSnapshot = vi.fn(() => snapshot(++version));
  const { tools, workerDescription, registry, env } = await piSurface({ getSnapshot });
  assert.equal(getSnapshot.mock.calls.length, 1);
  assert.equal(registry.mock.calls.length, 0);
  const agent = tools.find(tool => tool.name === 'agent')!;
  assert.equal(directory(agent.description), directory(workerDescription));
  const json = JSON.stringify(tools);
  for (const model of ['cache-1-only-claude', 'cache/model-1', 'parent-claude']) assert.equal(occurrences(json, model), 1);
  assert.doesNotMatch(json, /registry-only-model|runtime\/parent-pi|known-claude|daemon-model|cache-2/);
  assert.equal(occurrences(json, 'Known models'), 1);
  assert.equal(env.CORTEX_SUBAGENT_CLAUDE_MODELS, catalogEnv.CORTEX_SUBAGENT_CLAUDE_MODELS, 'request env is not mutated');
});

test.each([
  { allowed: 'Agent,Read', mcpAllowlist: ['current_time'], owner: 'agent' },
  { allowed: 'Read', mcpAllowlist: ['worker_spawn'], owner: 'worker_spawn' },
  { allowed: 'Agent,Read', leaf: true, owner: undefined },
])('Pi restricted surface advertises only $owner', async options => {
  const getSnapshot = vi.fn(() => snapshot(1));
  const { tools, registry } = await piSurface({ ...options, getSnapshot });
  assert.equal(getSnapshot.mock.calls.length, 1);
  assert.equal(registry.mock.calls.length, 0);
  assert.equal(occurrences(JSON.stringify(tools), 'Known models'), options.owner ? 1 : 0);
  if (options.owner) assert.match(tools.find(t => t.name === options.owner)!.description, /cache\/model-1/);
});

test.each([undefined, () => ({}), () => { throw new Error('cache unavailable'); }])(
  'standalone/empty/failed snapshot uses shared fallback without inherited catalogs', async getSnapshot => {
    const { tools, workerDescription, registry } = await piSurface({ getSnapshot });
    const agent = tools.find(tool => tool.name === 'agent')!;
    assert.equal(directory(agent.description), directory(workerDescription));
    assert.match(agent.description, /claude-sonnet/);
    assert.match(agent.description, /parent-claude/);
    assert.doesNotMatch(JSON.stringify(tools), /known-claude|daemon-model|registry-only-model|runtime\/parent-pi/);
    assert.equal(registry.mock.calls.length, 0);
  },
);

test('bad roles do not erase the shared model snapshot on an agent-only surface', async () => {
  const failedRoles = vi.spyOn(roles, 'loadRoles').mockImplementation(() => { throw new Error('role read failed'); });
  try {
    const { tools, workerDescription } = await piSurface({ getSnapshot: () => snapshot(1), mcpAllowlist: ['current_time'] });
    const agent = tools.find(tool => tool.name === 'agent')!;
    assert.equal(directory(agent.description), directory(workerDescription));
    assert.match(agent.description, /cache-1-only-claude/);
  } finally { failedRoles.mockRestore(); }
});

test('independent Pi sessions keep their own snapshots', async () => {
  let version = 0;
  const getSnapshot = vi.fn(() => snapshot(++version));
  const first = await piSurface({ getSnapshot });
  const second = await piSurface({ getSnapshot });
  assert.equal(getSnapshot.mock.calls.length, 2);
  assert.match(JSON.stringify(first.tools), /cache-1-only-claude/);
  assert.doesNotMatch(JSON.stringify(first.tools), /cache-2-only-claude/);
  assert.match(JSON.stringify(second.tools), /cache-2-only-claude/);
  assert.doesNotMatch(JSON.stringify(second.tools), /cache-1-only-claude/);
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
