// input:  spawn facade, context, tool gates, adapters, goldens
// output: cwd, accounting, gating, composition, route, pool tests
// pos:    Verifies the backend process spawn contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  resolveMcpComposition,
  type AgentSpawnConfig,
  type McpComposition,
} from '../src/agent-adapter/types.js';
import { ClaudeAdapter, _test as claudeTest } from '../src/agent-adapter/claude/adapter.js';
import {
  buildClaudeEnv,
  buildSpawnArgs,
  claudeRouteIdentity,
} from '../src/agent-adapter/claude/spawn-args.js';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import {
  buildServerStates,
  pluginServerStateName,
} from '../src/agent-adapter/pi/mcp-bridge.js';
import { safeNativeComposite } from '../src/domain/plugins/native-name.js';
import { PI_PLUGIN_MCP_CONFIG_ENV } from '../src/agent-adapter/pi/mcp-config.js';
import { buildPiEnv, PI_MCP_COMPOSITION_ENV } from '../src/agent-adapter/pi/spawn-args.js';
import { generateMcpConfig } from '../src/core/config-generator.js';
import { CONFIG_DIR, DATA_DIR } from '../src/core/paths.js';
import { resetSettingsForTests } from '../src/core/settings.js';
import { getSavedApiEnv, type ModeEnv } from '../src/domain/agents/config.js';
import { _test as facadeTest } from '../src/domain/agents/facade.js';
import type { AgentConfig } from '../src/domain/agents/spawn-config.js';
import { GATEWAY_URL, _testSetHealthy } from '../src/domain/costs/gateway-manager.js';
import { generateConfigs, getResolvedPaths, type InitAnswers } from '../src/entry/init.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
// GOLDEN PROVENANCE: captured from base 63fe0dad's production spawn path. That path mapped the
// legacy thread boolean to the thread MCP configs; its old _test.computeSpawnArgs hook did not.
// The current seam and production path agree, so re-deriving via the old hook gives a false mismatch.
const DIRECT_GOLDEN = path.join(TEST_DIR, 'spawn-seam-direct.golden.json');
const THREAD_GOLDEN = path.join(TEST_DIR, 'spawn-seam-thread.golden.json');
const FIXTURE_CONFIG = { model: 'claude-fixture', backend: 'claude' as const, mode: null };
const originalEnv = { ...process.env };

beforeAll(() => {
  rmSync(path.join(DATA_DIR, 'rules'), { recursive: true, force: true });
  rmSync(path.join(CONFIG_DIR, 'hooks'), { recursive: true, force: true });
  rmSync(path.join(CONFIG_DIR, 'settings.json'), { force: true });
  mkdirSync(path.join(CONFIG_DIR, 'hooks'), { recursive: true });
  resetSettingsForTests();
});

afterAll(() => {
  replaceEnvironment(originalEnv);
  resetSettingsForTests();
});

function replaceEnvironment(values: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, values);
}

function deterministicEnvironment(): void {
  replaceEnvironment({
    PATH: '/usr/bin:/bin',
    HOME: '/fixture/home',
    LANG: 'C',
    CORTEX_HOME: '/fixture/cortex-home',
  });
  resetSettingsForTests();
}

function sortedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(DATA_DIR, '<CORTEX_HOME>');
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, canonicalize(item)]),
  );
}

function childEnvironment(config: AgentSpawnConfig): NodeJS.ProcessEnv {
  return buildClaudeEnv(
    config.channel ?? config.sessionKey,
    config.sessionId!,
    config.callbackSource,
    config.scheduleTaskId,
    config.anthropicBaseUrl,
    config.env,
    config.cortexContext,
    config.pinnedEnv,
    config.unsetEnv,
  );
}

function resolvedGolden(config: AgentSpawnConfig): string {
  const output = canonicalize({
    argv: claudeTest.computeSpawnArgs(config),
    environment: sortedEnvironment(childEnvironment(config)),
  });
  return `${JSON.stringify(output, null, 2)}\n`;
}

function directSpawnConfig(): AgentSpawnConfig {
  const config = facadeTest.buildSpawnConfig({
    channel: 'general',
    sessionId: '11111111-1111-4111-8111-111111111111',
    sessionKey: 'direct-fixture',
    profileName: 'fixture-profile',
    trackSessionId: 'tracked-direct',
    executionId: 'exec-direct',
  }, FIXTURE_CONFIG, undefined);
  config.resume = false;
  return config;
}

function threadSpawnConfig(): AgentSpawnConfig {
  const config = facadeTest.buildSpawnConfig({
    channel: 'thread-fixture',
    sessionId: '22222222-2222-4222-8222-222222222222',
    sessionKey: 'thread-fixture:1',
    profileName: 'fixture-profile',
    trackSessionId: 'tracked-thread',
    executionId: 'exec-thread',
    threadId: 'thr_fixture',
    sessionName: 'cortex-fixture',
    useCoreMcp: true,
    threadDepth: 1,
    taskId: 'abcd',
    taskProject: 'atlas',
  }, FIXTURE_CONFIG, undefined);
  config.resume = false;
  return config;
}

function mcpConfigPaths(argv: string[]): string[] {
  const start = argv.indexOf('--mcp-config');
  assert.ok(start >= 0, '--mcp-config must be present');
  const paths: string[] = [];
  for (let index = start + 1; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) break;
    paths.push(argv[index]);
  }
  return paths;
}

function declaredServers(composition: McpComposition): string[] {
  const argv = buildSpawnArgs({
    tools: null,
    needsResume: false,
    sessionId: `fixture-${composition}`,
    mcpComposition: composition,
  });
  assert.ok(argv.includes('--strict-mcp-config'));
  const names = mcpConfigPaths(argv).flatMap((configPath) => {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return Object.keys(parsed.mcpServers);
  });
  return [...new Set(names)].sort();
}

test('resolveMcpComposition gives explicit values precedence over the legacy boolean', () => {
  const explicit: McpComposition[] = [
    'direct',
    'thread-control',
    'none',
  ];
  for (const composition of explicit) {
    assert.equal(resolveMcpComposition(composition, false), composition);
    assert.equal(resolveMcpComposition(composition, true), composition);
  }
  assert.equal(resolveMcpComposition(undefined, true), 'thread-control');
  assert.equal(resolveMcpComposition(undefined, false), 'direct');
  assert.equal(resolveMcpComposition(undefined, undefined), 'direct');
});

test('buildSpawnConfig carries isolated one-shot values and resolves legacy composition', () => {
  const explicit = facadeTest.buildSpawnConfig({
    cwd: '/fixture/task',
    mcpComposition: 'none',
    useCoreMcp: true,
    mcpConfigPaths: ['/fixture/mcp-empty.json'],
    disableHooks: true,
    streamDeltas: false,
    captureTranscriptLogs: false,
    loadCortexRules: false,
    recordCost: false,
  }, FIXTURE_CONFIG, undefined);
  const legacy = facadeTest.buildSpawnConfig({ useCoreMcp: true }, FIXTURE_CONFIG, undefined);

  assert.equal(explicit.cwd, '/fixture/task');
  assert.equal(explicit.mcpComposition, 'none');
  assert.deepEqual(explicit.mcpConfigPaths, ['/fixture/mcp-empty.json']);
  assert.equal(explicit.disableHooks, true);
  assert.equal(explicit.streamDeltas, false);
  assert.equal(explicit.captureTranscriptLogs, false);
  assert.equal(explicit.appendSystemPrompt, undefined);
  assert.equal(explicit.cortexContext?.useCoreMcp, true);
  assert.equal(legacy.mcpComposition, 'thread-control');
});

test('buildSpawnConfig canonicalizes a declared MCP tool allowlist', () => {
  const config = facadeTest.buildSpawnConfig({
    mcpToolAllowlist: ['thread_wait', 'ask_manager', 'thread_wait'],
  }, FIXTURE_CONFIG, undefined);
  assert.deepEqual(config.mcpToolAllowlist, ['ask_manager', 'thread_wait']);
});

test('task dispatch generation reaches both backend environments without inheriting stale state', () => {
  const config = facadeTest.buildSpawnConfig({
    channel: 'thread-fixture',
    sessionId: '33333333-3333-4333-8333-333333333333',
    sessionKey: 'thread-fixture:2',
    threadId: 'thr_generation',
    taskId: 'abcd',
    taskProject: 'atlas',
    taskGeneration: 'generation-b',
  }, FIXTURE_CONFIG, undefined);
  assert.equal(config.cortexContext?.taskGeneration, 'generation-b');

  const claudeEnv = buildClaudeEnv(
    'thread-fixture', config.sessionId!, null, null, undefined,
    { CORTEX_TASK_GENERATION: 'forged-generation' }, config.cortexContext,
  );
  assert.equal(claudeEnv.CORTEX_TASK_GENERATION, 'generation-b');

  const piEnv = buildPiEnv({
    sessionId: config.sessionId,
    channel: 'thread-fixture',
    context: config.cortexContext,
    piAgentDir: '/fixture/pi-agent',
  }, { CORTEX_TASK_GENERATION: 'stale-generation' });
  assert.equal(piEnv.CORTEX_TASK_GENERATION, 'generation-b');

  const cleanPiEnv = buildPiEnv({ piAgentDir: '/fixture/pi-agent' }, {
    CORTEX_TASK_GENERATION: 'stale-generation',
  });
  assert.equal(cleanPiEnv.CORTEX_TASK_GENERATION, undefined);
});

test('restricted one-shot options override MCP paths and disable hooks', () => {
  const argv = buildSpawnArgs({
    tools: 'Bash,Read', needsResume: false, sessionId: 'one-shot',
    mcpComposition: 'none', mcpConfigPaths: ['/fixture/mcp-empty.json'],
    disableHooks: true, streamDeltas: false,
  });
  assert.deepEqual(mcpConfigPaths(argv), ['/fixture/mcp-empty.json']);
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings') + 1]), { hooks: {} });
});

const PORTABLE_ROOT = path.join(DATA_DIR, 'plugins', 'portable-spawn-fixture');
const LEGACY_ROOT = path.join(DATA_DIR, 'plugins', 'legacy-spawn-fixture');
const UNMANAGED_ROOT = path.join(DATA_DIR, 'unmanaged-spawn-fixture');
const RUNTIME_MCP_PATHS = ['/fixture/mcp exact-a.json', '/fixture/mcp exact-b.json'];
const PORTABLE_SERVER_NAME = safeNativeComposite(
  ['portable-spawn-fixture', 'spawn'],
  'plugin',
);

function writeJsonFixture(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function writePortableSkillPlugin(
  root: string,
  name: string,
  skill: string,
  description: string,
): void {
  mkdirSync(path.join(root, 'skills', skill), { recursive: true });
  writeJsonFixture(path.join(root, 'plugin.json'), {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name,
  });
  writeFileSync(path.join(root, 'skills', skill, 'SKILL.md'), [
    '---',
    `name: ${skill}`,
    `description: ${description}`,
    '---',
    `# ${skill}`,
    '',
  ].join('\n'));
}

function removePluginRuntimeFixture(): void {
  rmSync(PORTABLE_ROOT, { recursive: true, force: true });
  rmSync(LEGACY_ROOT, { recursive: true, force: true });
  rmSync(UNMANAGED_ROOT, { recursive: true, force: true });
}

function installPluginRuntimeFixture(): void {
  writePortableSkillPlugin(
    PORTABLE_ROOT,
    'portable-spawn-fixture',
    'portable-skill',
    'portable spawn fixture skill.',
  );
  writeJsonFixture(path.join(PORTABLE_ROOT, 'mcp.json'), {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { spawn: { type: 'sse', url: 'https://spawn.example.com/sse' } },
  });
  mkdirSync(path.join(LEGACY_ROOT, '.claude-plugin'), { recursive: true });
  writeJsonFixture(
    path.join(LEGACY_ROOT, '.claude-plugin', 'plugin.json'),
    { name: 'legacy-spawn-fixture' },
  );
  mkdirSync(UNMANAGED_ROOT, { recursive: true });
}

function pluginRuntimeSpawnOptions() {
  return {
    channel: 'general',
    pluginDirs: [
      'plugins/portable-spawn-fixture',
      'plugins/legacy-spawn-fixture',
      UNMANAGED_ROOT,
    ],
    mcpConfigPaths: RUNTIME_MCP_PATHS,
    loadCortexRules: false,
  };
}

function assertFingerprint(config: AgentSpawnConfig): void {
  assert.equal(typeof config.pluginCapabilityFingerprint, 'string');
  assert.ok(config.pluginCapabilityFingerprint!.length > 0);
}

function assertClaudePluginRuntime(config: AgentSpawnConfig): void {
  assert.deepEqual(config.mcpConfigPaths, RUNTIME_MCP_PATHS);
  assert.equal(config.pluginDirs?.length, 3);
  assert.ok(config.pluginDirs?.[0].includes(path.join('plugin-runtime', 'claude')));
  assert.deepEqual(config.pluginDirs?.slice(1), [LEGACY_ROOT, UNMANAGED_ROOT]);
  assert.equal(config.pluginSkillDirs, undefined);
  assert.deepEqual(config.mcpServers?.map((server) => server.name), [PORTABLE_SERVER_NAME]);
  assertFingerprint(config);
}

function assertPiPluginRuntime(config: AgentSpawnConfig): void {
  assert.deepEqual(config.mcpConfigPaths, RUNTIME_MCP_PATHS);
  assert.deepEqual(config.pluginDirs, [LEGACY_ROOT, UNMANAGED_ROOT]);
  assert.equal(config.pluginSkillDirs?.length, 1);
  assert.ok(config.pluginSkillDirs?.[0].includes(path.join('plugin-runtime', 'pi')));
  assert.notEqual(config.pluginSkillDirs?.[0], path.join(PORTABLE_ROOT, 'skills', 'portable-skill'));
  assert.deepEqual(config.mcpServers?.map((server) => server.name), [PORTABLE_SERVER_NAME]);
  assertFingerprint(config);
}

function assertPortableRuntimePropagation(): void {
  removePluginRuntimeFixture();
  try {
    installPluginRuntimeFixture();
    const options = pluginRuntimeSpawnOptions();
    const claude = facadeTest.buildSpawnConfig(options, FIXTURE_CONFIG, undefined);
    const pi = facadeTest.buildSpawnConfig(options, {
      model: 'pi-fixture', backend: 'pi', mode: null, provider: 'anthropic',
    }, undefined);
    assertClaudePluginRuntime(claude);
    assertPiPluginRuntime(pi);
    assert.notEqual(pi.pluginCapabilityFingerprint, claude.pluginCapabilityFingerprint);
  } finally {
    removePluginRuntimeFixture();
  }
}

test(
  'buildSpawnConfig resolves plugin runtime per backend and preserves explicit mcpConfigPaths',
  assertPortableRuntimePropagation,
);

function assertChannelPluginFiltering(): void {
  const pluginRoot = path.join(DATA_DIR, 'plugins', 'cortex-feishu');
  rmSync(pluginRoot, { recursive: true, force: true });
  try {
    writePortableSkillPlugin(
      pluginRoot,
      'cortex-feishu',
      'feishu-skill',
      'feishu fixture skill.',
    );
    const config = facadeTest.buildSpawnConfig({
      channel: 'general', pluginDirs: ['plugins/cortex-feishu'], loadCortexRules: false,
    }, FIXTURE_CONFIG, undefined);
    assert.equal(config.pluginDirs, undefined);
    assert.equal(config.pluginCapabilityFingerprint, undefined);
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
}

test('channel-scoped plugin filtering happens before runtime projection', assertChannelPluginFiltering);

function assertMalformedPluginDirsIgnored(): void {
  const config = facadeTest.buildSpawnConfig({
    channel: 'general',
    pluginDirs: 'plugins/not-an-array' as never,
    loadCortexRules: false,
  }, FIXTURE_CONFIG, undefined);

  assert.equal(config.pluginDirs, undefined);
  assert.equal(config.pluginCapabilityFingerprint, undefined);
}

test(
  'buildSpawnConfig ignores malformed pluginDirs values instead of crashing',
  assertMalformedPluginDirsIgnored,
);

test('ordinary direct and thread spawn argv and environment match base goldens byte-for-byte', () => {
  deterministicEnvironment();
  try {
    assert.equal(resolvedGolden(directSpawnConfig()), readFileSync(DIRECT_GOLDEN, 'utf8'));
    assert.equal(resolvedGolden(threadSpawnConfig()), readFileSync(THREAD_GOLDEN, 'utf8'));
  } finally {
    replaceEnvironment(originalEnv);
    resetSettingsForTests();
  }
});

test('the empty composition is strict and exposes no MCP servers', () => {
  generateMcpConfig();
  assert.deepEqual(declaredServers('none'), []);
});

test('initialization writes the empty MCP composition file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cortex-init-composition-'));
  const paths = getResolvedPaths(root);
  const answers: InitAnswers = {
    lang: 'en', backends: ['claude'], machineName: 'fixture', gpuCount: 0,
    platforms: [], gatewayUsage: { enabled: false }, installService: false,
  };
  mkdirSync(paths.CONFIG_DIR, { recursive: true });
  mkdirSync(paths.STORE_DIR, { recursive: true });
  try {
    generateConfigs(paths, answers, false);
    const empty = JSON.parse(readFileSync(path.join(paths.CONFIG_DIR, 'mcp-config-empty.json'), 'utf8'));
    assert.deepEqual(Object.keys(empty.mcpServers), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function stubBackendChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true,
  });
  return child;
}

test('PI carries the empty MCP composition strictly', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-strict-'));
  const spawned: NodeJS.ProcessEnv[] = [];
  const adapter = new PIAdapter((_cmd, _args, opts) => {
    spawned.push(opts.env ?? {});
    return { process: stubBackendChild() };
  }, root);

  adapter.spawn({
    sessionId: null, sessionKey: 'pi-none', resume: false,
    mcpComposition: 'none',
  });
  assert.equal(spawned[0][PI_MCP_COMPOSITION_ENV], 'none');
  assert.deepEqual(buildServerStates(spawned[0]), []);
  rmSync(root, { recursive: true, force: true });
});

interface PiSpawnCapture {
  argv: string[][];
  envs: NodeJS.ProcessEnv[];
}

function capturingPiAdapter(capture: PiSpawnCapture): PIAdapter {
  return new PIAdapter((_cmd, args, opts) => {
    capture.argv.push(args);
    capture.envs.push(opts.env ?? {});
    return { process: stubBackendChild() };
  }, mkdtempSync(path.join(tmpdir(), 'pi-plugin-mcp-')));
}

function spawnPrivatePluginServer(adapter: PIAdapter): void {
  adapter.spawn({
    sessionId: null,
    sessionKey: 'pi-plugin-mcp',
    resume: false,
    mcpComposition: 'direct',
    mcpServers: [{
      name: 'portable-private',
      type: 'stdio',
      command: '/opt/private-server',
      args: ['--token', 'secret-arg'],
      env: { API_KEY: 'secret-env' },
      cwd: '/opt/private-cwd',
    }],
  });
}

function assertPrivatePluginCapture(capture: PiSpawnCapture): void {
  assert.equal(capture.argv.length, 1);
  assert.equal(capture.envs.length, 1);
  assert.ok(capture.argv[0].every(value => !value.includes('secret-arg')));
  assert.ok(capture.argv[0].every(value => !value.includes('secret-env')));
  const configPath = capture.envs[0][PI_PLUGIN_MCP_CONFIG_ENV];
  assert.equal(typeof configPath, 'string');
  assert.ok(configPath!.includes(path.join('plugin-runtime', 'pi-mcp')));
  const states = buildServerStates(capture.envs[0]).map(state => state.name);
  assert.deepEqual(states, [
    'core', 'tasks', 'manager-qa', 'ext', pluginServerStateName('portable-private'),
  ]);
}

function assertPiPrivatePluginMcpBridge(): void {
  const capture: PiSpawnCapture = { argv: [], envs: [] };
  spawnPrivatePluginServer(capturingPiAdapter(capture));
  assertPrivatePluginCapture(capture);
}

test(
  'PI adapter writes private plugin MCP config to env only and the bridge resolves namespaced plugin states from it',
  assertPiPrivatePluginMcpBridge,
);

function installFakeClaude(binDir: string): void {
  const fakeClaude = path.join(binDir, 'claude');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.env.CWD_MARKER) writeFileSync(process.env.CWD_MARKER, process.cwd());
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (process.env.EMIT_CONTEXT_USAGE === '1') {
    console.log(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: {
      model: 'claude-opus-5', usage: { input_tokens: 25000,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } } }));
  }
  const usage = process.env.EMIT_TOKEN_USAGE === '1' ? {
    input_tokens: 10, output_tokens: 5,
    cache_creation_input_tokens: 3, cache_read_input_tokens: 7,
  } : undefined;
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    session_id: request.session_id, result: 'ok', total_cost_usd: 0, num_turns: 1,
    usage, modelUsage: usage ? { 'claude-sonnet-4-5-20250929': {} } : undefined }));
});
`);
  chmodSync(fakeClaude, 0o755);
}

function installDelayedCloseFakeClaude(binDir: string): void {
  const fakeClaude = path.join(binDir, 'claude');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const marker = process.env.SESSION_MARKER;
const record = (event) => appendFileSync(marker, JSON.stringify({ event, pid: process.pid,
  cwd: process.cwd() }) + '\\n');
record('started');
process.stdin.resume();
process.stdin.on('end', () => setTimeout(() => { record('closing'); process.exit(0); }, 50));
`);
  chmodSync(fakeClaude, 0o755);
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface SessionMarkerEvent {
  event: 'started' | 'closing';
  pid: number;
  cwd: string;
}

function readSessionMarker(file: string): SessionMarkerEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionMarkerEvent);
}

function overrideEnvironment(values: Record<string, string>): () => void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function probeContextUsage(adapter: ClaudeAdapter, key: string, cwd: string) {
  const proc = adapter.spawn({
    sessionId: null, sessionKey: key, resume: false, cwd, model: 'claude-opus-5[1m]',
  });
  const eventsPromise = (async () => {
    const events = [];
    for await (const event of proc.events) events.push(event);
    return events;
  })();
  await proc.send({ text: 'usage probe' });
  await proc.close();
  return (await eventsPromise).find((event) => event.type === 'context_usage');
}

async function runCwdProbe(marker: string, sessionKey: string, cwd?: string): Promise<void> {
  process.env.CWD_MARKER = marker;
  const adapter = new ClaudeAdapter();
  try {
    await facadeTest.runWithAdapter(
      adapter,
      'cwd request',
      { channel: sessionKey, sessionKey, cwd },
      FIXTURE_CONFIG,
      undefined,
    ).promise;
  } finally {
    await adapter.close(sessionKey);
  }
}

test('Claude print uses an injected process spawner without changing argv or cwd', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cortex-spawn-injected-'));
  const binDir = path.join(root, 'bin');
  const cwd = path.join(root, 'task');
  const marker = path.join(root, 'cwd.txt');
  mkdirSync(cwd, { recursive: true });
  installFakeClaude(binDir);
  const restore = overrideEnvironment({
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    CWD_MARKER: marker,
  });
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const adapter = new ClaudeAdapter();
  t.onTestFinished(async () => {
    await adapter.close('injected-spawner');
    restore();
    rmSync(root, { recursive: true, force: true });
  });

  const processSpawner = ((command: string, args: string[], options: any) => {
    calls.push({ command, args, cwd: options.cwd });
    return { process: spawn(command, args, options) };
  }) as any;
  await facadeTest.runWithAdapter(adapter, 'probe', {
    channel: 'injected-spawner', sessionKey: 'injected-spawner', cwd, processSpawner,
  }, FIXTURE_CONFIG, undefined).promise;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'claude');
  assert.equal(calls[0].cwd, cwd);
  assert.equal(readFileSync(marker, 'utf8'), cwd);
});

test('Claude daemon print mode reports cache-inclusive input tokens', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cortex-spawn-accounting-'));
  const binDir = path.join(root, 'bin');
  installFakeClaude(binDir);
  const restore = overrideEnvironment({
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    EMIT_TOKEN_USAGE: '1',
  });
  const adapter = new ClaudeAdapter();
  t.onTestFinished(async () => {
    await adapter.close('print-accounting');
    restore();
    rmSync(root, { recursive: true, force: true });
  });
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'print-accounting', resume: false });
  const eventsPromise = (async () => {
    const events = [];
    for await (const event of proc.events) events.push(event);
    return events;
  })();
  await proc.send({ text: 'accounting probe' });
  await proc.close();
  const cost = (await eventsPromise).find((event) => event.type === 'cost_record');
  assert.deepEqual(cost, {
    type: 'cost_record', provider: 'anthropic', model: 'claude-sonnet-4-5-20250929',
    tokens_in: 10 + 3 + 7, tokens_out: 5,
    prompt_tokens: 10 + 3 + 7, cached_tokens: 7,
    input_tokens: 10, output_tokens: 5,
    cache_read_tokens: 7, cache_creation_tokens: 3,
    provider_requests: 1, cost_usd: 0,
  });
});

test('Claude print subprocess uses the requested cwd and preserves the default cwd', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cortex-spawn-cwd-'));
  const binDir = path.join(root, 'bin');
  const requestedCwd = path.join(root, 'task');
  const requestedMarker = path.join(root, 'requested-cwd.txt');
  const defaultMarker = path.join(root, 'default-cwd.txt');
  mkdirSync(requestedCwd, { recursive: true });
  installFakeClaude(binDir);

  const previousPath = process.env.PATH;
  const previousMarker = process.env.CWD_MARKER;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
  t.onTestFinished(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.CWD_MARKER;
    else process.env.CWD_MARKER = previousMarker;
    rmSync(root, { recursive: true, force: true });
  });

  await runCwdProbe(requestedMarker, 'cwd-requested', requestedCwd);
  assert.equal(readFileSync(requestedMarker, 'utf8'), requestedCwd);
  await runCwdProbe(defaultMarker, 'cwd-default');
  assert.equal(readFileSync(defaultMarker, 'utf8'), DATA_DIR);
});

test('Claude context usage reads autoCompactWindow from the requested cwd', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cortex-context-cwd-'));
  const binDir = path.join(root, 'bin');
  const cwd = path.join(root, 'task');
  const key = 'context-cwd';
  mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  mkdirSync(path.join(root, 'user-config'), { recursive: true });
  writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), '{"autoCompactWindow":100000}\n');
  installFakeClaude(binDir);
  const restore = overrideEnvironment({
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    CWD_MARKER: path.join(root, 'cwd.txt'),
    EMIT_CONTEXT_USAGE: '1',
    CLAUDE_CONFIG_DIR: path.join(root, 'user-config'),
  });
  const adapter = new ClaudeAdapter();
  t.onTestFinished(async () => {
    await adapter.close(key);
    restore();
    rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(await probeContextUsage(adapter, key, cwd), {
    type: 'context_usage', usedTokens: 25_000, contextWindow: 100_000,
    percent: 25, accuracy: 'exact',
  });
});

interface ReplacementCase {
  label: string;
  initial: { cwdSuffix: string; composition: McpComposition };
  replacement: { cwdSuffix: string; composition: McpComposition };
}

const replacementCases: ReplacementCase[] = [
  { label: 'cwd', initial: { cwdSuffix: 'first', composition: 'direct' },
    replacement: { cwdSuffix: 'second', composition: 'direct' } },
  { label: 'composition', initial: { cwdSuffix: 'same', composition: 'direct' },
    replacement: { cwdSuffix: 'same', composition: 'thread-control' } },
];

interface ReplacementFixture {
  root: string;
  marker: string;
  key: string;
  initialCwd: string;
  replacementCwd: string;
  adapter: ClaudeAdapter;
  restoreEnvironment: () => void;
}

function createReplacementFixture(item: ReplacementCase): ReplacementFixture {
  const root = mkdtempSync(path.join(tmpdir(), `cortex-session-replace-${item.label}-`));
  const binDir = path.join(root, 'bin');
  const initialCwd = path.join(root, item.initial.cwdSuffix);
  const replacementCwd = path.join(root, item.replacement.cwdSuffix);
  const marker = path.join(root, 'sessions.jsonl');
  mkdirSync(initialCwd, { recursive: true });
  mkdirSync(replacementCwd, { recursive: true });
  installDelayedCloseFakeClaude(binDir);
  const restoreEnvironment = overrideEnvironment({
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    SESSION_MARKER: marker,
  });
  return { root, marker, key: `replacement-${item.label}`, initialCwd,
    replacementCwd, adapter: new ClaudeAdapter(), restoreEnvironment };
}

function spawnReplacementSession(
  fixture: ReplacementFixture,
  cwd: string,
  composition: McpComposition,
): void {
  fixture.adapter.spawn({
    sessionId: null, sessionKey: fixture.key, resume: false, cwd, mcpComposition: composition,
  });
}

async function assertReplacementSurvives(
  fixture: ReplacementFixture,
  item: ReplacementCase,
): Promise<void> {
  spawnReplacementSession(fixture, fixture.initialCwd, item.initial.composition);
  await waitFor(
    () => readSessionMarker(fixture.marker).filter((event) => event.event === 'started').length === 1,
    `${item.label} initial process did not start`,
  );
  const oldPid = readSessionMarker(fixture.marker).find((event) => event.event === 'started')!.pid;
  spawnReplacementSession(fixture, fixture.replacementCwd, item.replacement.composition);
  await waitFor(
    () => readSessionMarker(fixture.marker).filter((event) => event.event === 'started').length === 2,
    `${item.label} replacement process did not start`,
  );
  await waitFor(() => !existsSync(`/proc/${oldPid}`), `${item.label} old process did not close`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(fixture.adapter.listSessions().includes(fixture.key),
    `${item.label} replacement was removed from the pool`);
}

async function cleanupReplacementFixture(fixture: ReplacementFixture): Promise<void> {
  await fixture.adapter.close(fixture.key);
  const started = readSessionMarker(fixture.marker).filter((event) => event.event === 'started');
  for (const event of started) {
    try { process.kill(event.pid, 'SIGTERM'); } catch {}
  }
  fixture.restoreEnvironment();
  rmSync(fixture.root, { recursive: true, force: true });
}

async function runReplacementProbe(item: ReplacementCase): Promise<void> {
  const fixture = createReplacementFixture(item);
  try {
    await assertReplacementSurvives(fixture, item);
  } finally {
    await cleanupReplacementFixture(fixture);
  }
}

test.each(replacementCases)(
  'a delayed old-session close cannot unregister its $label replacement',
  runReplacementProbe,
);

// --- per-spawn mode route: the mode decision must travel with one spawn, not the daemon global ---

const ROUTE_FIXTURE_KEY = 'sk-fixture-route-key';
const STALE_ROUTE_URL = 'http://127.0.0.1:9880/m/stale-mode/anthropic';
const ROUTE_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
] as const;

/** Pins every input the mode decision reads — the saved key, the stale daemon global, and the
 *  Claude-owned credential probe — so a resolved route is a function of the mode alone. */
function pinRouteEnvironment(): () => void {
  const previous = ROUTE_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  const claudeConfigDir = mkdtempSync(path.join(tmpdir(), 'cortex-route-claude-'));
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  process.env.ANTHROPIC_API_KEY = ROUTE_FIXTURE_KEY;
  process.env.ANTHROPIC_BASE_URL = STALE_ROUTE_URL;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  getSavedApiEnv(); // fold the fixture key into the module's saved-credential snapshot
  return () => {
    _testSetHealthy(null);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(claudeConfigDir, { recursive: true, force: true });
  };
}

function routeSpawnConfig(
  key: string,
  route: ModeEnv,
  config: AgentConfig = FIXTURE_CONFIG,
): AgentSpawnConfig {
  return facadeTest.buildSpawnConfig({
    channel: key, sessionKey: key, sessionId: `${key}-session`, loadCortexRules: false,
  }, config, route);
}

function planConfig(extraEnv?: Record<string, string>): AgentConfig {
  return { ...FIXTURE_CONFIG, mode: 'plan', extraEnv };
}

/** Simulates another mode configuring the daemon between this spawn's route resolution and its
 *  actual launch — the K-053 race, reproduced deterministically. */
function repointDaemonGlobals(): void {
  process.env.ANTHROPIC_BASE_URL = STALE_ROUTE_URL;
  process.env.ANTHROPIC_API_KEY = ROUTE_FIXTURE_KEY;
}

test('interleaved mode configuration cannot cross-contaminate two concurrent spawns', (t) => {
  t.onTestFinished(pinRouteEnvironment());
  _testSetHealthy(true);
  const plan = facadeTest.configureRunRoute({ project: 'alpha' }, planConfig());
  const codex = facadeTest.configureRunRoute(
    { project: 'beta' }, { ...FIXTURE_CONFIG, mode: 'openai-codex' },
  );
  // Neither configuration wrote the daemon global — the race has nothing left to lose.
  assert.equal(process.env.ANTHROPIC_BASE_URL, STALE_ROUTE_URL,
    'resolving a route may not repoint the daemon: that global is what the usage probe inherits');
  assert.equal(process.env.ANTHROPIC_API_KEY, ROUTE_FIXTURE_KEY);

  // An unrelated writer flips the global while the two spawns launch; neither may read it.
  repointDaemonGlobals();
  const planEnv = childEnvironment(routeSpawnConfig('route-plan', plan));
  delete process.env.ANTHROPIC_API_KEY;
  const codexEnv = childEnvironment(routeSpawnConfig('route-codex', codex));

  assert.equal(planEnv.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/plan/project=alpha/anthropic`);
  assert.equal(planEnv.ANTHROPIC_API_KEY, undefined,
    'the plan spawn must not inherit the key sitting in the daemon env when it launches');
  assert.equal(codexEnv.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/openai-codex/project=beta/anthropic`);
  assert.equal(codexEnv.ANTHROPIC_API_KEY, ROUTE_FIXTURE_KEY,
    'the non-plan spawn must carry its own key even though the daemon env has none when it launches');
});

test('a plan route deletes the API key and carries its base URL on exactly one field', (t) => {
  t.onTestFinished(pinRouteEnvironment());
  _testSetHealthy(true);
  const spawn = routeSpawnConfig(
    'route-plan-gateway', facadeTest.configureRunRoute({}, planConfig()),
  );

  assert.equal(spawn.anthropicBaseUrl, `${GATEWAY_URL}/m/plan/anthropic`);
  assert.equal(spawn.env?.ANTHROPIC_BASE_URL, undefined,
    'the base URL needs one source: production-attempt-identity reads config.env before the field');
  assert.deepEqual(spawn.unsetEnv, ['ANTHROPIC_API_KEY']);

  repointDaemonGlobals();
  const env = childEnvironment(spawn);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/plan/anthropic`);
});

test('a route without a base URL deletes the one the daemon left behind', (t) => {
  t.onTestFinished(pinRouteEnvironment());
  _testSetHealthy(false);
  const route = facadeTest.configureRunRoute({}, planConfig());
  assert.equal(route.ANTHROPIC_BASE_URL, undefined, 'the direct plan route has no base URL');

  const spawn = routeSpawnConfig('route-plan-direct', route);
  assert.equal(spawn.anthropicBaseUrl, undefined);
  assert.deepEqual([...spawn.unsetEnv!].sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

  repointDaemonGlobals();
  const env = childEnvironment(spawn);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined,
    'the route fully decides the base URL, so its absence means delete, not inherit');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('profile extraEnv outranks the credentials a mode route sets', (t) => {
  t.onTestFinished(pinRouteEnvironment());
  _testSetHealthy(true);
  const codex: AgentConfig = { ...FIXTURE_CONFIG, mode: 'openai-codex' };
  const route = facadeTest.configureRunRoute({}, codex);
  assert.equal(route.ANTHROPIC_API_KEY, ROUTE_FIXTURE_KEY, 'the route sets a key to be overridden');
  const spawn = routeSpawnConfig('route-extra-wins', route, {
    ...codex, extraEnv: { ANTHROPIC_API_KEY: 'profile-key' },
  });

  assert.equal(spawn.env?.ANTHROPIC_API_KEY, 'profile-key');
  assert.equal(childEnvironment(spawn).ANTHROPIC_API_KEY, 'profile-key');
});

test('a key the profile sets explicitly is never deleted by the route', (t) => {
  t.onTestFinished(pinRouteEnvironment());
  _testSetHealthy(false);
  const route = facadeTest.configureRunRoute({}, planConfig());
  const spawn = routeSpawnConfig('route-extra-kept', route, planConfig({
    ANTHROPIC_API_KEY: 'profile-key', ANTHROPIC_BASE_URL: 'https://profile.example',
  }));

  assert.equal(spawn.unsetEnv, undefined,
    'the profile configured both keys explicitly, so the mode may not delete either');
  const env = childEnvironment(spawn);
  assert.equal(env.ANTHROPIC_API_KEY, 'profile-key');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://profile.example');
});

// --- pool: a live session may only be reused when its child took the same route ---

const POOL_ROUTE_URL = 'http://127.0.0.1:9880/m/plan/anthropic';
const POOL_SECRET = 'sk-ant-oat01-pool-fixture-secret';
const poolSpawner = (() => ({ process: stubBackendChild() })) as any;

/** A pooled spawn whose route came out of the real mode resolver, so the pool sees what a mode
 *  switch actually produces rather than a hand-written approximation of it. */
function pooledRouteSpawn(
  key: string,
  route: ModeEnv,
  config: AgentConfig = FIXTURE_CONFIG,
): AgentSpawnConfig {
  return facadeTest.buildSpawnConfig({
    channel: key, sessionKey: key, sessionId: `${key}-session`, loadCortexRules: false,
    processSpawner: poolSpawner,
  }, config, route);
}

function pooledRouteConfig(key: string, overrides: Partial<AgentSpawnConfig>): AgentSpawnConfig {
  return {
    sessionId: key, sessionKey: key, resume: false, cwd: DATA_DIR,
    processSpawner: poolSpawner, ...overrides,
  };
}

test('the pooled route identity fingerprints a credential instead of keeping it', () => {
  const route = { anthropicBaseUrl: POOL_ROUTE_URL, extraEnv: { ANTHROPIC_API_KEY: POOL_SECRET } };
  const identity = claudeRouteIdentity(route);

  assert.ok(!identity.includes(POOL_SECRET),
    'a pooled session outlives its turn, so its comparison value may never carry the credential');
  assert.ok(identity.includes(POOL_ROUTE_URL),
    'the endpoint is not a secret and stays readable for a pool mismatch');
  assert.equal(identity, claudeRouteIdentity({ ...route }),
    'the same route must always produce the same identity');
  assert.notEqual(identity, claudeRouteIdentity({
    ...route, extraEnv: { ANTHROPIC_API_KEY: `${POOL_SECRET}-rotated` },
  }), 'rotating the credential must change the identity');
});

test('a set, an inherited and a deleted credential are three different routes', () => {
  const set = claudeRouteIdentity({ extraEnv: { ANTHROPIC_API_KEY: POOL_SECRET } });
  const inherited = claudeRouteIdentity({});
  const deleted = claudeRouteIdentity({ unsetEnv: ['ANTHROPIC_API_KEY'] });

  assert.equal(new Set([set, inherited, deleted]).size, 3,
    'inheriting the daemon key and deleting it leave the child with different credentials');
  assert.equal(claudeRouteIdentity({
    extraEnv: { ANTHROPIC_API_KEY: POOL_SECRET }, unsetEnv: ['ANTHROPIC_API_KEY'],
  }), deleted, 'unsetEnv runs after extraEnv, exactly as buildClaudeEnv applies them');
  assert.notEqual(claudeRouteIdentity({ unsetEnv: ['ANTHROPIC_BASE_URL'] }), inherited,
    'a direct route deletes the base URL the daemon left behind — that is another endpoint');
});

test('a mode switch on one channel cannot reuse the session started on the old route', async (t) => {
  t.onTestFinished(pinRouteEnvironment());
  _testSetHealthy(true);
  const adapter = new ClaudeAdapter();
  const key = 'route-pool-switch';
  const codex: AgentConfig = { ...FIXTURE_CONFIG, mode: 'openai-codex' };

  adapter.spawn(pooledRouteSpawn(key, facadeTest.configureRunRoute({}, planConfig()), planConfig()));
  const first = claudeTest.getPooledPrintSession(key);
  adapter.spawn(pooledRouteSpawn(key, facadeTest.configureRunRoute({}, codex), codex));

  assert.ok(first);
  assert.notEqual(claudeTest.getPooledPrintSession(key), first,
    'the pooled process was launched against the plan gateway with no key — it cannot serve codex');
  await adapter.close(key);
});

test('an unchanged mode route still reuses the pooled session', async (t) => {
  t.onTestFinished(pinRouteEnvironment());
  _testSetHealthy(true);
  const adapter = new ClaudeAdapter();
  const key = 'route-pool-stable';

  adapter.spawn(pooledRouteSpawn(key, facadeTest.configureRunRoute({}, planConfig()), planConfig()));
  const first = claudeTest.getPooledPrintSession(key);
  adapter.spawn(pooledRouteSpawn(key, facadeTest.configureRunRoute({}, planConfig()), planConfig()));

  assert.ok(first);
  assert.equal(claudeTest.getPooledPrintSession(key), first,
    'a re-resolved identical route must compare by value, or the pool stops pooling');
  await adapter.close(key);
});

test('the pool separates two routes that differ only by credential', async () => {
  const adapter = new ClaudeAdapter();
  const key = 'route-pool-credential';
  const endpoint = { anthropicBaseUrl: POOL_ROUTE_URL };

  adapter.spawn(pooledRouteConfig(key, { ...endpoint, env: { ANTHROPIC_API_KEY: `${POOL_SECRET}-a` } }));
  const first = claudeTest.getPooledPrintSession(key);
  adapter.spawn(pooledRouteConfig(key, { ...endpoint, env: { ANTHROPIC_API_KEY: `${POOL_SECRET}-b` } }));

  assert.ok(first);
  assert.notEqual(claudeTest.getPooledPrintSession(key), first,
    'one endpoint reached with another account is another route');
  await adapter.close(key);
});

test('the TUI pool compares the route the same way', async () => {
  const adapter = new ClaudeAdapter();
  const key = 'route-pool-tui';
  const tui: Partial<AgentSpawnConfig> = {
    claudeBackend: 'tui', anthropicBaseUrl: POOL_ROUTE_URL,
  };

  adapter.spawn(pooledRouteConfig(key, tui));
  const first = claudeTest.getPooledTuiSession(key);
  adapter.spawn(pooledRouteConfig(key, tui));
  assert.equal(claudeTest.getPooledTuiSession(key), first,
    'an identical route keeps the tmux session alive');

  adapter.spawn(pooledRouteConfig(key, { ...tui, unsetEnv: ['ANTHROPIC_API_KEY'] }));
  assert.ok(first);
  assert.notEqual(claudeTest.getPooledTuiSession(key), first,
    'dropping the key changes which account the TUI session bills');
  await adapter.close(key);
});
