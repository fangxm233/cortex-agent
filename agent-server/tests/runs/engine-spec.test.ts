import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import { engineIdentity } from '../../src/domain/runs/engine-spec.js';
import { specFromFixture, type RunRequestFixtureInput } from '../run-request-fixture.js';
import type { RunAttemptConfig } from '../../src/domain/agents/profile-manager.js';
import type { ModeEnv } from '../../src/domain/agents/config.js';
import type { EngineSpec } from '../../src/agent-adapter/types.js';
import { DATA_DIR, CONFIG_DIR } from '../../src/core/paths.js';
import { resetSettingsForTests } from '../../src/core/settings.js';

// GOLDEN PROVENANCE: every `expected` below was printed from the pre-refactor production spawn
// path on the `refactor/runs` base, in this exact test home (no rules dir, default settings), and
// converted one-for-one into the EngineSpec shape. `assert.deepStrictEqual` distinguishes a
// present-but-`undefined` key from an absent one, so the literals list every key the builder emits.
//
// AMENDED at the run-model cutover, in two keys only, because a RESOLVED request carries fewer
// undefineds than the old options bag did:
//   - `backend.claudeBackend`: was `undefined` when a config omitted it; a ResolvedProfileConfig
//     always resolves it, so it is now `'print'`. Read only as `=== 'tui'`, so argv is unchanged
//     (the spawn-seam byte goldens still pass untouched).
// Nothing else moved. Any further drift here is a regression, not a restatement.
const FIXTURE_CONFIG: Partial<RunAttemptConfig> = { model: 'claude-fixture', backend: 'claude', mode: null };

interface Case {
  name: string;
  options: RunRequestFixtureInput;
  config: Partial<RunAttemptConfig>;
  route: ModeEnv | undefined;
  expected: EngineSpec;
}

const DIRECT_OPTIONS: RunRequestFixtureInput = {
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
      engineKey: 'direct-fixture',
      cwd: undefined,
      resume: { backendSessionId: '11111111-1111-4111-8111-111111111111', resume: true },
      model: { id: 'claude-fixture', provider: undefined, thinking: undefined, maxOutputTokens: undefined },
      prompt: { system: undefined, append: undefined },
      tools: { canonical: undefined, rawClaude: undefined },
      plugins: { dirs: undefined, skillDirs: undefined, fingerprint: undefined },
      mcp: {
        composition: 'direct', servers: undefined, allowlist: undefined, configPaths: undefined,
        browserCdpEndpoint: undefined,
      },
      env: {
        sets: undefined, unsets: undefined, pinned: undefined,
        context: {
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
      },
      route: { anthropicBaseUrl: undefined, gatewayBaseUrl: undefined, gatewayPath: undefined },
      flags: {
        disableHooks: undefined, streamDeltas: undefined, captureTranscripts: undefined,
        preserveUnreportedAccounting: undefined, isUserInitiated: false,
      },
      context: { channel: 'general', callbackSource: undefined, scheduleTaskId: undefined },
      extraOption: undefined,
      backend: { kind: 'claude', claudeAgent: undefined, outputStyle: undefined, claudeBackend: 'print' },
      process: { spawner: undefined, cliPath: undefined },
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
      engineKey: 'thread-fixture:1',
      cwd: undefined,
      resume: { backendSessionId: '22222222-2222-4222-8222-222222222222', resume: true },
      model: { id: 'claude-fixture', provider: undefined, thinking: undefined, maxOutputTokens: undefined },
      prompt: { system: undefined, append: undefined },
      tools: { canonical: undefined, rawClaude: undefined },
      plugins: { dirs: undefined, skillDirs: undefined, fingerprint: undefined },
      mcp: {
        composition: 'thread-control', servers: undefined, allowlist: undefined,
        configPaths: undefined, browserCdpEndpoint: undefined,
      },
      env: {
        sets: undefined, unsets: undefined, pinned: undefined,
        context: {
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
      },
      route: { anthropicBaseUrl: undefined, gatewayBaseUrl: undefined, gatewayPath: undefined },
      flags: {
        disableHooks: undefined, streamDeltas: undefined, captureTranscripts: undefined,
        preserveUnreportedAccounting: undefined, isUserInitiated: false,
      },
      context: { channel: 'thread-fixture', callbackSource: undefined, scheduleTaskId: undefined },
      extraOption: undefined,
      backend: { kind: 'claude', claudeAgent: undefined, outputStyle: undefined, claudeBackend: 'print' },
      process: { spawner: undefined, cliPath: undefined },
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
      engineKey: 'pi-fixture',
      cwd: undefined,
      resume: { backendSessionId: '33333333-3333-4333-8333-333333333333', resume: true },
      model: { id: 'pi-model', provider: 'deepseek', thinking: 'high', maxOutputTokens: 4096 },
      prompt: { system: undefined, append: undefined },
      tools: { canonical: undefined, rawClaude: undefined },
      plugins: { dirs: undefined, skillDirs: undefined, fingerprint: undefined },
      mcp: {
        composition: 'direct', servers: undefined, allowlist: undefined, configPaths: undefined,
        browserCdpEndpoint: undefined,
      },
      env: {
        sets: undefined, unsets: undefined, pinned: undefined,
        context: {
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
      },
      route: { anthropicBaseUrl: undefined, gatewayBaseUrl: 'http://127.0.0.1:9880', gatewayPath: '/m/pi-mode/deepseek' },
      flags: {
        disableHooks: undefined, streamDeltas: undefined, captureTranscripts: undefined,
        preserveUnreportedAccounting: undefined, isUserInitiated: false,
      },
      context: { channel: 'pi-channel', callbackSource: undefined, scheduleTaskId: undefined },
      extraOption: undefined,
      backend: { kind: 'pi' },
      process: { spawner: undefined, cliPath: undefined },
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
      engineKey: 'subagent-fixture',
      cwd: undefined,
      resume: { backendSessionId: '44444444-4444-4444-8444-444444444444', resume: true },
      model: { id: 'claude-fixture', provider: undefined, thinking: undefined, maxOutputTokens: undefined },
      prompt: { system: 'Frozen system prompt', append: 'You are a frozen role.\nDo only the assigned work.' },
      tools: { canonical: undefined, rawClaude: undefined },
      plugins: { dirs: undefined, skillDirs: undefined, fingerprint: undefined },
      mcp: {
        composition: 'direct', servers: undefined, allowlist: undefined,
        configPaths: ['/fixture/mcp-empty.json'],
        browserCdpEndpoint: undefined,
      },
      env: {
        sets: undefined, unsets: undefined,
        pinned: { PATH: '/usr/bin:/bin', HOME: '/fixture/home', LANG: 'C' },
        context: {
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
      },
      route: { anthropicBaseUrl: undefined, gatewayBaseUrl: undefined, gatewayPath: undefined },
      flags: {
        disableHooks: true, streamDeltas: false, captureTranscripts: false,
        preserveUnreportedAccounting: true, isUserInitiated: false,
      },
      context: { channel: 'subagent-channel', callbackSource: undefined, scheduleTaskId: undefined },
      extraOption: undefined,
      backend: { kind: 'claude', claudeAgent: undefined, outputStyle: undefined, claudeBackend: 'print' },
      process: { spawner: undefined, cliPath: '/fixture/bin/claude' },
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
      engineKey: 'web:browser-fixture',
      cwd: undefined,
      resume: { backendSessionId: '55555555-5555-4555-8555-555555555555', resume: true },
      model: { id: 'claude-fixture', provider: undefined, thinking: 'medium', maxOutputTokens: undefined },
      prompt: { system: undefined, append: undefined },
      tools: { canonical: undefined, rawClaude: undefined },
      plugins: { dirs: undefined, skillDirs: undefined, fingerprint: undefined },
      mcp: {
        composition: 'direct', servers: undefined, allowlist: undefined, configPaths: undefined,
        browserCdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc',
      },
      env: {
        sets: { ANTHROPIC_API_KEY: 'sk-route-fixture', EXTRA_ONE: '1' },
        unsets: ['CLAUDE_CODE_OAUTH_TOKEN'],
        pinned: undefined,
        context: {
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
      },
      route: {
        anthropicBaseUrl: 'http://127.0.0.1:9880/m/plan/anthropic',
        gatewayBaseUrl: undefined,
        gatewayPath: undefined,
      },
      flags: {
        disableHooks: undefined, streamDeltas: undefined, captureTranscripts: undefined,
        preserveUnreportedAccounting: undefined, isUserInitiated: true,
      },
      context: { channel: 'web:browser-fixture', callbackSource: 'web', scheduleTaskId: 'sched-1' },
      extraOption: { foo: 'bar' },
      backend: { kind: 'claude', claudeAgent: 'my-agent', outputStyle: 'concise', claudeBackend: 'print' },
      process: { spawner: undefined, cliPath: undefined },
    },
  },
];

beforeAll(() => {
  rmSync(path.join(DATA_DIR, 'rules'), { recursive: true, force: true });
  rmSync(path.join(CONFIG_DIR, 'settings.json'), { force: true });
  resetSettingsForTests();
});

for (const c of cases) {
  test(`buildEngineSpec emits the captured spec: ${c.name}`, () => {
    assert.deepStrictEqual(specFromFixture(c.options, c.config, c.route), c.expected);
  });
}

test('buildEngineSpec keeps a raw tools string on rawClaude and canonical tools on canonical', () => {
  const raw = specFromFixture({ ...DIRECT_OPTIONS, tools: 'Read,Bash' }, FIXTURE_CONFIG);
  assert.equal(raw.tools.rawClaude, 'Read,Bash');
  assert.equal(raw.tools.canonical, undefined);

  const canonicalOptions = { ...DIRECT_OPTIONS, tools: ['Read', 'Bash'] };
  const canonical = specFromFixture(canonicalOptions, FIXTURE_CONFIG);
  assert.equal(canonical.tools.rawClaude, undefined);
  assert.deepEqual(canonical.tools.canonical, ['Read', 'Bash']);
});

// --- engineIdentity ---

function baseSpec(): EngineSpec {
  return specFromFixture(DIRECT_OPTIONS, FIXTURE_CONFIG);
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
    mcp: { browserCdpEndpoint: base.mcp.browserCdpEndpoint, configPaths: base.mcp.configPaths, allowlist: base.mcp.allowlist, servers: base.mcp.servers, composition: base.mcp.composition },
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
