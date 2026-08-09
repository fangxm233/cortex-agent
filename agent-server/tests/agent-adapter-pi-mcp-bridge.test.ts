// input:  PI MCP bridge, privilege env, clients
// output: loading, transport, isolation, and retry tests
// pos:    PI MCP bridge behavior tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildServerStates,
  createMcpTransport,
  createSameOriginFetch,
  installMcpBridge,
  pluginServerStateName,
  pluginToolName,
  PI_PLUGIN_MCP_CONFIG_ENV,
  type McpBridgeDeps,
  type McpClientHandle,
  type McpTransportConstructors,
  type ServerState,
} from '../src/agent-adapter/pi/mcp-bridge.js';
import {
  mapMcpContent,
  shouldLoadFeishu,
  shouldLoadSlack,
  shouldLoadThreadControl,
  shouldLoadWeb,
} from '../src/agent-adapter/pi/mcp-bridge-logic.js';
import { PI_MCP_COMPOSITION_ENV } from '../src/agent-adapter/pi/policy-guard.js';
import type { ExtensionAPI, ToolDefinition } from '../src/agent-adapter/pi/pi-ext-types.js';
import type { McpServerConfig } from '../src/agent-adapter/types.js';

// The CORE_SERVER_PATH / EXT_SERVER_PATH exported from mcp-bridge resolves relative to its own
// location: when loaded via tsx from src/ those siblings don't exist; when running compiled from
// dist/ they do. For the integration tests below we always target the compiled dist/ files so the
// test verifies the deployed (npm install) behavior — `npm run build` must have run first.
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(TESTS_DIR, '../dist');
const EXT_SERVER_PATH = resolve(DIST_DIR, 'domain/mcp/server.js');
const PLUGIN_CONFIG_PATH = '/runtime/pi-plugin-mcp.json';

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

function createPiHarness(options: { registerFailures?: Set<string> } = {}) {
  const handlers = new Map<BridgeEvent, BridgeHandler>();
  const registered: string[] = [];
  const tools = new Map<string, ToolDefinition>();
  const failures = options.registerFailures ?? new Set<string>();
  const pi = {
    on(event: BridgeEvent, handler: BridgeHandler) {
      handlers.set(event, handler);
    },
    registerTool(tool: ToolDefinition) {
      if (failures.delete(tool.name)) throw new Error(`register blocked for ${tool.name}`);
      registered.push(tool.name);
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    registered,
    tools,
    fire: async (event: BridgeEvent) => handlers.get(event)?.({}, {}),
  };
}

function fakeHandle(
  stateName: string,
  options: {
    listTools?: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
    close?: () => Promise<void>;
  } = {},
): McpClientHandle {
  return {
    client: {
      listTools: options.listTools ?? (async () => ({
        tools: [{ name: `${stateName}_tool`, description: stateName, inputSchema: { type: 'object' } }],
      })),
      callTool: async (params) => ({ content: [{ type: 'text', text: String(params.name) }] }),
    } as unknown as McpClientHandle['client'],
    transport: { close: options.close ?? (async () => undefined) },
  };
}

function bridgeDeps(overrides: Partial<McpBridgeDeps>): McpBridgeDeps {
  return {
    env: { CORTEX_THREAD_ID: 'thr_retry' },
    reportFailure: () => undefined,
    loadPluginConfig: () => [],
    spawnClient: async (state) => fakeHandle(state.name),
    ...overrides,
  };
}

function pluginConfig(...servers: McpServerConfig[]): McpServerConfig[] {
  return servers;
}

const BUILTIN_STATES = ['core', 'tasks', 'manager-qa', 'ext'];
const ALPHA_STATE = pluginServerStateName('portable-alpha');
const BETA_STATE = pluginServerStateName('portable-beta');
const ALPHA_TOOL = pluginToolName(ALPHA_STATE, 'search');
const BETA_TOOL = pluginToolName(BETA_STATE, 'search');

type TransportCall = { type: string; value: any };

function directPluginEnv(): NodeJS.ProcessEnv {
  return {
    [PI_MCP_COMPOSITION_ENV]: 'direct',
    [PI_PLUGIN_MCP_CONFIG_ENV]: PLUGIN_CONFIG_PATH,
  };
}

function searchableHandle(state: ServerState): McpClientHandle {
  const toolName = state.config.name === state.name ? `${state.name}_tool` : 'search';
  return fakeHandle(state.name, {
    listTools: async () => ({
      tools: [{ name: toolName, description: state.name, inputSchema: { type: 'object' } }],
    }),
  });
}

function createTransportRecorder(): { calls: TransportCall[]; constructors: McpTransportConstructors } {
  const calls: TransportCall[] = [];
  const transport = { close: async () => undefined } as any;
  const record = (type: string, value: unknown) => {
    calls.push({ type, value });
    return transport;
  };
  return {
    calls,
    constructors: {
      stdio: (server) => record('stdio', server),
      streamableHttp: (url, options) => record('streamable-http', { url: String(url), options }),
      sse: (url, options) => record('sse', { url: String(url), options }),
    },
  };
}

function transportConfigs(): McpServerConfig[] {
  return [
    { name: 'stdio', type: 'stdio', command: '/opt/private-server', args: ['--token', 'secret-arg'], env: { API_KEY: 'secret-env' }, cwd: '/opt/private-cwd' },
    { name: 'http', type: 'streamable-http', url: 'https://private.example.com/mcp', headers: { Authorization: 'Bearer secret-http' } },
    { name: 'sse', type: 'sse', url: 'https://private.example.com/events', headers: { 'X-Secret': 'secret-sse' } },
  ];
}

function assertStdioTransport(call: TransportCall): void {
  assert.equal(call.type, 'stdio');
  assert.deepEqual(call.value.command, '/opt/private-server');
  assert.deepEqual(call.value.args, ['--token', 'secret-arg']);
  assert.equal(call.value.env.API_KEY, 'secret-env');
  assert.equal(call.value.cwd, '/opt/private-cwd');
  assert.equal(call.value.stderr, 'pipe');
}

function assertHttpTransport(call: TransportCall): void {
  assert.equal(call.type, 'streamable-http');
  assert.deepEqual(call.value, {
    url: 'https://private.example.com/mcp',
    options: {
      requestInit: { headers: { Authorization: 'Bearer secret-http' } },
      fetch: call.value.options.fetch,
    },
  });
  assert.equal(typeof call.value.options.fetch, 'function');
}

function assertSseTransport(call: TransportCall): void {
  assert.equal(call.type, 'sse');
  assert.deepEqual(call.value, {
    url: 'https://private.example.com/events',
    options: {
      fetch: call.value.options.fetch,
      eventSourceInit: { fetch: call.value.options.eventSourceInit.fetch },
      requestInit: { headers: { 'X-Secret': 'secret-sse' } },
    },
  });
  assert.equal(typeof call.value.options.fetch, 'function');
  assert.equal(typeof call.value.options.eventSourceInit.fetch, 'function');
}

test('createMcpTransport constructs stdio, StreamableHTTP, and SSE transports with env/cwd/headers intact', () => {
  const { calls, constructors } = createTransportRecorder();
  for (const config of transportConfigs()) createMcpTransport(config, constructors);
  assertStdioTransport(calls[0]);
  assertHttpTransport(calls[1]);
  assertSseTransport(calls[2]);
});

test('createSameOriginFetch gives SDK/client headers precedence over configured headers', async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const previous = global.fetch;
  global.fetch = (async (input, init) => {
    requests.push({ url: String(input), headers: new Headers((init as RequestInit).headers) });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  try {
    const fetchWithHeaders = createSameOriginFetch({ Authorization: 'configured', 'X-Plugin': 'plugin' });
    await fetchWithHeaders('https://private.example.com/mcp', {
      headers: { Authorization: 'sdk', 'X-Client': 'client' },
    } as RequestInit);
  } finally {
    global.fetch = previous;
  }
  assert.equal(requests[0].headers.get('authorization'), 'sdk');
  assert.equal(requests[0].headers.get('x-plugin'), 'plugin');
  assert.equal(requests[0].headers.get('x-client'), 'client');
});

type CapturedRequest = { url: string; method: string; headers: Headers; body: string };

function installRedirectFetch(calls: CapturedRequest[], cancel: () => void): typeof fetch {
  const previous = global.fetch;
  global.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: (init as RequestInit).method ?? 'GET',
      headers: new Headers((init as RequestInit).headers),
      body: String((init as RequestInit).body ?? ''),
    });
    return {
      status: 307,
      headers: new Headers({ location: 'https://evil.example.com/mcp' }),
      body: { cancel: async () => cancel() },
    } as Response;
  }) as typeof fetch;
  return previous;
}

function assertCapturedPost(call: CapturedRequest): void {
  assert.deepEqual(call, {
    url: 'https://private.example.com/mcp',
    method: 'POST',
    headers: call.headers,
    body: 'payload',
  });
  assert.equal(call.headers.get('authorization'), 'sdk');
  assert.equal(call.headers.get('x-plugin'), 'plugin');
  assert.equal(call.headers.get('x-client'), 'client');
}

test('createSameOriginFetch rejects every redirect, cancels the body, and never replays POST bodies or headers', async () => {
  const calls: CapturedRequest[] = [];
  let cancelled = false;
  const previous = installRedirectFetch(calls, () => { cancelled = true; });
  const request = createSameOriginFetch({ Authorization: 'configured', 'X-Plugin': 'plugin' });
  try {
    await assert.rejects(request('https://private.example.com/mcp', {
      method: 'POST',
      headers: { Authorization: 'sdk', 'X-Client': 'client' },
      body: 'payload',
    } as RequestInit), /MCP redirect rejected/);
  } finally {
    global.fetch = previous;
  }
  assert.equal(cancelled, true);
  assert.equal(calls.length, 1);
  assertCapturedPost(calls[0]);
});

test('restricted compositions and subagents suppress plugin config reads before the file is touched', () => {
  let reads = 0;
  const loadPluginConfig = () => {
    reads += 1;
    return pluginConfig({
      name: 'portable-plugin',
      type: 'sse',
      url: 'https://private.example.com/events',
      headers: {},
    });
  };

  assert.deepEqual(buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'none',
    [PI_PLUGIN_MCP_CONFIG_ENV]: PLUGIN_CONFIG_PATH,
  }, { loadPluginConfig }), []);
  assert.deepEqual(buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'benchmark-thread-run',
    [PI_PLUGIN_MCP_CONFIG_ENV]: PLUGIN_CONFIG_PATH,
  }, { loadPluginConfig }).map(state => state.name), ['cortex-benchmark-thread']);
  assert.deepEqual(buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'direct',
    CORTEX_PI_SUBAGENT: '1',
    [PI_PLUGIN_MCP_CONFIG_ENV]: PLUGIN_CONFIG_PATH,
  }, { loadPluginConfig }).map(state => state.name), ['core']);
  assert.equal(reads, 0);
});

test('buildServerStates appends namespaced plugin servers after the built-in direct set', () => {
  const states = buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'direct',
    [PI_PLUGIN_MCP_CONFIG_ENV]: PLUGIN_CONFIG_PATH,
  }, {
    loadPluginConfig: () => pluginConfig(
      { name: 'portable-http', type: 'streamable-http', url: 'https://private.example.com/mcp', headers: {} },
      { name: 'portable-sse', type: 'sse', url: 'https://private.example.com/events', headers: {} },
    ),
  });

  assert.deepEqual(states.map(state => state.name), [
    'core', 'tasks', 'manager-qa', 'ext',
    pluginServerStateName('portable-http'),
    pluginServerStateName('portable-sse'),
  ]);
});

test('plugin server and tool names stay safe for dotted, colon, percent, and long names', () => {
  const state = pluginServerStateName('9.plugin:name%with-extra-characters-and-a-very-long-suffix-that-keeps-going');
  const tool = pluginToolName(state, 'tool:name%with.dots/and-extra-characters');
  assert.match(state, /^[A-Za-z0-9_-]{1,64}$/);
  assert.match(tool, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(state.includes(':'), false);
  assert.equal(tool.includes(':'), false);
  assert.equal(state.includes('%'), false);
  assert.equal(tool.includes('%'), false);
});

test('pluginToolName stays distinct across pair-boundary collisions', () => {
  assert.notEqual(
    pluginToolName('server_a', 'b_c'),
    pluginToolName('server_a_b', 'c'),
  );
});

test('buildServerStates reports and skips duplicate plugin server state names deterministically', () => {
  const issues: string[] = [];
  const states = buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'direct',
    [PI_PLUGIN_MCP_CONFIG_ENV]: PLUGIN_CONFIG_PATH,
  }, {
    loadPluginConfig: () => pluginConfig(
      { name: 'duplicate', type: 'sse', url: 'https://one.example.com/events', headers: {} },
      { name: 'duplicate', type: 'streamable-http', url: 'https://two.example.com/mcp', headers: {} },
    ),
    reportPluginIssue: (issue) => issues.push(issue.message),
  });

  assert.deepEqual(states.map(state => state.name), [
    'core', 'tasks', 'manager-qa', 'ext', pluginServerStateName('duplicate'),
  ]);
  assert.deepEqual(issues, [`Duplicate MCP server state name: ${pluginServerStateName('duplicate')}`]);
});

function duplicateConfigIssueScenario() {
  const harness = createPiHarness();
  const spawned: string[] = [];
  const failures: string[] = [];
  const deps = bridgeDeps({
    env: directPluginEnv(),
    loadPluginConfig: () => ({
      servers: [{ name: 'portable-unique', type: 'sse', url: 'https://unique.example.com/events', headers: {} }],
      issues: [{ path: `${PLUGIN_CONFIG_PATH}#mcpServers[1].name`, message: 'Duplicate PI plugin MCP server name: portable-duplicate' }],
    }),
    reportFailure: (error) => failures.push((error as Error).message),
    spawnClient: async (state) => {
      spawned.push(state.name);
      return searchableHandle(state);
    },
  });
  return { harness, spawned, failures, deps };
}

test('plugin config duplicate-name issues are reported while built-ins and unique plugins still register', async () => {
  const { harness, spawned, failures, deps } = duplicateConfigIssueScenario();
  const uniqueState = pluginServerStateName('portable-unique');
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  assert.deepEqual(spawned, [...BUILTIN_STATES, uniqueState]);
  assert.deepEqual(harness.registered, [
    'core_tool', 'tasks_tool', 'manager-qa_tool', 'ext_tool', pluginToolName(uniqueState, 'search'),
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Duplicate PI plugin MCP server name/);
});

test('plugin config envelope failures are reported while built-ins still register', async () => {
  const harness = createPiHarness();
  const spawned: string[] = [];
  const failures: string[] = [];
  const deps = bridgeDeps({
    env: {
      [PI_MCP_COMPOSITION_ENV]: 'direct',
      [PI_PLUGIN_MCP_CONFIG_ENV]: PLUGIN_CONFIG_PATH,
    },
    loadPluginConfig: () => ({
      servers: [],
      issues: [{ path: PLUGIN_CONFIG_PATH, message: 'plugin config hash mismatch' }],
    }),
    reportFailure: (error) => failures.push((error as Error).message),
    spawnClient: async (state) => {
      spawned.push(state.name);
      return fakeHandle(state.name);
    },
  });

  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');

  assert.deepEqual(spawned, ['core', 'tasks', 'manager-qa', 'ext']);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /hash mismatch/);
});

test('subagent MCP bridge exposes only cortex-core', async () => {
  const harness = createPiHarness();
  const spawned: string[] = [];
  const deps = bridgeDeps({
    env: {
      CORTEX_PI_SUBAGENT: '1',
      CORTEX_THREAD_ID: 'thr_parent',
      SLACK_CHANNEL: 'slack:C0123',
      [PI_PLUGIN_MCP_CONFIG_ENV]: PLUGIN_CONFIG_PATH,
    },
    loadPluginConfig: () => {
      throw new Error('plugin config must not be read for subagents');
    },
    spawnClient: async (state) => {
      spawned.push(state.name);
      return fakeHandle(state.name);
    },
  });

  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');

  assert.deepEqual(spawned, ['core']);
  assert.deepEqual(harness.registered, ['core_tool']);
});

test('top-level direct MCP bridge loads manager answers without thread control', async () => {
  const harness = createPiHarness();
  const spawned: string[] = [];
  const deps = bridgeDeps({
    env: {},
    spawnClient: async (state) => {
      spawned.push(state.name);
      return fakeHandle(state.name);
    },
  });

  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');

  assert.deepEqual(spawned, ['core', 'tasks', 'manager-qa', 'ext']);
  assert.deepEqual(harness.registered, [
    'core_tool', 'tasks_tool', 'manager-qa_tool', 'ext_tool',
  ]);
});

function alphaPluginConfig(): McpServerConfig[] {
  return pluginConfig({
    name: 'portable-alpha', type: 'sse', url: 'https://alpha.example.com/events', headers: {},
  });
}

function alphaBetaPluginConfig(): McpServerConfig[] {
  return pluginConfig(
    { name: 'portable-alpha', type: 'sse', url: 'https://alpha.example.com/events', headers: {} },
    { name: 'portable-beta', type: 'sse', url: 'https://beta.example.com/events', headers: {} },
  );
}

function connectFailureScenario() {
  const harness = createPiHarness();
  const attempts = new Map<string, number>();
  const failures: string[] = [];
  const deps = bridgeDeps({
    env: directPluginEnv(),
    loadPluginConfig: alphaBetaPluginConfig,
    reportFailure: (error) => failures.push((error as Error).message),
    spawnClient: async (state) => {
      const attempt = (attempts.get(state.name) ?? 0) + 1;
      attempts.set(state.name, attempt);
      if (state.name === ALPHA_STATE && attempt === 1) throw new Error('alpha unavailable');
      return searchableHandle(state);
    },
  });
  return { harness, attempts, failures, deps };
}

function assertConnectAttempts(attempts: Map<string, number>): void {
  assert.deepEqual(Object.fromEntries(attempts), {
    core: 1,
    tasks: 1,
    'manager-qa': 1,
    ext: 1,
    [ALPHA_STATE]: 2,
    [BETA_STATE]: 1,
  });
}

test('plugin connect failure isolates the server and retries later without dropping built-ins or healthy plugins', async () => {
  const { harness, attempts, failures, deps } = connectFailureScenario();
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  assert.deepEqual(harness.registered, [
    'core_tool', 'tasks_tool', 'manager-qa_tool', 'ext_tool', BETA_TOOL,
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /portable-alpha.*connect/);
  await harness.fire('before_agent_start');
  assert.deepEqual(harness.registered, [
    'core_tool', 'tasks_tool', 'manager-qa_tool', 'ext_tool', BETA_TOOL, ALPHA_TOOL,
  ]);
  assertConnectAttempts(attempts);
});

function listFailureScenario() {
  const harness = createPiHarness();
  const attempts = new Map<string, number>();
  const failures: string[] = [];
  const deps = bridgeDeps({
    env: directPluginEnv(),
    loadPluginConfig: alphaPluginConfig,
    reportFailure: (error) => failures.push((error as Error).message),
    spawnClient: async (state) => fakeHandle(state.name, {
      listTools: async () => {
        const attempt = (attempts.get(state.name) ?? 0) + 1;
        attempts.set(state.name, attempt);
        if (state.name === ALPHA_STATE && attempt === 1) throw new Error('alpha list unavailable');
        const toolName = state.config.name === state.name ? `${state.name}_tool` : 'search';
        return { tools: [{ name: toolName, description: state.name, inputSchema: { type: 'object' } }] };
      },
    }),
  });
  return { harness, attempts, failures, deps };
}

test('plugin list failure isolates the server and retries later without duplicate registrations', async () => {
  const { harness, attempts, failures, deps } = listFailureScenario();
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  assert.equal(harness.registered.includes(ALPHA_TOOL), false);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /portable-alpha.*list tools/);
  await harness.fire('before_agent_start');
  assert.equal(harness.registered.includes(ALPHA_TOOL), true);
  assert.equal(harness.registered.filter(name => name === 'core_tool').length, 1);
  assert.equal(attempts.get(ALPHA_STATE), 2);
});

function registerFailureScenario() {
  const harness = createPiHarness({ registerFailures: new Set([ALPHA_TOOL]) });
  const failures: string[] = [];
  const deps = bridgeDeps({
    env: directPluginEnv(),
    loadPluginConfig: alphaBetaPluginConfig,
    reportFailure: (error) => failures.push((error as Error).message),
    spawnClient: async (state) => searchableHandle(state),
  });
  return { harness, failures, deps };
}

test('plugin register failure retries later without removing already registered built-in or other plugin tools', async () => {
  const { harness, failures, deps } = registerFailureScenario();
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  assert.equal(harness.registered.includes(ALPHA_TOOL), false);
  assert.equal(harness.registered.includes(BETA_TOOL), true);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /portable-alpha.*register/);
  await harness.fire('before_agent_start');
  assert.equal(harness.registered.includes(ALPHA_TOOL), true);
  assert.equal(harness.registered.filter(name => name === 'core_tool').length, 1);
});

function duplicateToolScenario() {
  const harness = createPiHarness();
  const failures: string[] = [];
  const deps = bridgeDeps({
    env: directPluginEnv(),
    loadPluginConfig: alphaPluginConfig,
    reportFailure: (error) => failures.push((error as Error).message),
    spawnClient: async (state) => {
      if (state.name !== ALPHA_STATE) return fakeHandle(state.name);
      return fakeHandle(state.name, {
        listTools: async () => ({
          tools: [
            { name: 'search', description: 'one', inputSchema: { type: 'object' } },
            { name: 'search', description: 'two', inputSchema: { type: 'object' } },
          ],
        }),
      });
    },
  });
  return { harness, failures, deps };
}

test('duplicate plugin exposed tool names fail deterministically before registering that server', async () => {
  const { harness, failures, deps } = duplicateToolScenario();
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  assert.deepEqual(harness.registered, ['core_tool', 'tasks_tool', 'manager-qa_tool', 'ext_tool']);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Duplicate MCP tool name:/);
});

function shutdownScenario() {
  const harness = createPiHarness();
  const closed: string[] = [];
  const spawned: string[] = [];
  const deps = bridgeDeps({
    env: directPluginEnv(),
    loadPluginConfig: alphaPluginConfig,
    spawnClient: async (state) => {
      spawned.push(state.name);
      return fakeHandle(state.name, { close: async () => { closed.push(state.name); } });
    },
  });
  return { harness, closed, spawned, deps };
}

test('shutdown closes every handle and a later turn can reconnect', async () => {
  const { harness, closed, spawned, deps } = shutdownScenario();
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  await harness.fire('session_shutdown');
  assert.deepEqual(closed, [...BUILTIN_STATES, ALPHA_STATE]);
  await harness.fire('before_agent_start');
  assert.deepEqual(spawned, [
    ...BUILTIN_STATES, ALPHA_STATE, ...BUILTIN_STATES, ALPHA_STATE,
  ]);
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
