// input:  PI adapter, fake PI runtime, transcripts, provider discovery
// output: Session request, env, turn lifecycle, pool, compaction and resume tests
// pos:    Tests PI in-process session lifecycles
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AgentResult } from '../src/core/types/agent-types.js';
import type { NormalizedEvent } from '../src/agent-adapter/normalize/event-types.js';
import { PIAdapter, type PIAgentProcess } from '../src/agent-adapter/pi/adapter.js';
import { PI_MODELS_PATH } from '../src/agent-adapter/pi/defaults.js';
import { createPIProviderDiscovery } from '../src/agent-adapter/pi/discovery.js';
import { buildPiEnv, PI_INTERACTION_BRIDGE_ENV } from '../src/agent-adapter/pi/spawn-args.js';
import {
  collectEvents, makeFakeRuntimeFactory, type FakeRuntime,
} from './agent-adapter/pi-fake-runtime.js';

// Writable temp session dir used by Group G tests (avoids root-level paths that fail with EACCES).
const G_SESSION_DIR = pathJoin(tmpdir(), `pi-test-sessions-${process.pid}`);
mkdirSync(G_SESSION_DIR, { recursive: true });

// --- Helpers over the fake runtime ---

/** One macrotask: enough for the session's microtask-only dispatch chain to settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Wait until the fake has recorded `count` prompt calls; the session dispatches asynchronously. */
async function awaitPrompts(runtime: FakeRuntime, count: number): Promise<void> {
  for (let i = 0; i < 20 && runtime.prompts().length < count; i++) await tick();
  assert.equal(runtime.prompts().length, count, `PI received ${count} prompt(s)`);
}

/** Send one message and return its turn once the session has handed the prompt to PI. */
async function startTurn(
  proc: PIAgentProcess, runtime: FakeRuntime, text: string,
): Promise<{ turn: Promise<AgentResult> }> {
  const expected = runtime.prompts().length + 1;
  const turn = proc.send({ text });
  await awaitPrompts(runtime, expected);
  return { turn };
}

/** The next event of an open run stream; fails if the stream ended instead. */
async function nextEvent(iterator: AsyncIterator<NormalizedEvent>): Promise<NormalizedEvent> {
  const entry = await iterator.next();
  assert.equal(entry.done, false, 'the run stream is still open');
  return entry.value as NormalizedEvent;
}

/** Transcript paths the session asked the runtime to switch to, in call order. */
function switchCalls(runtime: FakeRuntime): string[] {
  return runtime.calls.flatMap((call) => (call.kind === 'switch' ? [call.path] : []));
}

test('spawn accepts explicit direct and thread-control MCP compositions', () => {
  for (const composition of ['direct', 'thread-control'] as const) {
    const fake = makeFakeRuntimeFactory();
    const adapter = new PIAdapter(fake.factory);
    const proc = adapter.spawn({
      sessionId: null,
      sessionKey: `pi-${composition}`,
      resume: false,
      mcpComposition: composition,
    });

    assert.equal(fake.requests.length, 1, `${composition} must reach the runtime factory`);
    proc.kill();
  }
});

// --- Group B: session request (done-when: prompts, skill roots and thinking resolve into PiSessionRequest) ---

test('spawn resolves prompts and skill roots into the session request', () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({
    sessionId: null,
    sessionKey: 'request-prompts',
    resume: false,
    systemPrompt: 'sp',
    appendSystemPrompt: 'asp',
    pluginDirs: ['/a', '/b'],
  });

  const request = fake.requests[0];
  assert.equal(request.systemPrompt, 'sp');
  assert.deepEqual(request.appendSystemPrompt, ['asp']);
  assert.deepEqual(request.skillPaths, ['/a', '/b']);
  assert.equal(request.sessionPath, null, 'a fresh spawn resumes no transcript');
  proc.kill();
});

test('spawn places portable pluginSkillDirs before pluginDirs in skillPaths', () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({
    sessionId: null,
    sessionKey: 'request-skills',
    resume: false,
    pluginSkillDirs: ['/portable/skill-a', '/portable/skill-b'],
    pluginDirs: ['/legacy/plugin'],
  });

  assert.deepEqual(fake.requests[0].skillPaths, [
    '/portable/skill-a',
    '/portable/skill-b',
    '/legacy/plugin',
  ]);
  proc.kill();
});

test('spawn resolves the thinking level from the profile, letting an explicit --thinking extraOption win', () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const procs = [
    adapter.spawn({ sessionId: null, sessionKey: 'thinking-profile', resume: false, thinking: 'high' }),
    adapter.spawn({ sessionId: null, sessionKey: 'thinking-absent', resume: false }),
    adapter.spawn({
      sessionId: null,
      sessionKey: 'thinking-extra',
      resume: false,
      thinking: 'high',
      extraOption: { '--thinking': 'xhigh' },
    }),
  ];

  assert.equal(fake.requests[0].thinking, 'high');
  assert.equal(fake.requests[1].thinking, null, 'no thinking level when the profile has none');
  assert.equal(fake.requests[2].thinking, 'xhigh', 'an explicit extraOption still wins');
  for (const proc of procs) proc.kill();
});

test('spawn resolves no skill roots when pluginDirs is empty or undefined', () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const procs = [
    adapter.spawn({ sessionId: null, sessionKey: 'skills-empty', resume: false, pluginDirs: [] }),
    adapter.spawn({ sessionId: null, sessionKey: 'skills-undefined', resume: false }),
  ];

  assert.deepEqual(fake.requests[0].skillPaths, []);
  assert.deepEqual(fake.requests[1].skillPaths, []);
  for (const proc of procs) proc.kill();
});

// --- Group B2: the session's CORTEX_* env (read by hook scripts and plugin MCP servers) ---

test('spawn forwards authoritative Cortex thread context to the session env', () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({
    sessionId: 'backend-session',
    sessionKey: 'context-env',
    resume: false,
    callbackSource: 'thread',
    scheduleTaskId: 'schedule-1',
    env: { CORTEX_THREAD_ID: 'spoofed', CUSTOM_ENV: 'kept' },
    cortexContext: {
      threadId: 'thr_test',
      profile: 'deepseek-pro',
      project: 'vr-security',
      sessionName: 'cortex-test',
      trackSessionId: 'tracked-session',
      executionId: 'exec-test',
      threadDepth: 2,
      taskId: 'ab1a',
      taskProject: 'vr-security',
    },
  });

  const env = fake.requests[0].env;
  assert.equal(env.CORTEX_THREAD_ID, 'thr_test');
  assert.equal(env.CORTEX_PROFILE, 'deepseek-pro');
  assert.equal(env.CORTEX_PROJECT, 'vr-security');
  assert.equal(env.CORTEX_SESSION_NAME, 'cortex-test');
  assert.equal(env.CORTEX_SESSION_ID, 'tracked-session');
  assert.equal(env.CORTEX_EXECUTION_ID, 'exec-test');
  assert.equal(env.CORTEX_THREAD_DEPTH, '2');
  assert.equal(env.CORTEX_TASK_ID, 'ab1a');
  assert.equal(env.CORTEX_TASK_PROJECT, 'vr-security');
  assert.equal(env.CORTEX_CALLBACK_SOURCE, 'thread');
  assert.equal(env.CORTEX_SCHEDULE_TASK_ID, 'schedule-1');
  assert.equal(env.CORTEX_BACKEND, 'pi');
  assert.equal(env.CUSTOM_ENV, 'kept');

  proc.kill();
});

test('spawn forwards AgentSpawnConfig.unsetEnv to the session env', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-inherited';
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  try {
    const proc = adapter.spawn({
      sessionId: 'unset-env-session',
      sessionKey: 'unset-env',
      resume: false,
      env: { ANTHROPIC_API_KEY: 'cortex-gateway-managed', KEPT_ENV: 'kept' },
      unsetEnv: ['ANTHROPIC_API_KEY'],
    });

    const env = fake.requests[0].env;
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY'), false);
    assert.equal(env.KEPT_ENV, 'kept');

    proc.kill();
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('buildPiEnv removes stale optional Cortex context from the parent env', () => {
  const stale = {
    SLACK_CHANNEL: 'stale-channel',
    FEISHU_CHANNEL: 'stale-feishu',
    CORTEX_THREAD_ID: 'stale-thread',
    CORTEX_PROFILE: 'stale-profile',
    CORTEX_PROJECT: 'stale-project',
    CORTEX_SESSION_NAME: 'stale-name',
    CORTEX_EXECUTION_ID: 'stale-execution',
    CORTEX_THREAD_DEPTH: '9',
    CORTEX_TASK_ID: 'stale-task',
    CORTEX_TASK_PROJECT: 'stale-task-project',
    CORTEX_CALLBACK_SOURCE: 'stale-callback',
    CORTEX_SCHEDULE_TASK_ID: 'stale-schedule',
    CORTEX_CONFIG_IMMUTABLE: '1',
    CORTEX_WEBHOOK_SINGLE_ROOT: '1',
    CORTEX_WEBHOOK_SINGLE_ROOT_TEMPLATE: 'stale-root-template',
    CORTEX_PI_SUBAGENT: '1',
    [PI_INTERACTION_BRIDGE_ENV]: '1',
  };
  const env = buildPiEnv({
    sessionId: null,
    piAgentDir: '/pi-agent',
  }, stale);

  for (const key of Object.keys(stale)) assert.equal(env[key], undefined, key);
  assert.equal(env.CORTEX_SESSION_ID, undefined);
  assert.equal(env.CORTEX_BACKEND, 'pi');
  assert.equal(env.PI_CODING_AGENT_DIR, '/pi-agent');
});

test('buildPiEnv sets the shared interaction bridge marker only from trusted options', () => {
  const inherited = { [PI_INTERACTION_BRIDGE_ENV]: 'spoofed' };
  const cleared = buildPiEnv({ piAgentDir: '/pi-agent' }, inherited);
  assert.equal(cleared[PI_INTERACTION_BRIDGE_ENV], undefined);

  const enabled = buildPiEnv({ piAgentDir: '/pi-agent', enableInteractionBridge: true }, inherited);
  assert.equal(enabled[PI_INTERACTION_BRIDGE_ENV], '1');
});

test('PIAdapter enables the shared interaction bridge only for direct user sessions', () => {
  for (const entry of [
    { key: 'pi-user-direct', isUserInitiated: true, mcpComposition: 'direct' as const, expected: '1' },
    { key: 'pi-nonuser-direct', isUserInitiated: false, mcpComposition: 'direct' as const, expected: undefined },
    { key: 'pi-user-thread', isUserInitiated: true, mcpComposition: 'thread-control' as const, expected: undefined },
  ]) {
    const fake = makeFakeRuntimeFactory();
    const adapter = new PIAdapter(fake.factory);
    const proc = adapter.spawn({
      sessionId: null,
      sessionKey: entry.key,
      resume: false,
      isUserInitiated: entry.isUserInitiated,
      mcpComposition: entry.mcpComposition,
      env: { [PI_INTERACTION_BRIDGE_ENV]: 'spoofed' },
    });
    assert.equal(fake.requests[0].env[PI_INTERACTION_BRIDGE_ENV], entry.expected, entry.key);
    proc.kill();
  }
});

test('buildPiEnv preserves server auth for ordinary PI MCP sessions', () => {
  const env = buildPiEnv({ piAgentDir: '/pi-agent' }, {
    CORTEX_CLIENT_TOKEN: 'ordinary-client-token',
    CORTEX_WEBHOOK_TOKEN: 'ordinary-webhook-token',
  });

  assert.equal(env.CORTEX_CLIENT_TOKEN, 'ordinary-client-token');
  assert.equal(env.CORTEX_WEBHOOK_TOKEN, 'ordinary-webhook-token');
});

test('buildPiEnv scrubs production bootstrap controls from the child', () => {
  const env = buildPiEnv({ piAgentDir: '/pi-agent' }, {
    CORTEX_CONFIG_IMMUTABLE: '1',
    CORTEX_PRODUCTION_AUTH_FILE: '/inherited/auth.json',
    CORTEX_WEBHOOK_THREAD_OP_ONLY: '1',
    CORTEX_WEBHOOK_SINGLE_ROOT: 'root-run',
    CORTEX_WEBHOOK_SINGLE_ROOT_TEMPLATE: 'benchmark-coder-review',
    CORTEX_PRODUCTION_BENCHMARK_EVIDENCE_CONTEXT_FILE: '/inherited/evidence-context.json',
  });

  for (const key of [
    'CORTEX_CONFIG_IMMUTABLE',
    'CORTEX_PRODUCTION_AUTH_FILE',
    'CORTEX_WEBHOOK_THREAD_OP_ONLY',
    'CORTEX_WEBHOOK_SINGLE_ROOT',
    'CORTEX_WEBHOOK_SINGLE_ROOT_TEMPLATE',
    'CORTEX_PRODUCTION_BENCHMARK_EVIDENCE_CONTEXT_FILE',
  ]) assert.equal(env[key], undefined, key);
});

// --- buildPiEnv unsetEnv (PI routes by env only: env is its sole mode lever) ---

test('buildPiEnv unsetEnv deletes a key inherited from the parent env', () => {
  const env = buildPiEnv({
    piAgentDir: '/pi-agent',
    unsetEnv: ['ANTHROPIC_API_KEY'],
  }, {
    ANTHROPIC_API_KEY: 'sk-ant-inherited',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9880/m/openai-codex/anthropic',
  });

  // Absent, not empty — PI already treats an empty string as a legal value (PI_CODING_AGENT_DIR).
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY'), false);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9880/m/openai-codex/anthropic');
  assert.equal(env.PI_CODING_AGENT_DIR, '/pi-agent');
});

test('buildPiEnv unsetEnv runs after the extraEnv merge, so an extraEnv-set key is still deleted', () => {
  const env = buildPiEnv({
    piAgentDir: '/pi-agent',
    extraEnv: { ANTHROPIC_API_KEY: 'cortex-gateway-managed', KEPT_ENV: 'kept' },
    unsetEnv: ['ANTHROPIC_API_KEY'],
  }, {
    ANTHROPIC_API_KEY: 'sk-ant-inherited',
  });

  assert.equal(Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY'), false);
  assert.equal(env.KEPT_ENV, 'kept');
});

test('buildPiEnv preserves an explicit PI subagent marker after reset', () => {
  const env = buildPiEnv({
    piAgentDir: '/pi-agent',
    subagentMarker: '1',
  }, {
    CORTEX_PI_SUBAGENT: 'stale-parent-marker',
  });

  assert.equal(env.CORTEX_PI_SUBAGENT, '1');
});

test('PIAdapter hands plugin MCP servers to the session only for compositions that allow them', () => {
  const server = {
    name: 'portable-plugin',
    type: 'sse' as const,
    url: 'https://private.example.com/events',
    headers: {},
  };
  for (const entry of [
    { key: 'pi-direct', mcpComposition: 'direct' as const, expected: [server] },
    { key: 'pi-none', mcpComposition: 'none' as const, expected: [] },
    {
      key: 'pi-subagent',
      mcpComposition: 'thread-control' as const,
      env: { CORTEX_PI_SUBAGENT: '1' },
      expected: [],
    },
  ]) {
    const fake = makeFakeRuntimeFactory();
    const adapter = new PIAdapter(fake.factory);
    const proc = adapter.spawn({
      sessionId: null,
      sessionKey: entry.key,
      resume: false,
      mcpComposition: entry.mcpComposition,
      env: entry.env,
      mcpServers: [server],
    });

    assert.deepEqual(fake.requests[0].pluginMcpServers, entry.expected, entry.key);
    if (entry.env?.CORTEX_PI_SUBAGENT === '1') assert.equal(fake.requests[0].env.CORTEX_PI_SUBAGENT, '1');
    proc.kill();
  }
});

// --- D1: provider passed through from the profile, not hardcoded ---

test('PIAdapter passes the profile provider and model to the session', () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({
    sessionId: null,
    sessionKey: 'openai-codex-profile',
    resume: false,
    model: 'gpt-5.4-mini',
    piProvider: 'openai-codex',
  });

  assert.equal(fake.requests[0].provider, 'openai-codex');
  assert.equal(fake.requests[0].model, 'gpt-5.4-mini');
  proc.kill();
});

test('PIAdapter does not default the provider to "anthropic" when only a model is given', () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({
    sessionId: null,
    sessionKey: 'model-only',
    resume: false,
    model: 'claude-opus-4-7',
  });

  assert.equal(fake.requests[0].provider, null, 'PI infers the provider when the profile names none');
  assert.equal(fake.requests[0].model, 'claude-opus-4-7');
  proc.kill();
});

test('gateway spawns return while one slow discovery warms provider overrides', async () => {
  let resolveDiscovery!: (providers: string[]) => void;
  let scans = 0;
  const slowDiscovery = new Promise<string[]>((resolve) => { resolveDiscovery = resolve; });
  const discovery = createPIProviderDiscovery({
    scan: () => {
      scans += 1;
      return slowDiscovery;
    },
  });
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR, discovery);
  const processes = [];

  processes.push(adapter.spawn({
    sessionId: null,
    sessionKey: 'gateway-cold-anthropic',
    resume: false,
    model: 'claude-sonnet-4-6',
    piProvider: 'anthropic',
    piGatewayBaseUrl: 'http://127.0.0.1:9880',
    piGatewayPath: '/m/default/anthropic',
  }));
  let models = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8'));
  assert.equal(models.providers.anthropic.baseUrl, 'http://127.0.0.1:9880/m/default/anthropic');

  processes.push(adapter.spawn({
    sessionId: null,
    sessionKey: 'gateway-cold-deepseek',
    resume: false,
    model: 'deepseek-chat',
    piProvider: 'deepseek',
    piGatewayBaseUrl: 'http://127.0.0.1:9880',
    piGatewayPath: '/m/default/deepseek',
  }));
  models = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8'));
  assert.deepEqual(Object.keys(models.providers).sort(), ['anthropic', 'deepseek']);
  assert.equal(models.providers.anthropic.baseUrl, 'http://127.0.0.1:9880/m/default/anthropic');
  assert.equal(models.providers.deepseek.baseUrl, 'http://127.0.0.1:9880/m/default/deepseek');

  processes.push(adapter.spawn({
    sessionId: null,
    sessionKey: 'gateway-cold-no-provider',
    resume: false,
    piGatewayBaseUrl: 'http://127.0.0.1:9880',
  }));
  models = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8'));
  assert.deepEqual(Object.keys(models.providers).sort(), ['anthropic', 'deepseek']);
  assert.equal(fake.requests.length, 3, 'all PI sessions start before discovery settles');

  await Promise.resolve();
  assert.equal(scans, 1, 'concurrent cold spawns coalesce provider discovery');
  resolveDiscovery(['anthropic', 'anthropic', 'openai-codex']);
  await tick();

  processes.push(adapter.spawn({
    sessionId: null,
    sessionKey: 'gateway-warm-deepseek',
    resume: false,
    model: 'deepseek-chat',
    piProvider: 'deepseek',
    piGatewayBaseUrl: 'http://127.0.0.1:9880',
    piGatewayPath: '/m/pro/deepseek',
  }));
  models = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8'));
  assert.deepEqual(Object.keys(models.providers).sort(), ['anthropic', 'deepseek', 'openai-codex']);
  assert.equal(models.providers.deepseek.baseUrl, 'http://127.0.0.1:9880/m/pro/deepseek');
  assert.equal(scans, 1, 'fresh cache avoids another list-models call');

  for (const proc of processes) proc.kill();
});

test('failed gateway discovery preserves current-provider fallback without delaying spawn', async () => {
  let scans = 0;
  const discovery = createPIProviderDiscovery({
    scan: async () => {
      scans += 1;
      throw new Error('pi list-models failed');
    },
  });
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR, discovery);

  const proc = adapter.spawn({
    sessionId: null,
    sessionKey: 'gateway-failed-discovery',
    resume: false,
    model: 'claude-opus-4-8',
    piProvider: 'anthropic',
    piGatewayBaseUrl: 'http://127.0.0.1:9880',
    piGatewayPath: '/m/gateway/anthropic',
  });

  assert.equal(fake.requests.length, 1, 'spawn is not gated on discovery failure');
  const models = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8'));
  assert.deepEqual(Object.keys(models.providers), ['anthropic']);
  assert.equal(models.providers.anthropic.baseUrl, 'http://127.0.0.1:9880/m/gateway/anthropic');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scans, 1);

  proc.kill();
});

test('flags provider quota reporting only for gateway-routed runs', () => {
  const routed = makeFakeRuntimeFactory();
  const routedProc = new PIAdapter(routed.factory).spawn({
    sessionId: null,
    sessionKey: 'pi-quota-routed',
    resume: false,
    piGatewayBaseUrl: 'http://127.0.0.1:9880',
  });
  assert.equal(
    routed.requests[0].reportsProviderQuota, true,
    'a gateway-routed run must report provider quota',
  );
  routedProc.kill();

  const unrouted = makeFakeRuntimeFactory();
  const unroutedProc = new PIAdapter(unrouted.factory).spawn({
    sessionId: null,
    sessionKey: 'pi-quota-unrouted',
    resume: false,
  });
  assert.equal(
    unrouted.requests[0].reportsProviderQuota, false,
    'a run Cortex does not route must not report into the daemon throttle',
  );
  unroutedProc.kill();
});

// --- Group C: session identity (done-when: the session announces itself first) ---

test('the session announces session_started first, carrying its id and transcript path', async () => {
  const fake = makeFakeRuntimeFactory({ sessionId: 'abc-123' });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k2', resume: false });

  assert.equal(proc.sessionId, null, 'sessionId is null until the runtime exists');

  const first = await proc.events[Symbol.asyncIterator]().next();
  assert.equal(first.done, false);
  assert.deepEqual(first.value, {
    type: 'session_started',
    sessionId: 'abc-123',
    sessionFile: pathJoin(G_SESSION_DIR, 'abc-123.jsonl'),
  });
  assert.equal(proc.sessionId, 'abc-123', 'AgentProcess.sessionId getter reflects the announced id');

  proc.kill();
});

test('PI turn emits live context_usage during streaming without flushing partial text', async () => {
  const fake = makeFakeRuntimeFactory({ sessionId: 'context-live-session' });
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'context-live', resume: false });
  const runtime = await fake.runtime();
  const iterator = proc.events[Symbol.asyncIterator]();
  assert.equal((await nextEvent(iterator)).type, 'session_started');

  runtime.stats.contextUsage = { tokens: 60100, contextWindow: 200000, percent: 30.05 };
  let turnSettled = false;
  const { turn } = await startTurn(proc, runtime, 'hello');
  void turn.then(() => { turnSettled = true; });

  runtime.emit({
    type: 'message_update', message: { id: 'm-live' },
    assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
  });
  assert.deepEqual(await nextEvent(iterator), {
    type: 'assistant_delta', text: 'partial', blockId: 'm-live',
  });
  // Streaming output samples the session stats without waiting for the turn to settle.
  assert.deepEqual(await nextEvent(iterator), {
    type: 'context_usage', usedTokens: 60100, contextWindow: 200000,
    percent: 30.05, accuracy: 'estimate',
  });
  assert.equal(turnSettled, false, 'live context snapshot does not settle the turn');

  runtime.stats.contextUsage = { tokens: 60200, contextWindow: 200000, percent: 30.1 };
  runtime.emit({ type: 'message_end' });
  assert.deepEqual(await nextEvent(iterator), {
    type: 'assistant_text', text: 'partial', blockId: 'm-live',
  });
  assert.equal((await nextEvent(iterator)).type, 'turn_progress');

  runtime.emit({ type: 'agent_settled' });
  await turn;
  assert.deepEqual(await nextEvent(iterator), {
    type: 'context_usage', usedTokens: 60200, contextWindow: 200000,
    percent: 30.1, accuracy: 'estimate',
  });
  assert.equal((await nextEvent(iterator)).type, 'turn_complete');

  proc.kill();
});

test('a PI turn that ends in a provider error rejects with a classified reason', async () => {
  const fake = makeFakeRuntimeFactory({ sessionId: 'provider-error-session' });
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'provider-error', resume: false });
  const runtime = await fake.runtime();
  const iterator = proc.events[Symbol.asyncIterator]();
  assert.equal((await nextEvent(iterator)).type, 'session_started');

  const { turn } = await startTurn(proc, runtime, 'hello');
  runtime.emitAgentEnd({
    provider: 'deepseek', model: 'deepseek-v4-flash',
    stopReason: 'error', errorMessage: 'Connection error.',
  });

  const failure = await turn.then(
    () => null, (error: unknown) => error as Error & { reason?: string });
  // The message alone cannot tell a provider outage from a crash; the reason is what lets the
  // run classify itself as `provider_error` rather than a blanket `child_failure`.
  assert.equal(failure?.message, 'Connection error.');
  assert.equal(failure?.reason, 'provider_error');

  proc.kill();
});

test('settled PI turn emits context_usage before its terminal event', async () => {
  const fake = makeFakeRuntimeFactory({ sessionId: 'context-session' });
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'context-order', resume: false });
  const runtime = await fake.runtime();
  const iterator = proc.events[Symbol.asyncIterator]();
  assert.equal((await nextEvent(iterator)).type, 'session_started');

  runtime.stats.contextUsage = { tokens: 60000, contextWindow: 200000, percent: 30 };
  const { turn } = await startTurn(proc, runtime, 'hello');
  runtime.emit({ type: 'agent_settled' });
  await turn;

  assert.deepEqual(await nextEvent(iterator), {
    type: 'context_usage', usedTokens: 60000, contextWindow: 200000,
    percent: 30, accuracy: 'estimate',
  });
  assert.deepEqual(await nextEvent(iterator), {
    type: 'turn_complete', numTurns: 0, totalCostUsd: null,
  });
  let streamDone = false;
  void iterator.next().then((entry) => { streamDone = entry.done === true; });
  await tick();
  assert.equal(streamDone, true, 'per-run stream closes after its terminal event');

  proc.kill();
});

// --- Group D: run close versus session close ---

test('a finished run closes its stream and leaves the session pooled', async () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k4', resume: false });
  const runtime = await fake.runtime();

  await proc.close();

  assert.equal(runtime.disposed, false, 'the run does not dispose the pooled runtime');
  assert.ok(!runtime.calls.some((call) => call.kind === 'abort'), 'the run does not abort the pooled runtime');
  assert.ok(adapter.listSessions().includes('k4'), 'session stays pooled for the next turn');
  const events = await collectEvents(proc.events);
  assert.deepEqual(events.map((event) => event.type), ['session_started'], 'run stream ended');

  await adapter.close('k4');
});

test('adapter.close(key) disposes the runtime, ends the run stream and drops the pooled session', async () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k4b', resume: false });
  const runtime = await fake.runtime();

  await adapter.close('k4b');

  assert.equal(runtime.disposed, true, 'the runtime was disposed');
  assert.ok(!adapter.listSessions().includes('k4b'), 'session removed from adapter map');
  const events = await collectEvents(proc.events);
  assert.deepEqual(events.map((event) => event.type), ['session_started'], 'iterator terminates after close');
});

// --- Group D2: session pooling across turns ---

/** Drive one full turn on a spawned process and drain its stream to completion. */
async function runPooledTurn(proc: PIAgentProcess, runtime: FakeRuntime, text: string): Promise<void> {
  const drained = collectEvents(proc.events);
  const { turn } = await startTurn(proc, runtime, text);
  runtime.emitSimpleTurn(`${text} done`);
  await turn;
  const types = (await drained).map((event) => event.type);
  assert.ok(types.includes('turn_complete'), `turn "${text}" reached its terminal event`);
  await proc.close();
}

test('two turns on one sessionKey reuse a single runtime', async () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const config = { sessionId: null, sessionKey: 'pool-reuse', resume: false, model: 'gpt-5.6-sol' };

  const first = adapter.spawn({ ...config });
  const runtime = await fake.runtime();
  await runPooledTurn(first, runtime, 'first');

  const second = adapter.spawn({ ...config });
  assert.equal(fake.requests.length, 1, 'the second turn reuses the pooled runtime');
  await runPooledTurn(second, runtime, 'second');

  assert.deepEqual(runtime.prompts(), ['first', 'second']);

  await adapter.close('pool-reuse');
});

test('a changed spawn configuration retires the pooled session', async () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);

  const first = adapter.spawn({
    sessionId: null, sessionKey: 'pool-model', resume: false, model: 'gpt-5.6-sol',
  });
  const runtime = await fake.runtime();
  await runPooledTurn(first, runtime, 'first');

  adapter.spawn({
    sessionId: null, sessionKey: 'pool-model', resume: false, model: 'claude-sonnet-4',
  });
  assert.equal(fake.requests.length, 2, 'a different model must not run on the pooled session');
  assert.equal(fake.requests[1].model, 'claude-sonnet-4');
  await tick();
  assert.equal(runtime.disposed, true, 'the retired session releases its runtime');

  await fake.runtime(1);
  await adapter.close('pool-model');
});

test('a killed session is replaced on the next turn', async () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const config = { sessionId: null, sessionKey: 'pool-dead', resume: false };

  const first = adapter.spawn({ ...config });
  await fake.runtime();
  first.kill();

  adapter.spawn({ ...config });
  assert.equal(fake.requests.length, 2, 'a dead session is not reused');

  await fake.runtime(1);
  await adapter.close('pool-dead');
});

test('a per-run execution id does not retire the pooled session', async () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const base = { sessionId: null, sessionKey: 'pool-exec', resume: false };

  const first = adapter.spawn({ ...base, cortexContext: { executionId: 'exec-1' } });
  const runtime = await fake.runtime();
  await runPooledTurn(first, runtime, 'first');

  adapter.spawn({ ...base, cortexContext: { executionId: 'exec-2' } });
  assert.equal(fake.requests.length, 1, 'a new execution id reuses the pooled session');

  await adapter.close('pool-exec');
});

// --- Group E: fatal paths and kill ---

test('a runtime that fails to start emits a fatal error before the iterator terminates', async () => {
  const fake = makeFakeRuntimeFactory({ fail: new Error('fatal: no API key') });
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k6', resume: false });
  const turn = proc.send({ text: 'hello' });

  const events = await collectEvents(proc.events);
  assert.deepEqual(events, [{ type: 'error', message: 'fatal: no API key', fatal: true }]);
  await assert.rejects(turn, /fatal: no API key/);
  assert.ok(!adapter.listSessions().includes('k6'), 'a session that never started is evicted');
});

test('a prompt PI refuses rejects the turn and ends the run with a fatal error', async () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'prompt-refused', resume: false });
  const runtime = await fake.runtime();

  runtime.promptRejections.push(new Error('model not found'));
  await assert.rejects(proc.send({ text: 'hello' }), /model not found/);

  const events = await collectEvents(proc.events);
  assert.deepEqual(events.map((event) => event.type), ['session_started', 'error']);
  assert.deepEqual(events[1], { type: 'error', message: 'model not found', fatal: true });
  assert.ok(adapter.listSessions().includes('prompt-refused'), 'a refused prompt does not end the pooled session');

  await adapter.close('prompt-refused');
});

test('kill() aborts the PI run, disposes the runtime and cleans the adapter session map', async () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k7', resume: false });
  const runtime = await fake.runtime();

  const killed = proc.kill();
  assert.equal(killed, true);
  assert.ok(runtime.calls.some((call) => call.kind === 'abort'), 'whatever PI was doing is aborted');
  assert.ok(!adapter.listSessions().includes('k7'));
  await tick();
  assert.equal(runtime.disposed, true);
  assert.equal(proc.kill(), false, 'a second kill reports the session already gone');
});

// --- Group G: session path mapping + switchSession runtime swap ---

function stageCanonicalSession(sessionId: string): string {
  const sessionPath = pathJoin(G_SESSION_DIR, `${sessionId}.jsonl`);
  writeFileSync(sessionPath, '{}\n');
  return sessionPath;
}

test('G-1: a session whose transcript is not on disk does not expose a synthesized resume path', async () => {
  const fake = makeFakeRuntimeFactory({ sessionId: 'g1-unstaged' });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });

  // Before the runtime exists: path is unknown.
  assert.equal(adapter.resolveSessionPath('g1-unstaged'), null);

  await fake.runtime();

  // The session reports its transcript path before PI has created the file. A guessed path is
  // not resumable until it exists on disk.
  assert.equal(adapter.resolveSessionPath('g1-unstaged'), null);
  assert.equal(proc.sessionId, 'g1-unstaged');

  proc.kill();
});

test('G-2: resolveSessionPath on unknown sessionId returns null', () => {
  const adapter = new PIAdapter();
  assert.equal(adapter.resolveSessionPath('no-such-session'), null);
});

test('G-3: switchSession with unknown sessionId returns {ok:false, cancelled:false}', async () => {
  const fake = makeFakeRuntimeFactory({ sessionId: 'abc-123' });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });
  const runtime = await fake.runtime();

  // 'unknown-xyz' is not in registry → immediate {ok:false, cancelled:false}, PI is never asked.
  const result = await adapter.switchSession('unknown-xyz', 'k1');
  assert.deepEqual(result, { ok: false, cancelled: false });
  assert.deepEqual(switchCalls(runtime), [], 'no switch reaches the runtime');

  proc.kill();
});

test('G-4: switchSession re-points the runtime and resolves ok when PI does not cancel', async () => {
  const fake = makeFakeRuntimeFactory({ sessionIds: ['abc-123', 'xyz-456'] });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });
  adapter.spawn({ sessionId: null, sessionKey: 'k2', resume: false });
  const runtime1 = await fake.runtime(0);
  await fake.runtime(1);
  stageCanonicalSession('abc-123');
  stageCanonicalSession('xyz-456');

  // Switch k1's runtime to serve xyz-456.
  const result = await adapter.switchSession('xyz-456', 'k1');

  assert.deepEqual(switchCalls(runtime1), [pathJoin(G_SESSION_DIR, 'xyz-456.jsonl')]);
  assert.deepEqual(result, { ok: true, cancelled: false });

  adapter.kill('k1');
  adapter.kill('k2');
});

test('G-5: switchSession propagates a cancelled switch as not ok', async () => {
  const fake = makeFakeRuntimeFactory({ sessionIds: ['abc-123', 'xyz-456'] });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });
  adapter.spawn({ sessionId: null, sessionKey: 'k2', resume: false });
  const runtime1 = await fake.runtime(0);
  await fake.runtime(1);
  stageCanonicalSession('abc-123');
  stageCanonicalSession('xyz-456');

  // PI cancels the switch (an in-flight agent was preempted).
  runtime1.switchResult = { cancelled: true };
  const result = await adapter.switchSession('xyz-456', 'k1');

  assert.equal(switchCalls(runtime1).length, 1, 'the switch was attempted');
  assert.deepEqual(result, { ok: false, cancelled: true });

  adapter.kill('k1');
  adapter.kill('k2');
});

test('G-6: sendTurn no-op when same session; auto-switches before the prompt when different', async () => {
  const fake = makeFakeRuntimeFactory({ sessionIds: ['abc-123', 'xyz-456'] });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const proc1 = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });
  adapter.spawn({ sessionId: null, sessionKey: 'k2', resume: false });
  const runtime1 = await fake.runtime(0);
  await fake.runtime(1);
  stageCanonicalSession('abc-123');
  stageCanonicalSession('xyz-456');

  // --- no-op path: send to same session ---
  // proc1.send routes through sendTurn(abc-123, path, msg); currentSessionId=abc-123 → no switch.
  proc1.send({ text: 'hello' }).catch(() => {/* superseded below; rejection expected */});
  await awaitPrompts(runtime1, 1);

  assert.deepEqual(switchCalls(runtime1), [], 'no switch before the first prompt');
  assert.deepEqual(runtime1.prompts(), ['hello']);

  // --- auto-switch path: divert k1 to xyz-456, then send ---
  const divert = await adapter.switchSession('xyz-456', 'k1');
  assert.deepEqual(divert, { ok: true, cancelled: false });
  // k1 currentSessionId is now xyz-456; spawn closure target is abc-123 → will auto-switch back.

  proc1.send({ text: 'auto-switch test' }).catch(() => {/* never settled; rejection expected */});
  await awaitPrompts(runtime1, 2);

  const switches = switchCalls(runtime1);
  assert.equal(switches.length, 2, 'divert plus switch-back');
  assert.equal(switches[1], pathJoin(G_SESSION_DIR, 'abc-123.jsonl'), 'switches back to original session');
  assert.deepEqual(runtime1.prompts(), ['hello', 'auto-switch test'], 'prompt written after switch-back');

  // Verify order: the switch-back precedes the final prompt.
  const switchBackIdx = runtime1.calls.findIndex(
    (call, index) => index > 0 && call.kind === 'switch' && call.path.endsWith('abc-123.jsonl'),
  );
  const lastPromptIdx = runtime1.calls.length - 1;
  assert.equal(runtime1.calls[lastPromptIdx]?.kind, 'prompt');
  assert.ok(switchBackIdx !== -1 && switchBackIdx < lastPromptIdx, 'switch precedes prompt');

  adapter.kill('k1');
  adapter.kill('k2');
});

test('G-6b: internal switch-back refreshes a synthesized registry path from disk', async () => {
  const sessionA = `refresh-a-${Date.now()}`;
  const sessionB = `refresh-b-${Date.now()}`;
  const fake = makeFakeRuntimeFactory({ sessionIds: [sessionA, sessionB] });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const proc1 = adapter.spawn({ sessionId: null, sessionKey: 'refresh-k1', resume: false });
  adapter.spawn({ sessionId: null, sessionKey: 'refresh-k2', resume: false });
  const runtime1 = await fake.runtime(0);
  await fake.runtime(1);
  // The session registered <dir>/<sessionA>.jsonl, which never appears; PI wrote this name instead.
  const timestampedA = pathJoin(G_SESSION_DIR, `2026-08-01T00-00-00Z_${sessionA}.jsonl`);
  writeFileSync(timestampedA, '{}\n');
  stageCanonicalSession(sessionB);

  const divert = await adapter.switchSession(sessionB, 'refresh-k1');
  assert.deepEqual(divert, { ok: true, cancelled: false });

  proc1.send({ text: 'return to A' }).catch(() => undefined);
  await awaitPrompts(runtime1, 1);

  const switches = switchCalls(runtime1);
  assert.equal(switches[switches.length - 1], timestampedA);

  adapter.kill('refresh-k1');
  adapter.kill('refresh-k2');
});

test('compact waits for the runtime, compacts once, then returns post-compact stats', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fake = makeFakeRuntimeFactory({
    gate,
    compact: {
      summary: 'short summary', firstKeptEntryId: 'e1',
      tokensBefore: 120000, estimatedTokensAfter: 18000,
      usage: {
        input: 120000, output: 900, cacheRead: 10, cacheWrite: 20, totalTokens: 120930,
        cost: { input: 0.4, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.42 },
      },
    },
    stats: { contextUsage: { tokens: 19000, contextWindow: 200000, percent: 9.5 } },
  });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'compact-ok', resume: false });

  const compactPromise = proc.compact!();
  await tick();
  assert.equal(fake.runtimes.length, 0, 'compact waits for the runtime instead of failing');

  release();
  const runtime = await fake.runtime();

  assert.deepEqual(await compactPromise, {
    status: 'compacted',
    tokensBefore: 120000,
    estimatedTokensAfter: 18000,
    contextUsage: { usedTokens: 19000, contextWindow: 200000, percent: 9.5, accuracy: 'estimate' },
    usage: { inputTokens: 120000, outputTokens: 900, cacheReadTokens: 10, cacheWriteTokens: 20, costUsd: 0.42 },
  });
  assert.equal(runtime.calls.filter((call) => call.kind === 'compact').length, 1);

  proc.kill();
});

test('compact maps a PI no-history rejection to not-needed', async () => {
  const fake = makeFakeRuntimeFactory({
    compact: new Error('No messages to compact'),
    stats: { contextUsage: { tokens: 19000, contextWindow: 200000, percent: 9.5 } },
  });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'compact-empty', resume: false });

  assert.deepEqual(await proc.compact!(), {
    status: 'not-needed', tokensBefore: null, estimatedTokensAfter: null,
    contextUsage: null, usage: null,
  });

  proc.kill();
});

test('compact rejects any other PI compaction failure', async () => {
  const fake = makeFakeRuntimeFactory({ compact: new Error('compaction exploded') });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'compact-failed', resume: false });

  await assert.rejects(proc.compact!(), /compaction exploded/);

  proc.kill();
});

test('compact rejects promptly when the session is killed while its runtime is still starting', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fake = makeFakeRuntimeFactory({ gate });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'compact-exit', resume: false });

  const compactPromise = proc.compact!();
  proc.kill();
  release();

  await assert.rejects(compactPromise, /closed while starting/i);
  const runtime = await fake.runtime();
  await tick();
  assert.equal(runtime.disposed, true, 'a runtime that arrives after kill is released');
});

test('G-7: a session whose transcript never reached disk is not resumed through a synthesized path', async () => {
  const fake = makeFakeRuntimeFactory({ sessionId: 'known-id' });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);

  // First spawn registers the session path the runtime reports.
  const proc1 = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });
  await fake.runtime();
  await proc1.close();
  await adapter.close('k1');

  assert.equal(adapter.resolveSessionPath('known-id'), null);

  adapter.spawn({ sessionId: 'known-id', sessionKey: 'k2', resume: true });
  assert.equal(fake.requests[1].sessionPath, null, 'nonexistent synthesized path is not handed to PI');

  adapter.kill('k2');
});

test('G-7b: a registered transcript deleted before resume is evicted and starts fresh', async () => {
  const sessionId = `deleted-${Date.now()}`;
  const fake = makeFakeRuntimeFactory({ sessionId });
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'delete-source', resume: false });
  const sessionPath = stageCanonicalSession(sessionId);
  await fake.runtime();
  assert.equal(adapter.resolveSessionPath(sessionId), sessionPath);
  rmSync(sessionPath, { force: true });
  await proc.close();
  await adapter.close('delete-source');

  adapter.spawn({ sessionId, sessionKey: 'delete-resume', resume: true });
  assert.equal(fake.requests[1].sessionPath, null, 'deleted registry target is not resumed');

  adapter.kill('delete-resume');
});

test('G-8: spawn with resume=true but UNKNOWN sessionId resumes no transcript (starts fresh)', () => {
  const fake = makeFakeRuntimeFactory();
  const adapter = new PIAdapter(fake.factory, G_SESSION_DIR);

  // PI can only RESUME an existing session (unlike Claude it cannot create one under an external
  // id). When the id is unknown — not announced in this adapter instance and no matching file in
  // the session dir — the guard passes no transcript so PI opens a fresh session instead of
  // failing with "No session found matching <id>". (Regression: web/pi sessions minted a Cortex
  // UUID and forced resume, which PI rejected.)
  adapter.spawn({ sessionId: 'unknown-id', sessionKey: 'kR', resume: true });

  assert.equal(fake.requests[0].sessionPath, null, 'no transcript for an unknown resume target');

  adapter.kill('kR');
});

test('G-9: disk resume recognizes the exact timestamp-prefixed session filename', () => {
  const sessionDir = pathJoin(tmpdir(), `pi-resume-name-${process.pid}-${Date.now()}`);
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = '01234567-89ab-7cde-8fab-0123456789ab';
  const sessionPath = pathJoin(sessionDir, `2026-08-01T01-02-03Z_${sessionId}.jsonl`);
  writeFileSync(sessionPath, 'not-json');

  try {
    const fake = makeFakeRuntimeFactory();
    const adapter = new PIAdapter(fake.factory, sessionDir);
    adapter.spawn({ sessionId, sessionKey: 'k-name', resume: true });

    assert.equal(fake.requests[0].sessionPath, sessionPath);
    adapter.kill('k-name');
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('G-9b: a restored transcript registration overrides a canonical duplicate on the next spawn', () => {
  const sessionDir = pathJoin(tmpdir(), `pi-restored-resume-${process.pid}-${Date.now()}`);
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = 'restored-session-id';
  const restoredPath = pathJoin(sessionDir, `2026-08-01T01-02-03Z_${sessionId}.jsonl`);
  const canonicalPath = pathJoin(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(restoredPath, 'restored-context');
  writeFileSync(canonicalPath, 'selector-preferred-context');

  try {
    const fake = makeFakeRuntimeFactory();
    const adapter = new PIAdapter(fake.factory, sessionDir);
    adapter.registerSessionPath(sessionId, restoredPath);

    adapter.spawn({ sessionId, sessionKey: 'k-restored', resume: true });

    assert.equal(fake.requests[0].sessionPath, restoredPath);
    assert.equal(readFileSync(restoredPath, 'utf8'), 'restored-context');
    assert.equal(readFileSync(canonicalPath, 'utf8'), 'selector-preferred-context');
    adapter.kill('k-restored');
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('G-10: disk resume does not discover an id only by reading an unrelated header', () => {
  const sessionDir = pathJoin(tmpdir(), `pi-resume-header-${process.pid}-${Date.now()}`);
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = 'header-only-session';
  writeFileSync(pathJoin(sessionDir, 'unrelated-name.jsonl'), JSON.stringify({ type: 'session', id: sessionId }) + '\n');

  try {
    const fake = makeFakeRuntimeFactory();
    const adapter = new PIAdapter(fake.factory, sessionDir);
    adapter.spawn({ sessionId, sessionKey: 'k-header', resume: true });

    assert.equal(fake.requests[0].sessionPath, null, 'resume discovery must not open unrelated bodies');
    adapter.kill('k-header');
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
