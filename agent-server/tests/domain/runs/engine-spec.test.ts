import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import { specFromFixture, type RunRequestFixtureInput } from '../../run-request-fixture.js';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import type { ModeEnv } from '../../../src/domain/runs/mode-env.js';
import type { EngineSpec } from '../../../src/agent-adapter/types.js';
import { DATA_DIR, CONFIG_DIR } from '../../../src/core/paths.js';
import { resetSettingsForTests } from '../../../src/core/settings.js';

// GOLDEN PROVENANCE: every `expected` below was printed from the pre-refactor production spawn
// path on the `refactor/runs` base, in this exact test home (no rules dir, default settings), and
// converted one-for-one into the EngineSpec shape. `assert.deepStrictEqual` distinguishes a
// present-but-`undefined` key from an absent one, so the literals list every key the builder emits.
// `backend.claudeBackend` was removed with the retired TUI runtime. The execution context now
// additionally carries the selected attempt so both backends can populate MCP selection identity.
const FIXTURE_CONFIG: Partial<EngineSelection> = { model: 'claude-fixture', backend: 'claude', mode: 'plan' };

interface Case {
  name: string;
  options: RunRequestFixtureInput;
  config: Partial<EngineSelection>;
  route: ModeEnv | undefined;
  expected: EngineSpec;
}

const DIRECT_OPTIONS: RunRequestFixtureInput = {
  channel: 'general',
  sessionKey: 'direct-fixture',
  sessionId: '11111111-1111-4111-8111-111111111111',
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
      model: { id: 'claude-fixture', provider: undefined, thinking: undefined, benchmarkMaxOutputTokens: undefined },
      prompt: { system: undefined, append: undefined },
      tools: { canonical: undefined, rawClaude: undefined },
      plugins: { dirs: undefined, skillDirs: undefined, fingerprint: undefined },
      mcp: { composition: 'direct', servers: undefined, allowlist: undefined, configPaths: undefined },
      env: {
        sets: undefined, unsets: undefined, pinned: undefined,
        context: {
          project: null,
          trackSessionId: 'tracked-direct',
          executionId: 'exec-direct',
          selection: { backend: 'claude', provider: null, model: 'claude-fixture', thinking: null, mode: 'plan' },
        },
      },
      route: { anthropicBaseUrl: undefined, gatewayBaseUrl: undefined, gatewayPath: undefined },
      flags: {
        disableHooks: undefined, disableSkills: undefined, settingSources: undefined,
        streamDeltas: undefined, captureTranscripts: undefined,
        isUserInitiated: false,
      },
      context: { channel: 'general', callbackSource: undefined, scheduleTaskId: undefined },
      backend: { kind: 'claude', claudeAgent: undefined, outputStyle: undefined },
      process: { spawner: undefined, cliPath: undefined },
    },
  },
  {
    name: 'PI with selected provider and gateway',
    options: {
      channel: 'pi-channel',
      sessionKey: 'pi-fixture',
      sessionId: '33333333-3333-4333-8333-333333333333',
      trackSessionId: 'tracked-pi',
      executionId: 'exec-pi',
    },
    config: {
      model: 'pi-model', backend: 'pi', mode: 'pi-mode', provider: 'deepseek',
      thinking: 'high',
    },
    route: undefined,
    expected: {
      engineKey: 'pi-fixture',
      cwd: undefined,
      resume: { backendSessionId: '33333333-3333-4333-8333-333333333333', resume: true },
      model: { id: 'pi-model', provider: 'deepseek', thinking: 'high', benchmarkMaxOutputTokens: undefined },
      prompt: { system: undefined, append: undefined },
      tools: { canonical: undefined, rawClaude: undefined },
      plugins: { dirs: undefined, skillDirs: undefined, fingerprint: undefined },
      mcp: { composition: 'direct', servers: undefined, allowlist: undefined, configPaths: undefined },
      env: {
        sets: undefined, unsets: undefined, pinned: undefined,
        context: {
          project: null,
          trackSessionId: 'tracked-pi',
          executionId: 'exec-pi',
          selection: { backend: 'pi', provider: 'deepseek', model: 'pi-model', thinking: 'high', mode: 'pi-mode' },
        },
      },
      route: { anthropicBaseUrl: undefined, gatewayBaseUrl: 'http://127.0.0.1:9880', gatewayPath: '/m/pi-mode/deepseek' },
      flags: {
        disableHooks: undefined, disableSkills: undefined, settingSources: undefined,
        streamDeltas: undefined, captureTranscripts: undefined,
        isUserInitiated: false,
      },
      context: { channel: 'pi-channel', callbackSource: undefined, scheduleTaskId: undefined },
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
      cliPath: '/fixture/bin/claude',
    },
    config: FIXTURE_CONFIG,
    route: undefined,
    expected: {
      engineKey: 'subagent-fixture',
      cwd: undefined,
      resume: { backendSessionId: '44444444-4444-4444-8444-444444444444', resume: true },
      model: { id: 'claude-fixture', provider: undefined, thinking: undefined, benchmarkMaxOutputTokens: undefined },
      prompt: { system: 'Frozen system prompt', append: 'You are a frozen role.\nDo only the assigned work.' },
      tools: { canonical: undefined, rawClaude: undefined },
      plugins: { dirs: undefined, skillDirs: undefined, fingerprint: undefined },
      mcp: {
        composition: 'direct', servers: undefined, allowlist: undefined,
        configPaths: ['/fixture/mcp-empty.json'],
      },
      env: {
        sets: undefined, unsets: undefined,
        pinned: { PATH: '/usr/bin:/bin', HOME: '/fixture/home', LANG: 'C' },
        context: {
          project: null,
          trackSessionId: 'tracked-subagent',
          executionId: 'exec-subagent',
          selection: { backend: 'claude', provider: null, model: 'claude-fixture', thinking: null, mode: 'plan' },
        },
      },
      route: { anthropicBaseUrl: undefined, gatewayBaseUrl: undefined, gatewayPath: undefined },
      flags: {
        disableHooks: true, disableSkills: undefined, settingSources: undefined,
        streamDeltas: false, captureTranscripts: false,
        isUserInitiated: false,
      },
      context: { channel: 'subagent-channel', callbackSource: undefined, scheduleTaskId: undefined },
      backend: { kind: 'claude', claudeAgent: undefined, outputStyle: undefined },
      process: { spawner: undefined, cliPath: '/fixture/bin/claude' },
    },
  },
  {
    name: 'web session with a mode route',
    options: {
      channel: 'web:route-fixture',
      sessionKey: 'web:route-fixture',
      sessionId: '55555555-5555-4555-8555-555555555555',
      trackSessionId: 'tracked-route',
      executionId: 'exec-route',
      isUserInitiated: true,
      callbackSource: 'web',
      scheduleTaskId: 'sched-1',
      claudeAgent: 'my-agent',
      outputStyle: 'concise',
    },
    config: {
      ...FIXTURE_CONFIG, mode: 'plan', thinking: 'medium',
    },
    route: {
      ANTHROPIC_API_KEY: 'sk-route-fixture',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9880/m/plan/anthropic',
      CLAUDE_CODE_OAUTH_TOKEN: null,
    },
    expected: {
      engineKey: 'web:route-fixture',
      cwd: undefined,
      resume: { backendSessionId: '55555555-5555-4555-8555-555555555555', resume: true },
      model: { id: 'claude-fixture', provider: undefined, thinking: 'medium', benchmarkMaxOutputTokens: undefined },
      prompt: { system: undefined, append: undefined },
      tools: { canonical: undefined, rawClaude: undefined },
      plugins: { dirs: undefined, skillDirs: undefined, fingerprint: undefined },
      mcp: { composition: 'direct', servers: undefined, allowlist: undefined, configPaths: undefined },
      env: {
        sets: { ANTHROPIC_API_KEY: 'sk-route-fixture' },
        unsets: ['CLAUDE_CODE_OAUTH_TOKEN'],
        pinned: undefined,
        context: {
          project: null,
          trackSessionId: 'tracked-route',
          executionId: 'exec-route',
          selection: { backend: 'claude', provider: null, model: 'claude-fixture', thinking: 'medium', mode: 'plan' },
        },
      },
      route: {
        anthropicBaseUrl: 'http://127.0.0.1:9880/m/plan/anthropic',
        gatewayBaseUrl: undefined,
        gatewayPath: undefined,
      },
      flags: {
        disableHooks: undefined, disableSkills: undefined, settingSources: undefined,
        streamDeltas: undefined, captureTranscripts: undefined,
        isUserInitiated: true,
      },
      context: { channel: 'web:route-fixture', callbackSource: 'web', scheduleTaskId: 'sched-1' },
      backend: { kind: 'claude', claudeAgent: 'my-agent', outputStyle: 'concise' },
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
