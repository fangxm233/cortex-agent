// input:  PI MCP bridge, session env, plugin server configs, tool gates, fake clients
// output: Bundle selection, in-process core server, plugin isolation and retry tests
// pos:    Tests PI MCP bridge behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  buildServerStates,
  createMcpBridgeDeps,
  createMcpTransport,
  createSameOriginFetch,
  installMcpBridge,
  pluginServerStateName,
  pluginToolName,
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
import {
  PI_INTERACTION_BRIDGE_ENV,
  PI_MCP_COMPOSITION_ENV,
} from '../src/agent-adapter/pi/spawn-args.js';
import type { McpServerConfig } from '../src/agent-adapter/types.js';
import { MCP_TOOL_ALLOWLIST_ENV, MCP_TOOLS_BY_SERVER } from '../src/core/mcp-tool-gate.js';

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

// The bridge only touches `on` and `registerTool` of the PI SDK's ExtensionAPI; the rest is unused.
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
    callTool?: (
      params: { name: string; arguments?: Record<string, unknown> },
      resultSchema?: unknown,
      requestOptions?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
    ) => Promise<any>;
    close?: () => Promise<void>;
  } = {},
): McpClientHandle {
  return {
    client: {
      listTools: options.listTools ?? (async () => ({
        tools: [{ name: `${stateName}_tool`, description: stateName, inputSchema: { type: 'object' } }],
      })),
      callTool: options.callTool
        ?? (async (params) => ({ content: [{ type: 'text', text: String(params.name) }] })),
    } as unknown as McpClientHandle['client'],
    transport: { close: options.close ?? (async () => undefined) },
  };
}

function bridgeDeps(overrides: Partial<McpBridgeDeps>): McpBridgeDeps {
  return {
    env: { CORTEX_THREAD_ID: 'thr_retry' },
    reportFailure: () => undefined,
    spawnClient: async (state) => fakeHandle(state.name),
    ...overrides,
  };
}

const BUILTIN_STATES = ['core'];

function selectedBundles(states: ServerState[]): string[] {
  const core = states.find(state => state.name === 'core');
  assert.ok(core?.source.kind === 'bundled');
  return core.source.bundles;
}

function coreEnv(states: ServerState[]): Record<string, string> {
  const core = states.find(state => state.name === 'core');
  assert.ok(core?.source.kind === 'bundled');
  return core.source.env;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('server discovery runs concurrently and registration preserves state order', async () => {
  const harness = createPiHarness();
  const release = deferred();
  const started: string[] = [];
  const deps = bridgeDeps({
    env: {},
    spawnClient: async (state) => fakeHandle(state.name, {
      listTools: async () => {
        started.push(state.name);
        await release.promise;
        return {
          tools: [{ name: `${state.name}_tool`, inputSchema: { type: 'object' } }],
        };
      },
    }),
  });
  await installMcpBridge(harness.pi, deps);
  const preflight = harness.fire('before_agent_start');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const startedBeforeRelease = [...started];
  release.resolve();
  await preflight;
  assert.deepEqual(startedBeforeRelease, BUILTIN_STATES);
  assert.deepEqual(harness.registered, BUILTIN_STATES.map((name) => `${name}_tool`));
});

const ALPHA_STATE = pluginServerStateName('portable-alpha');
const BETA_STATE = pluginServerStateName('portable-beta');
const ALPHA_TOOL = pluginToolName(ALPHA_STATE, 'search');
const BETA_TOOL = pluginToolName(BETA_STATE, 'search');

type TransportCall = { type: string; value: any };

function directEnv(): NodeJS.ProcessEnv {
  return { [PI_MCP_COMPOSITION_ENV]: 'direct' };
}

function searchableHandle(state: ServerState): McpClientHandle {
  const toolName = state.source.kind === 'bundled' ? `${state.name}_tool` : 'search';
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

test('createMcpTransport layers a stdio server\'s declared env over the session env, not the daemon\'s', () => {
  const { calls, constructors } = createTransportRecorder();
  const [stdio] = transportConfigs();
  createMcpTransport(stdio, constructors, { SESSION_ONLY: 'yes', API_KEY: 'session-value' });
  assertStdioTransport(calls[0]);
  assert.equal(calls[0].value.env.SESSION_ONLY, 'yes');
  assert.equal(calls[0].value.env.API_KEY, 'secret-env');
  assert.equal('PATH' in calls[0].value.env, false);
});

test('createSameOriginFetch gives SDK/client headers precedence over configured headers', async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const previous = global.fetch;
  global.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
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
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
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

test('empty compositions and subagents ignore the plugin server set', () => {
  const issues: string[] = [];
  const plugins: McpServerConfig[] = [
    { name: 'portable-plugin', type: 'sse', url: 'https://private.example.com/events', headers: {} },
  ];

  assert.deepEqual(buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'none',
  }, plugins, (message) => issues.push(message)), []);
  assert.deepEqual(buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'direct',
    CORTEX_PI_SUBAGENT: '1',
    [PI_INTERACTION_BRIDGE_ENV]: '1',
  }, plugins, (message) => issues.push(message)).map(state => state.name), ['core']);
  assert.deepEqual(issues, []);
});

test('buildServerStates loads the shared interaction bridge only for eligible direct PI sessions', () => {
  const cases: Array<{ env: NodeJS.ProcessEnv; hasInteraction: boolean }> = [
    { env: { [PI_MCP_COMPOSITION_ENV]: 'direct', [PI_INTERACTION_BRIDGE_ENV]: '1' }, hasInteraction: true },
    { env: { [PI_MCP_COMPOSITION_ENV]: 'direct' }, hasInteraction: false },
    { env: { [PI_MCP_COMPOSITION_ENV]: 'thread-control', [PI_INTERACTION_BRIDGE_ENV]: '1' }, hasInteraction: false },
    { env: { [PI_MCP_COMPOSITION_ENV]: 'none', [PI_INTERACTION_BRIDGE_ENV]: '1' }, hasInteraction: false },
  ];
  for (const { env, hasInteraction } of cases) {
    const states = buildServerStates(env);
    const selected = states.length > 0 && selectedBundles(states).includes('cortex-interaction-bridge');
    assert.equal(selected, hasInteraction);
  }
});

test('buildServerStates validates interaction tools only when the shared bridge is eligible', () => {
  const allowed = JSON.stringify(['cortex_ask_user']);
  const states = buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'direct',
    [PI_INTERACTION_BRIDGE_ENV]: '1',
    [MCP_TOOL_ALLOWLIST_ENV]: allowed,
  });
  assert.ok(selectedBundles(states).includes('cortex-interaction-bridge'));
  assert.throws(() => buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'direct',
    [MCP_TOOL_ALLOWLIST_ENV]: allowed,
  }), /Unknown MCP tool.*cortex_ask_user/);
});

test('the bundled core env carries the session env plus a commission-free gate for the bridge', () => {
  const env = coreEnv(buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'direct',
    [PI_INTERACTION_BRIDGE_ENV]: '1',
    CORTEX_SESSION_ID: 'sess-core',
    SLACK_CHANNEL: 'slack:C0123',
  }));
  assert.equal(env.CORTEX_SESSION_ID, 'sess-core');
  assert.equal(env.SLACK_CHANNEL, 'slack:C0123');
  assert.equal(env.SLACK_BOT_TOKEN, '');
  assert.equal(env.FEISHU_CHANNEL, '');
  const allowed = JSON.parse(env[MCP_TOOL_ALLOWLIST_ENV]) as string[];
  assert.ok(allowed.includes('cortex_plan_exit'));
  assert.equal(allowed.includes('cortex_commission_start'), false);
  assert.equal(coreEnv(buildServerStates({ [PI_MCP_COMPOSITION_ENV]: 'direct' }))[MCP_TOOL_ALLOWLIST_ENV], undefined);
});

test('eligible PI sessions register the three shared interaction tool names', async () => {
  const harness = createPiHarness();
  const interactionTools = ['cortex_ask_user', 'cortex_plan_enter', 'cortex_plan_exit'];
  const deps = bridgeDeps({
    env: { [PI_MCP_COMPOSITION_ENV]: 'direct', [PI_INTERACTION_BRIDGE_ENV]: '1' },
    spawnClient: async (state) => fakeHandle(state.name, {
      listTools: async () => ({
        tools: interactionTools.map(name => ({ name, inputSchema: { type: 'object' } })),
      }),
    }),
  });
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  for (const name of interactionTools) assert.ok(harness.registered.includes(name));
  for (const name of ['ask_user_question', 'enter_plan_mode', 'exit_plan_mode']) {
    assert.equal(harness.registered.includes(name), false);
  }
});

test('buildServerStates validates a tool gate against the composed built-in union', () => {
  assert.throws(() => buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'direct',
    [MCP_TOOL_ALLOWLIST_ENV]: JSON.stringify(['thread_wait']),
  }), /Unknown MCP tool.*thread_wait/);

  const states = buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'thread-control',
    CORTEX_THREAD_ID: 'thr_fixture',
    [MCP_TOOL_ALLOWLIST_ENV]: JSON.stringify(['thread_wait', 'task_status']),
  });
  assert.ok(selectedBundles(states).includes('cortex-thread'));
});

test('buildServerStates appends namespaced plugin servers after the built-in direct set', () => {
  const states = buildServerStates(directEnv(), [
    { name: 'portable-sse', type: 'sse', url: 'https://private.example.com/events', headers: {} },
    { name: 'portable-http', type: 'streamable-http', url: 'https://private.example.com/mcp', headers: {} },
  ]);

  assert.deepEqual(states.map(state => state.name), [
    'core', pluginServerStateName('portable-http'), pluginServerStateName('portable-sse'),
  ]);
  assert.deepEqual(selectedBundles(states), [
    'cortex-core', 'cortex-tasks', 'cortex-manager-qa', 'cortex-ext',
  ]);
  const http = states[1];
  assert.ok(http.source.kind === 'plugin');
  assert.equal(http.source.config.name, 'portable-http');
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
  const states = buildServerStates(directEnv(), [
    { name: 'duplicate', type: 'sse', url: 'https://one.example.com/events', headers: {} },
    { name: 'duplicate', type: 'streamable-http', url: 'https://two.example.com/mcp', headers: {} },
  ], (message) => issues.push(message));

  assert.deepEqual(states.map(state => state.name), [
    'core', pluginServerStateName('duplicate'),
  ]);
  assert.deepEqual(issues, [`Duplicate MCP server state name: ${pluginServerStateName('duplicate')}`]);
});

function duplicatePluginNameScenario() {
  const harness = createPiHarness();
  const spawned: string[] = [];
  const failures: string[] = [];
  const deps = bridgeDeps({
    env: directEnv(),
    pluginServers: [
      { name: 'portable-unique', type: 'sse', url: 'https://unique.example.com/events', headers: {} },
      { name: 'portable-duplicate', type: 'sse', url: 'https://one.example.com/events', headers: {} },
      { name: 'portable-duplicate', type: 'streamable-http', url: 'https://two.example.com/mcp', headers: {} },
    ],
    reportFailure: (error) => failures.push((error as Error).message),
    spawnClient: async (state) => {
      spawned.push(state.name);
      return searchableHandle(state);
    },
  });
  return { harness, spawned, failures, deps };
}

test('duplicate plugin names reach reportFailure while built-ins and the remaining plugins still register', async () => {
  const { harness, spawned, failures, deps } = duplicatePluginNameScenario();
  const duplicateState = pluginServerStateName('portable-duplicate');
  const uniqueState = pluginServerStateName('portable-unique');
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  assert.deepEqual(spawned, [...BUILTIN_STATES, duplicateState, uniqueState]);
  assert.deepEqual(harness.registered, [
    'core_tool', pluginToolName(duplicateState, 'search'), pluginToolName(uniqueState, 'search'),
  ]);
  assert.deepEqual(failures, [`Duplicate MCP server state name: ${duplicateState}`]);
});

test('bridged MCP calls use the shared 30m30s infrastructure deadline', async () => {
  const harness = createPiHarness();
  const calls: any[][] = [];
  const deps = bridgeDeps({
    env: { CORTEX_PI_SUBAGENT: '1' },
    spawnClient: async (state) => fakeHandle(state.name, {
      callTool: async (...args) => {
        calls.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }),
  });
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  const controller = new AbortController();
  await harness.tools.get('core_tool')!.execute('call-1', {}, controller.signal, undefined, {} as any);

  assert.equal(calls[0][2].signal, controller.signal);
  assert.equal(calls[0][2].timeout, 1_830_000);
  assert.equal(calls[0][2].maxTotalTimeout, 1_830_000);
});

test('bridged MCP errors reject the PI tool call with the server message', async () => {
  const harness = createPiHarness();
  const deps = bridgeDeps({
    env: { CORTEX_PI_SUBAGENT: '1' },
    spawnClient: async (state) => fakeHandle(state.name, {
      callTool: async () => ({
        content: [{ type: 'text', text: 'interaction failed' }],
        isError: true,
      }),
    }),
  });
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  const tool = harness.tools.get('core_tool');
  assert.ok(tool);
  await assert.rejects(
    tool.execute('call-1', {}, undefined, undefined, {} as any),
    /interaction failed/,
  );
});

test('subagent MCP bridge exposes only cortex-core', async () => {
  const harness = createPiHarness();
  const spawned: string[] = [];
  const deps = bridgeDeps({
    env: {
      CORTEX_PI_SUBAGENT: '1',
      CORTEX_THREAD_ID: 'thr_parent',
      SLACK_CHANNEL: 'slack:C0123',
    },
    pluginServers: [
      { name: 'portable-alpha', type: 'sse', url: 'https://alpha.example.com/events', headers: {} },
    ],
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

  assert.deepEqual(spawned, ['core']);
  assert.deepEqual(harness.registered, ['core_tool']);
});

function alphaPluginServers(): McpServerConfig[] {
  return [
    { name: 'portable-alpha', type: 'sse', url: 'https://alpha.example.com/events', headers: {} },
  ];
}

function alphaBetaPluginServers(): McpServerConfig[] {
  return [
    { name: 'portable-alpha', type: 'sse', url: 'https://alpha.example.com/events', headers: {} },
    { name: 'portable-beta', type: 'sse', url: 'https://beta.example.com/events', headers: {} },
  ];
}

function connectFailureScenario() {
  const harness = createPiHarness();
  const attempts = new Map<string, number>();
  const failures: string[] = [];
  const deps = bridgeDeps({
    env: directEnv(),
    pluginServers: alphaBetaPluginServers(),
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
    [ALPHA_STATE]: 2,
    [BETA_STATE]: 1,
  });
}

test('plugin connect failure isolates the server and retries later without dropping built-ins or healthy plugins', async () => {
  const { harness, attempts, failures, deps } = connectFailureScenario();
  await installMcpBridge(harness.pi, deps);
  await harness.fire('before_agent_start');
  assert.deepEqual(harness.registered, ['core_tool', BETA_TOOL]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /portable-alpha.*connect/);
  await harness.fire('before_agent_start');
  assert.deepEqual(harness.registered, ['core_tool', BETA_TOOL, ALPHA_TOOL]);
  assertConnectAttempts(attempts);
});

function listFailureScenario() {
  const harness = createPiHarness();
  const attempts = new Map<string, number>();
  const failures: string[] = [];
  const deps = bridgeDeps({
    env: directEnv(),
    pluginServers: alphaPluginServers(),
    reportFailure: (error) => failures.push((error as Error).message),
    spawnClient: async (state) => fakeHandle(state.name, {
      listTools: async () => {
        const attempt = (attempts.get(state.name) ?? 0) + 1;
        attempts.set(state.name, attempt);
        if (state.name === ALPHA_STATE && attempt === 1) throw new Error('alpha list unavailable');
        const toolName = state.source.kind === 'bundled' ? `${state.name}_tool` : 'search';
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
    env: directEnv(),
    pluginServers: alphaBetaPluginServers(),
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
    env: directEnv(),
    pluginServers: alphaPluginServers(),
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
  assert.deepEqual(harness.registered, ['core_tool']);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Duplicate MCP tool name:/);
});

function shutdownScenario() {
  const harness = createPiHarness();
  const closed: string[] = [];
  const spawned: string[] = [];
  const deps = bridgeDeps({
    env: directEnv(),
    pluginServers: alphaPluginServers(),
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

// Real in-process integration: the production deps serve the bundled core server over an in-memory
// transport pair (no child process); listing and invoking one tool exercises bundle loading, the
// tool gate, the MCP round trip, and content mapping.

test('createMcpBridgeDeps serves the bundled core server in-process and cost_query returns text', { timeout: 15000 }, async () => {
  const env: NodeJS.ProcessEnv = directEnv();
  const deps = createMcpBridgeDeps(env, []);
  const states = buildServerStates(env);
  const core = states.find(state => state.name === 'core');
  assert.ok(core?.source.kind === 'bundled');
  const handle = await deps.spawnClient(core);
  try {
    const { tools } = await handle.client.listTools();
    const expected = core.source.bundles.flatMap(bundle => MCP_TOOLS_BY_SERVER[bundle] ?? []).sort();
    assert.deepEqual(tools.map(tool => tool.name).sort(), expected);
    const result = await handle.client.callTool({ name: 'cost_query', arguments: {} });
    const mapped = (result.content as any[]).map(mapMcpContent);
    assert.ok(mapped.length > 0, 'cost_query should return at least one content item');
    assert.ok(mapped.every((c: any) => c.type === 'text'), 'all mapped content items should be text');
  } finally {
    await handle.transport.close();
  }
});
