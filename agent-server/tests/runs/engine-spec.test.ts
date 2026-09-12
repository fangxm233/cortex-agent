// input:  EngineSpec builder/bridge, matrix of run options
// output: frozen round-trip equality plus engineIdentity properties
// pos:    P2.1a engine-spec seam regression — proves the bridge is byte-shape identical
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import {
  buildEngineSpec, engineIdentity, specToSpawnConfig,
} from '../../src/domain/runs/engine-spec.js';
import { buildAgentSpawnConfig } from '../../src/domain/agents/spawn-config.js';
import type { RunAgentOptions, AgentConfig } from '../../src/domain/agents/spawn-config.js';
import type { ModeEnv } from '../../src/domain/agents/config.js';
import type { AgentSpawnConfig, EngineSpec } from '../../src/agent-adapter/types.js';
import { DATA_DIR, CONFIG_DIR } from '../../src/core/paths.js';
import { resetSettingsForTests } from '../../src/core/settings.js';

// GOLDEN PROVENANCE: every `expected` below was printed from `buildAgentSpawnConfig` on the
// pre-refactor `refactor/runs` base, in this exact test home (no rules dir, default settings).
// `assert.deepStrictEqual` distinguishes a present-but-`undefined` key from an absent one, so the
// literals list every key the old builder spread — including `undefined` ones.
const FIXTURE_CONFIG: AgentConfig = { model: 'claude-fixture', backend: 'claude', mode: null };

interface Case {
  name: string;
  options: RunAgentOptions;
  config: AgentConfig;
  route: ModeEnv | undefined;
  expected: AgentSpawnConfig;
}

const DIRECT_OPTIONS: RunAgentOptions = {
  channel: 'general',
  sessionKey: 'direct-fixture',
  sessionId: '11111111-1111-4111-8111-111111111111',
  profileName: 'fixture-profile',
  trackSessionId: 'tracked-direct',
  executionId: 'exec-direct',
};

const cases: Case[] = [
  {
    name: 'direct Claude conversation',
    options: DIRECT_OPTIONS,
    config: FIXTURE_CONFIG,
    route: undefined,
    expected: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      sessionKey: 'direct-fixture',
      resume: true,
      model: 'claude-fixture',
      systemPrompt: undefined,
      outputStyle: undefined,
      cwd: undefined,
      mcpComposition: 'direct',
      mcpConfigPaths: undefined,
      mcpToolAllowlist: undefined,
      commissionTools: undefined,
      disableHooks: undefined,
      streamDeltas: undefined,
      captureTranscriptLogs: undefined,
      preserveUnreportedAccounting: undefined,
      processSpawner: undefined,
      cliPath: undefined,
      pinnedEnv: undefined,
      pluginDirs: undefined,
      pluginSkillDirs: undefined,
      mcpServers: undefined,
      pluginCapabilityFingerprint: undefined,
      env: undefined,
      unsetEnv: undefined,
      extraOption: undefined,
      claudeBackend: undefined,
      thinking: undefined,
      channel: 'general',
      claudeAgent: undefined,
      callbackSource: undefined,
      scheduleTaskId: undefined,
      isUserInitiated: false,
      rawTools: undefined,
      anthropicBaseUrl: undefined,
      browserCdpEndpoint: undefined,
      piProvider: undefined,
      piModelMaxTokens: undefined,
      piGatewayPath: undefined,
      piGatewayBaseUrl: undefined,
      cortexContext: {
        threadId: null,
        profile: 'fixture-profile',
        project: null,
        sessionName: null,
        trackSessionId: 'tracked-direct',
        executionId: 'exec-direct',
        useCoreMcp: undefined,
        threadDepth: null,
        taskId: null,
        taskProject: null,
        taskGeneration: null,
      },
      appendSystemPrompt: undefined,
    },
  },
  {
    name: 'thread Claude with cortexContext and thread MCP composition',
    options: {
      channel: 'thread-fixture',
      sessionKey: 'thread-fixture:1',
      sessionId: '22222222-2222-4222-8222-222222222222',
      profileName: 'fixture-profile',
      trackSessionId: 'tracked-thread',
      executionId: 'exec-thread',
      threadId: 'thr_fixture',
      sessionName: 'cortex-fixture',
      useCoreMcp: true,
      threadDepth: 1,
      taskId: 'abcd',
      taskProject: 'atlas',
      taskGeneration: 'generation-b',
    },
    config: FIXTURE_CONFIG,
    route: undefined,
    expected: {
      sessionId: '22222222-2222-4222-8222-222222222222',
      sessionKey: 'thread-fixture:1',
      resume: true,
      model: 'claude-fixture',
      systemPrompt: undefined,
      outputStyle: undefined,
      cwd: undefined,
      mcpComposition: 'thread-control',
      mcpConfigPaths: undefined,
      mcpToolAllowlist: undefined,
      commissionTools: undefined,
      disableHooks: undefined,
      streamDeltas: undefined,
      captureTranscriptLogs: undefined,
      preserveUnreportedAccounting: undefined,
      processSpawner: undefined,
      cliPath: undefined,
      pinnedEnv: undefined,
      pluginDirs: undefined,
      pluginSkillDirs: undefined,
      mcpServers: undefined,
      pluginCapabilityFingerprint: undefined,
      env: undefined,
      unsetEnv: undefined,
      extraOption: undefined,
      claudeBackend: undefined,
      thinking: undefined,
      channel: 'thread-fixture',
      claudeAgent: undefined,
      callbackSource: undefined,
      scheduleTaskId: undefined,
      isUserInitiated: false,
      rawTools: undefined,
      anthropicBaseUrl: undefined,
      browserCdpEndpoint: undefined,
      piProvider: undefined,
      piModelMaxTokens: undefined,
      piGatewayPath: undefined,
      piGatewayBaseUrl: undefined,
      cortexContext: {
        threadId: 'thr_fixture',
        profile: 'fixture-profile',
        project: null,
        sessionName: 'cortex-fixture',
        trackSessionId: 'tracked-thread',
        executionId: 'exec-thread',
        useCoreMcp: true,
        threadDepth: 1,
        taskId: 'abcd',
        taskProject: 'atlas',
        taskGeneration: 'generation-b',
      },
      appendSystemPrompt: undefined,
    },
  },
  {
    name: 'PI with provider, gateway and maxOutputTokens',
    options: {
      channel: 'pi-channel',
      sessionKey: 'pi-fixture',
      sessionId: '33333333-3333-4333-8333-333333333333',
      profileName: 'pi-profile',
      trackSessionId: 'tracked-pi',
      executionId: 'exec-pi',
    },
    config: {
      model: 'pi-model', backend: 'pi', mode: 'pi-mode', provider: 'deepseek',
      maxOutputTokens: 4096, thinking: 'high', claudeBackend: 'print',
    },
    route: undefined,
    expected: {
      sessionId: '33333333-3333-4333-8333-333333333333',
      sessionKey: 'pi-fixture',
      resume: true,
      model: 'pi-model',
      systemPrompt: undefined,
      outputStyle: undefined,
      cwd: undefined,
      mcpComposition: 'direct',
      mcpConfigPaths: undefined,
      mcpToolAllowlist: undefined,
      commissionTools: undefined,
      disableHooks: undefined,
      streamDeltas: undefined,
      captureTranscriptLogs: undefined,
      preserveUnreportedAccounting: undefined,
      processSpawner: undefined,
      cliPath: undefined,
      pinnedEnv: undefined,
      pluginDirs: undefined,
      pluginSkillDirs: undefined,
      mcpServers: undefined,
      pluginCapabilityFingerprint: undefined,
      env: undefined,
      unsetEnv: undefined,
      extraOption: undefined,
      claudeBackend: 'print',
      thinking: 'high',
      channel: 'pi-channel',
      claudeAgent: undefined,
      callbackSource: undefined,
      scheduleTaskId: undefined,
      isUserInitiated: false,
      rawTools: undefined,
      anthropicBaseUrl: undefined,
      browserCdpEndpoint: undefined,
      piProvider: 'deepseek',
      piModelMaxTokens: 4096,
      piGatewayPath: '/m/pi-mode/deepseek',
      piGatewayBaseUrl: 'http://127.0.0.1:9880',
      cortexContext: {
        threadId: null,
        profile: 'pi-profile',
        project: null,
        sessionName: null,
        trackSessionId: 'tracked-pi',
        executionId: 'exec-pi',
        useCoreMcp: undefined,
        threadDepth: null,
        taskId: null,
        taskProject: null,
        taskGeneration: null,
      },
      appendSystemPrompt: undefined,
    },
  },
  {
    name: 'frozen subagent role (no ambient rules, pinned env, hooks off)',
    options: {
      channel: 'subagent-channel',
      sessionKey: 'subagent-fixture',
      sessionId: '44444444-4444-4444-8444-444444444444',
      trackSessionId: 'tracked-subagent',
      executionId: 'exec-subagent',
      loadCortexRules: false,
      appendSystemPrompt: 'You are a frozen role.\nDo only the assigned work.',
      systemPrompt: 'Frozen system prompt',
      mcpConfigPaths: ['/fixture/mcp-empty.json'],
      pinnedEnv: { PATH: '/usr/bin:/bin', HOME: '/fixture/home', LANG: 'C' },
      disableHooks: true,
      streamDeltas: false,
      captureTranscriptLogs: false,
      preserveUnreportedAccounting: true,
      cliPath: '/fixture/bin/claude',
    },
    config: FIXTURE_CONFIG,
    route: undefined,
    expected: {
      sessionId: '44444444-4444-4444-8444-444444444444',
      sessionKey: 'subagent-fixture',
      resume: true,
      model: 'claude-fixture',
      systemPrompt: 'Frozen system prompt',
      outputStyle: undefined,
      cwd: undefined,
      mcpComposition: 'direct',
      mcpConfigPaths: ['/fixture/mcp-empty.json'],
      mcpToolAllowlist: undefined,
      commissionTools: undefined,
      disableHooks: true,
      streamDeltas: false,
      captureTranscriptLogs: false,
      preserveUnreportedAccounting: true,
      processSpawner: undefined,
      cliPath: '/fixture/bin/claude',
      pinnedEnv: { PATH: '/usr/bin:/bin', HOME: '/fixture/home', LANG: 'C' },
      pluginDirs: undefined,
      pluginSkillDirs: undefined,
      mcpServers: undefined,
      pluginCapabilityFingerprint: undefined,
      env: undefined,
      unsetEnv: undefined,
      extraOption: undefined,
      claudeBackend: undefined,
      thinking: undefined,
      channel: 'subagent-channel',
      claudeAgent: undefined,
      callbackSource: undefined,
      scheduleTaskId: undefined,
      isUserInitiated: false,
      rawTools: undefined,
      anthropicBaseUrl: undefined,
      browserCdpEndpoint: undefined,
      piProvider: undefined,
      piModelMaxTokens: undefined,
      piGatewayPath: undefined,
      piGatewayBaseUrl: undefined,
      cortexContext: {
        threadId: null,
        profile: null,
        project: null,
        sessionName: null,
        trackSessionId: 'tracked-subagent',
        executionId: 'exec-subagent',
        useCoreMcp: undefined,
        threadDepth: null,
        taskId: null,
        taskProject: null,
        taskGeneration: null,
      },
      appendSystemPrompt: 'You are a frozen role.\nDo only the assigned work.',
    },
  },
  {
    name: 'browser plus commission session with a mode route',
    options: {
      channel: 'web:browser-fixture',
      sessionKey: 'web:browser-fixture',
      sessionId: '55555555-5555-4555-8555-555555555555',
      profileName: 'web-profile',
      trackSessionId: 'tracked-browser',
      executionId: 'exec-browser',
      browserCdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc',
      commissionMode: true,
      commissionTools: true,
      isUserInitiated: true,
      callbackSource: 'web',
      scheduleTaskId: 'sched-1',
      claudeAgent: 'my-agent',
      outputStyle: 'concise',
    },
    config: {
      ...FIXTURE_CONFIG, mode: 'plan', claudeBackend: 'print', thinking: 'medium',
      extraOption: { foo: 'bar' }, extraEnv: { EXTRA_ONE: '1' },
    },
    route: {
      ANTHROPIC_API_KEY: 'sk-route-fixture',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9880/m/plan/anthropic',
      CLAUDE_CODE_OAUTH_TOKEN: null,
    },
    expected: {
      sessionId: '55555555-5555-4555-8555-555555555555',
      sessionKey: 'web:browser-fixture',
      resume: true,
      model: 'claude-fixture',
      systemPrompt: undefined,
      outputStyle: 'concise',
      cwd: undefined,
      mcpComposition: 'direct',
      mcpConfigPaths: undefined,
      mcpToolAllowlist: undefined,
      commissionTools: true,
      disableHooks: undefined,
      streamDeltas: undefined,
      captureTranscriptLogs: undefined,
      preserveUnreportedAccounting: undefined,
      processSpawner: undefined,
      cliPath: undefined,
      pinnedEnv: undefined,
      pluginDirs: undefined,
      pluginSkillDirs: undefined,
      mcpServers: undefined,
      pluginCapabilityFingerprint: undefined,
      env: { ANTHROPIC_API_KEY: 'sk-route-fixture', EXTRA_ONE: '1' },
      unsetEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
      extraOption: { foo: 'bar' },
      claudeBackend: 'print',
      thinking: 'medium',
      channel: 'web:browser-fixture',
      claudeAgent: 'my-agent',
      callbackSource: 'web',
      scheduleTaskId: 'sched-1',
      isUserInitiated: true,
      rawTools: undefined,
      anthropicBaseUrl: 'http://127.0.0.1:9880/m/plan/anthropic',
      browserCdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc',
      piProvider: undefined,
      piModelMaxTokens: undefined,
      piGatewayPath: undefined,
      piGatewayBaseUrl: undefined,
      cortexContext: {
        threadId: null,
        profile: 'web-profile',
        project: null,
        sessionName: null,
        trackSessionId: 'tracked-browser',
        executionId: 'exec-browser',
        useCoreMcp: undefined,
        threadDepth: null,
        taskId: null,
        taskProject: null,
        taskGeneration: null,
      },
      appendSystemPrompt: undefined,
    },
  },
];

beforeAll(() => {
  rmSync(path.join(DATA_DIR, 'rules'), { recursive: true, force: true });
  rmSync(path.join(CONFIG_DIR, 'settings.json'), { force: true });
  resetSettingsForTests();
});

function roundTrip(c: Case): AgentSpawnConfig {
  return specToSpawnConfig(buildEngineSpec(c.options, c.config, c.route));
}

for (const c of cases) {
  test(`specToSpawnConfig(buildEngineSpec(...)) round-trips exactly: ${c.name}`, () => {
    assert.deepStrictEqual(roundTrip(c), c.expected);
  });
}

test('buildAgentSpawnConfig delegates through the EngineSpec bridge', () => {
  for (const c of cases) {
    assert.deepStrictEqual(
      buildAgentSpawnConfig(c.options, c.config, c.route),
      c.expected,
    );
  }
});

test('the bridge keeps rawTools and never synthesizes the canonical tools key the legacy builder omitted', () => {
  const raw = specToSpawnConfig(buildEngineSpec(
    { ...DIRECT_OPTIONS, tools: 'Read,Bash' }, FIXTURE_CONFIG, undefined,
  ));
  assert.equal(raw.rawTools, 'Read,Bash');
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'tools'), false);

  const canonicalOptions = { ...DIRECT_OPTIONS, tools: ['Read', 'Bash'] };
  const canonical = specToSpawnConfig(buildEngineSpec(canonicalOptions, FIXTURE_CONFIG, undefined));
  assert.equal(canonical.rawTools, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(canonical, 'tools'), false);
  // The EngineSpec still carries the canonical list for the P2.1b/c readers.
  assert.deepEqual(buildEngineSpec(canonicalOptions, FIXTURE_CONFIG, undefined).tools.canonical, ['Read', 'Bash']);
});

// --- engineIdentity ---

function baseSpec(): EngineSpec {
  return buildEngineSpec(DIRECT_OPTIONS, FIXTURE_CONFIG, undefined);
}

test('engineIdentity is independent of object key order', () => {
  const base = baseSpec();
  const reordered: EngineSpec = {
    process: { cliPath: base.process.cliPath, spawner: base.process.spawner },
    backend: { ...base.backend },
    extraOption: base.extraOption,
    context: { scheduleTaskId: base.context.scheduleTaskId, callbackSource: base.context.callbackSource, channel: base.context.channel },
    flags: { isUserInitiated: base.flags.isUserInitiated, preserveUnreportedAccounting: base.flags.preserveUnreportedAccounting, captureTranscripts: base.flags.captureTranscripts, streamDeltas: base.flags.streamDeltas, disableHooks: base.flags.disableHooks },
    route: { gatewayPath: base.route.gatewayPath, gatewayBaseUrl: base.route.gatewayBaseUrl, anthropicBaseUrl: base.route.anthropicBaseUrl },
    env: { context: base.env.context ? {
      taskGeneration: base.env.context.taskGeneration, taskProject: base.env.context.taskProject,
      taskId: base.env.context.taskId, threadDepth: base.env.context.threadDepth,
      useCoreMcp: base.env.context.useCoreMcp, executionId: base.env.context.executionId,
      trackSessionId: base.env.context.trackSessionId, sessionName: base.env.context.sessionName,
      project: base.env.context.project, profile: base.env.context.profile, threadId: base.env.context.threadId,
    } : undefined, pinned: base.env.pinned, unsets: base.env.unsets, sets: base.env.sets },
    mcp: { browserCdpEndpoint: base.mcp.browserCdpEndpoint, commissionTools: base.mcp.commissionTools, configPaths: base.mcp.configPaths, allowlist: base.mcp.allowlist, servers: base.mcp.servers, composition: base.mcp.composition },
    plugins: { fingerprint: base.plugins.fingerprint, skillDirs: base.plugins.skillDirs, dirs: base.plugins.dirs },
    tools: { rawClaude: base.tools.rawClaude, canonical: base.tools.canonical },
    prompt: { append: base.prompt.append, system: base.prompt.system },
    model: { maxOutputTokens: base.model.maxOutputTokens, thinking: base.model.thinking, provider: base.model.provider, id: base.model.id },
    resume: { resume: base.resume.resume, backendSessionId: base.resume.backendSessionId },
    cwd: base.cwd,
    engineKey: base.engineKey,
  };
  assert.equal(engineIdentity(base), engineIdentity(reordered));
});

test('engineIdentity ignores resume, env.context.executionId and process.spawner', () => {
  const base = baseSpec();
  const mutated = structuredClone(base);
  mutated.resume = { backendSessionId: 'other-session', resume: false };
  mutated.env.context = { ...mutated.env.context, executionId: 'other-execution' };
  mutated.process.spawner = (() => ({ process: null as never })) as never;
  assert.equal(engineIdentity(base), engineIdentity(mutated));
});

test('engineIdentity changes when model, tools, env.sets or plugins.dirs change', () => {
  const base = baseSpec();
  assert.notEqual(
    engineIdentity(base),
    engineIdentity({ ...base, model: { ...base.model, id: 'other-model' } }),
  );
  assert.notEqual(
    engineIdentity(base),
    engineIdentity({ ...base, tools: { ...base.tools, rawClaude: 'Bash,Read' } }),
  );
  assert.notEqual(
    engineIdentity(base),
    engineIdentity({ ...base, env: { ...base.env, sets: { FOO: '1' } } }),
  );
  assert.notEqual(
    engineIdentity(base),
    engineIdentity({ ...base, plugins: { ...base.plugins, dirs: ['/plugins/x'] } }),
  );
});
