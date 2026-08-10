// input:  compiled policies, pinned paths and fake spawners
// output: Claude construction, admission and route proofs
// pos:    Trial-adapter factory regression suite
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, it } from 'vitest';
import { LONG_MCP_CALL_VERSION_GOVERNANCE } from '../../../src/agent-adapter/capabilities.js';
import { getAdapter } from '../../../src/agent-adapter/index.js';
import { _test as claudeTest } from '../../../src/agent-adapter/claude/adapter.js';
import { buildHooksSettings } from '../../../src/agent-adapter/claude/hooks-builder.js';
import { buildClaudeEnv, buildSpawnArgs } from '../../../src/agent-adapter/claude/spawn-args.js';
import { MCP_CLEANUP_GRACE_MS } from '../../../src/agent-adapter/pi/mcp-duration.js';
import type { AgentProcess, SpawnedAgentProcess } from '../../../src/agent-adapter/types.js';
import {
  PINNED_RUNTIME_PATH, preparePinnedTrialPaths, pinnedTrialEnvironment,
} from '../../../src/domain/agent-run/pinned-node-process.js';
import {
  loadAgentRunConfigWithPolicy, type ResolvedAgentRunConfig,
} from '../../../src/domain/agent-run/run-config.js';
import {
  createTrialAdapter, type TrialAdapterSpec,
} from '../../../src/domain/benchmark/trial-adapter-factory.js';
import { PolicyCompilationError } from '../../../src/domain/benchmark/resolved-policy.js';
import { profileRepo } from '../../../src/store/profile-repo.js';

const CLI_VERSION = 'fixture-claude/9.9.9';
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-adapter-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeAsset(name: string, content: string, mode?: number): string {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
  return file;
}

function writeProfile(): void {
  const configDir = path.join(process.env.CORTEX_HOME as string, 'config');
  const value = {
    model: 'claude-sonnet', backend: 'claude', mode: 'api', provider: 'anthropic',
    extraEnv: { ANTHROPIC_BASE_URL: 'http://host-profile.invalid:1234' },
    extraOption: {}, claudeBackend: 'print', thinking: 'high', fallback: [],
  };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
    defaultProfile: 'benchmark-profile', profiles: { 'benchmark-profile': value },
  }));
  profileRepo.invalidate();
}

function armResolution(): Record<string, unknown> {
  return {
    schema_version: 'cortex-benchmark-arm-resolution/1',
    arm: {
      schema_version: 'cortex-benchmark-arm/2',
      kind: 'cortex',
      name: 'cortex-direct',
      backend: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet',
      credential_capability: 'claude-api-key',
      orchestration: { mode: 'direct', ask_manager: false },
      limits: {
        max_thread_starts: 0, max_parent_questions: 0, max_task_depth: 0, max_tasks: 0,
        max_provider_requests: 8, max_resident_agent_processes: 3, max_cost_usd: '2.50',
        deadline_seconds: 90,
      },
    },
    arm_path: '/harness/arms/cortex-direct.yaml',
    trial_id: 'trial-001',
    root_run_id: 'trial-001.cortex-direct',
    task: {
      task_id: 'terminal-task',
      image_ref: 'registry.invalid/task@sha256:fixture',
      image_digest: `sha256:${'a'.repeat(64)}`,
    },
    profile_name: 'benchmark-profile',
    paid_run: false,
    credential_capabilities: [{
      id: 'claude-api-key',
      state: 'offline-contract-passed',
      key: {
        runner_or_backend: 'claude', provider: 'anthropic', protocol: 'anthropic-messages',
        credential_kind: 'api-key-bearer', proxy_adapter_version: 'cortex-bench-trial-proxy/2',
      },
    }],
    credential: {
      upstream_base_url: 'https://api.anthropic.com',
      route_identity_host: 'api.anthropic.com',
      proxy_base_url: 'http://127.0.0.1:49152',
      dummy_token_ref: 'trial-token-handle',
    },
    cli_artifact: {
      path: writeAsset('bundle/claude-trial', '#!/bin/sh\nexit 0\n', 0o755),
      version: CLI_VERSION,
    },
    model_alias_policy: { kind: 'exact' },
    roles: {
      parent: {
        system_prompt_path: writeAsset('parent-system.txt', 'You are the benchmark parent.\n'),
        directive_path: writeAsset('parent-directive.txt', 'Solve the task.\n'),
        tools: ['Read', 'Write'],
        plugin_dirs: [],
        mcp_composition: 'none',
        mcp_config_paths: [writeAsset('mcp-empty.json', '{"mcpServers":{}}\n')],
        disable_hooks: true,
      },
    },
    thread_templates: {},
    thread_agents: {},
    artifact_inventory_spec: { expected: ['stdout', 'stderr', 'manifest'] },
  };
}

function loadPolicy(mutate: (input: any) => void = () => {}, label = 'arm'): {
  policy: NonNullable<ReturnType<typeof loadAgentRunConfigWithPolicy>['policy']>;
  config: ResolvedAgentRunConfig;
} {
  writeProfile();
  const input = armResolution();
  mutate(input);
  const file = writeAsset(`${label}-resolution.json`, JSON.stringify(input));
  const loaded = loadAgentRunConfigWithPolicy({ runConfigFile: file, agentSlot: 'parent' });
  return { policy: loaded.policy!, config: loaded.config };
}

function spec(overrides: Partial<TrialAdapterSpec> = {}, label = 'arm'): TrialAdapterSpec {
  const loaded = overrides.policy && overrides.config
    ? { policy: overrides.policy, config: overrides.config }
    : loadPolicy(() => {}, label);
  const workspace = path.join(root, `${label}-workspace`);
  fs.mkdirSync(workspace, { recursive: true });
  return {
    policy: loaded.policy,
    slot: 'parent',
    config: loaded.config,
    paths: preparePinnedTrialPaths(path.join(root, `${label}-trial`)),
    supervisor: { binary: path.join(root, 'supervisor'), graceMs: 1_000 },
    cwd: workspace,
    ...overrides,
  };
}

function settingsHooks(args: string[]): Record<string, unknown> {
  return JSON.parse(args[args.indexOf('--settings') + 1]).hooks;
}

function capturingSpawner(record: { command?: string; env?: NodeJS.ProcessEnv }) {
  return (command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    record.command = command;
    record.env = options.env;
    const child: any = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = (): boolean => { child.killed = true; return true; };
    return { process: child } as unknown as SpawnedAgentProcess;
  };
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await delay(10);
  }
}

// --- S1 / S4 / S5 / S8: the construction seam ---

it('returns the declared trial adapter shape built from the policy alone', () => {
  const trial = createTrialAdapter(spec());
  assert.deepEqual(
    Object.keys(trial).sort(),
    ['adapter', 'admit', 'backend', 'close', 'roleSurface', 'spawnConfig'],
  );
  assert.equal(trial.backend, 'claude');
  assert.equal(trial.adapter.backend, 'claude');
  assert.equal(typeof trial.admit, 'function');
  assert.equal(typeof trial.close, 'function');
});

it('constructs a fresh unregistered adapter per trial', () => {
  const first = createTrialAdapter(spec({}, 'first'));
  const second = createTrialAdapter(spec({}, 'second'));
  assert.notEqual(first.adapter, second.adapter);
  assert.notEqual(first.adapter, getAdapter('claude'));
  assert.notEqual(second.adapter, getAdapter('claude'));
});

it('closes exactly the sessions its own trial opened (T2)', async () => {
  const trial = createTrialAdapter(spec());
  const record: { command?: string } = {};
  trial.spawnConfig.processSpawner = capturingSpawner(record);
  trial.adapter.spawn(trial.spawnConfig) as AgentProcess;

  const unrelatedKey = 'unrelated-claude-session';
  const sharedAdapter = getAdapter('claude');
  sharedAdapter.spawn({
    ...trial.spawnConfig,
    sessionKey: unrelatedKey,
    channel: unrelatedKey,
    processSpawner: capturingSpawner({}),
  });
  try {
    assert.equal(trial.adapter.listSessions().includes(trial.spawnConfig.sessionKey), true);
    assert.equal(sharedAdapter.listSessions().includes(unrelatedKey), true);
    await trial.close();
    assert.equal(trial.adapter.listSessions().includes(trial.spawnConfig.sessionKey), false);
    assert.equal(sharedAdapter.listSessions().includes(unrelatedKey), true);
    await trial.close();
    assert.equal(sharedAdapter.listSessions().includes(unrelatedKey), true);
  } finally {
    await sharedAdapter.close(unrelatedKey);
  }
});

it('refuses an unproven PI arm with backend_unsupported_for_kind (S8)', () => {
  const loaded = loadPolicy();
  const piPolicy = structuredClone(loaded.policy) as any;
  piPolicy.arm.backend = 'pi';
  piPolicy.pi_benchmark_capability_proven = false;
  assert.throws(
    () => createTrialAdapter(spec({ policy: piPolicy, config: loaded.config })),
    (error: unknown) => {
      assert.ok(error instanceof PolicyCompilationError);
      assert.equal(error.reason, 'backend_unsupported_for_kind');
      assert.equal(error.code, 14);
      return true;
    },
  );
});

// The PI construction path landed (design §13 (13.3)); `trial-adapter-pi.test.ts` owns its rows.
// What stays asserted here is that the dispatch table is still closed and still keyed on proof.
it('constructs a proven PI arm and refuses an unlisted backend (S8)', () => {
  const loaded = loadPolicy();
  const piPolicy = structuredClone(loaded.policy) as any;
  piPolicy.arm.backend = 'pi';
  piPolicy.pi_benchmark_capability_proven = true;
  assert.equal(createTrialAdapter(spec({ policy: piPolicy, config: loaded.config })).backend, 'pi');

  const unlisted = structuredClone(loaded.policy) as any;
  unlisted.arm.backend = 'codex';
  assert.throws(
    () => createTrialAdapter(spec({ policy: unlisted, config: loaded.config }, 'unlisted')),
    (error: unknown) => {
      assert.ok(error instanceof PolicyCompilationError);
      assert.equal(error.code, 14);
      return true;
    },
  );
});

// --- S2 / S3 / C4: the policy is the only source ---

it('builds the spawn surface from the policy, not the tampered projection (C4)', () => {
  const loaded = loadPolicy();
  const tampered = structuredClone(loaded.config);
  tampered.role.tools = ['Bash'];
  tampered.role.systemPrompt = 'tampered projection prompt';
  tampered.role.mcpComposition = 'direct';
  const trial = createTrialAdapter(spec({ policy: loaded.policy, config: tampered }));
  assert.equal(trial.spawnConfig.rawTools, 'Read,Write');
  assert.equal(trial.spawnConfig.systemPrompt, 'You are the benchmark parent.\n');
  assert.equal(trial.spawnConfig.mcpComposition, 'none');
});

it('ignores ambient host state when constructing (S3)', () => {
  const built = spec();
  const before = createTrialAdapter(built);
  const saved = { ...process.env };
  try {
    process.env.HOME = '/tmp/host-home-changed';
    process.env.ANTHROPIC_BASE_URL = 'http://ambient.invalid';
    process.env.SLACK_BOT_TOKEN = 'xoxb-ambient';
    process.env.CORTEX_PROJECT = 'ambient-project';
    process.env.LANG = 'ambient_LOCALE.UTF-8';
    process.env.TZ = 'Pacific/Honolulu';
    const after = createTrialAdapter(built);
    assert.deepEqual(after.spawnConfig, before.spawnConfig);
    assert.deepEqual(after.roleSurface, before.roleSurface);
  } finally {
    for (const key of [
      'HOME', 'ANTHROPIC_BASE_URL', 'SLACK_BOT_TOKEN', 'CORTEX_PROJECT', 'LANG', 'TZ',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

// --- C2: one CLI path, both spawn branches ---

it('threads the policy CLI path into the injected spawner branch (C2)', () => {
  const built = spec();
  const trial = createTrialAdapter(built);
  const cliPath = built.policy.asset_inventory
    .find(asset => asset.kind === 'cli_artifact')!.resolved_path;
  assert.equal(trial.spawnConfig.cliPath, cliPath);
  const record: { command?: string } = {};
  trial.spawnConfig.processSpawner = capturingSpawner(record);
  trial.adapter.spawn(trial.spawnConfig);
  assert.equal(record.command, cliPath);
});

it('runs the policy CLI path in the direct spawn branch (C2)', async () => {
  const marker = path.join(root, 'direct-branch-marker');
  const built = spec();
  const cli = writeAsset(
    'bundle/claude-trial',
    `#!/bin/sh\nprintf 'ran' > ${JSON.stringify(marker)}\nsleep 5\n`,
    0o755,
  );
  const trial = createTrialAdapter(built);
  assert.equal(trial.spawnConfig.cliPath, cli);
  trial.spawnConfig.processSpawner = undefined;
  const session = trial.adapter.spawn(trial.spawnConfig);
  try {
    await waitForFile(marker);
  } finally {
    session.kill();
    await trial.close();
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
});

// --- C6: route from the policy ---

it('routes the trial at the policy proxy rather than the host profile (C6)', () => {
  const built = spec();
  const trial = createTrialAdapter(built);
  assert.equal(trial.spawnConfig.anthropicBaseUrl, 'http://127.0.0.1:49152');
  assert.notEqual(trial.spawnConfig.env?.ANTHROPIC_BASE_URL, 'http://host-profile.invalid:1234');
});

// --- C5 / C7: allowlist-first child environment ---

it('pins the child environment to the trial paths and drops host leaks (C5, C7)', () => {
  const built = spec();
  const trial = createTrialAdapter(built);
  const saved = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = 'xoxb-host-secret';
  try {
    const env = buildClaudeEnv(
      'channel', 'session-id', undefined, undefined,
      trial.spawnConfig.anthropicBaseUrl, trial.spawnConfig.env, undefined,
      trial.spawnConfig.pinnedEnv,
    );
    assert.equal(env.HOME, built.paths.home);
    assert.equal(env.CLAUDE_CONFIG_DIR, built.paths.claudeConfigDir);
    assert.equal(env.XDG_CONFIG_HOME, built.paths.xdgConfigHome);
    assert.equal(env.XDG_CACHE_HOME, built.paths.xdgCacheHome);
    assert.equal(env.CORTEX_HOME, built.paths.cortexHome);
    assert.equal(env.TMPDIR, built.paths.tempDir);
    assert.equal(env.PATH, PINNED_RUNTIME_PATH);
    assert.equal(env.SLACK_BOT_TOKEN, undefined);
    assert.equal(env.SLACK_CHANNEL, undefined);
    assert.equal(env.FEISHU_CHANNEL, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:49152');
  } finally {
    if (saved === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = saved;
  }
});

it('keeps host inheritance for ordinary non-benchmark spawns', () => {
  const saved = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = 'xoxb-host-secret';
  try {
    const env = buildClaudeEnv('C1', 'sid-1');
    assert.equal(env.SLACK_BOT_TOKEN, 'xoxb-host-secret');
    assert.equal(env.SLACK_CHANNEL, 'C1');
  } finally {
    if (saved === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = saved;
  }
});

it('builds the pinned trial environment allowlist-first', () => {
  const paths = preparePinnedTrialPaths(path.join(root, 'pinned'));
  const env = pinnedTrialEnvironment(paths, {
    LANG: 'C', TZ: 'UTC', SLACK_BOT_TOKEN: 'xoxb', NODE_OPTIONS: '--inspect',
    HOME: '/host/home', ANTHROPIC_API_KEY: 'sk-host', PATH: '/host/bin',
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'CLAUDE_CONFIG_DIR', 'CORTEX_HOME', 'CORTEX_PROJECTS_DIR', 'HOME', 'LANG', 'PATH',
    'TEMP', 'TMP', 'TMPDIR', 'TZ', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
  ]);
  assert.equal(env.HOME, paths.home);
  assert.equal(env.PATH, PINNED_RUNTIME_PATH);
});

// --- C3: the per-call MCP budget the trial child is spawned with ---

it('spawns the Claude child with an MCP budget bounded by the trial deadline (C3)', () => {
  const built = spec();
  const trial = createTrialAdapter(built);
  const record: { env?: NodeJS.ProcessEnv } = {};
  trial.spawnConfig.processSpawner = capturingSpawner(record);
  trial.adapter.spawn(trial.spawnConfig);

  const budgetMs = Number(record.env!.MCP_TOOL_TIMEOUT);
  const remainingMs = built.policy.deadline.absolute_epoch_ms - Date.now();
  // C3 names both variables; the startup budget carries the same bounded quantity as the per-call
  // one, since a startup budget that outlives the trial is the unbounded case C3 exists to remove.
  assert.equal(record.env!.MCP_TIMEOUT, record.env!.MCP_TOOL_TIMEOUT);
  // 60 000 ms is the native reference window a benchmark call must be able to outlive (§5.7 C1).
  assert.ok(budgetMs > 60_000, `the supplied budget ${budgetMs}ms does not clear the native default`);
  // The env was built before this line read the clock, so the budget is remaining + grace measured a
  // moment earlier — never more than that plus the time this test took to get here.
  assert.ok(
    budgetMs >= remainingMs + MCP_CLEANUP_GRACE_MS
    && budgetMs <= remainingMs + MCP_CLEANUP_GRACE_MS + 1_000,
    `the supplied budget ${budgetMs}ms is not ${remainingMs}ms remaining plus the cleanup grace`,
  );
});

it('leaves an ordinary spawn without an MCP budget when no trial deadline is present (C3)', () => {
  const env = buildClaudeEnv('C1', 'sid-1');
  assert.equal(env.MCP_TOOL_TIMEOUT, undefined);
  assert.equal(env.MCP_TIMEOUT, undefined);
});

it('derives the MCP budget at the moment of use rather than storing it (C3, §5.6 P5)', async () => {
  const deadlineEpochMs = Date.now() + 120_000;
  const budgetAt = (): number => Number(buildClaudeEnv(
    'C1', 'sid-1', undefined, undefined, undefined, undefined, undefined, undefined, deadlineEpochMs,
  ).MCP_TOOL_TIMEOUT);

  const first = budgetAt();
  await delay(50);
  const second = budgetAt();
  assert.ok(
    second < first && first - second >= 40 && first - second < 5_000,
    `the budget did not track the elapsing deadline (${first}ms then ${second}ms)`,
  );
});

it('bounds the MCP budget even when the inherited environment already carries one (C3)', () => {
  const deadlineEpochMs = Date.now() + 120_000;
  const env = buildClaudeEnv(
    'C1', 'sid-1', undefined, undefined, undefined,
    { MCP_TOOL_TIMEOUT: '100000000', MCP_TIMEOUT: '100000000' },
    undefined, undefined, deadlineEpochMs,
  );
  assert.ok(Number(env.MCP_TOOL_TIMEOUT) <= 120_000 + MCP_CLEANUP_GRACE_MS);
  assert.ok(Number(env.MCP_TIMEOUT) <= 120_000 + MCP_CLEANUP_GRACE_MS);
});

// --- GT4 / GT5 / T6: the guard is the whole hooks object ---

it('carries the compiled guard on the spawn config and the role surface (GT4, GT8)', () => {
  const built = spec();
  const trial = createTrialAdapter(built);
  const guard = built.policy.role_policy_guard.parent;
  assert.deepEqual(trial.spawnConfig.benchmarkPolicyGuard, guard);
  assert.deepEqual(trial.roleSurface.benchmarkPolicyGuard, guard);
});

/** Mount a real ambient hook so "the registry is not consulted" is a claim about a non-empty
 *  registry rather than about an environment that happens to have none. */
function mountAmbientHook(): () => void {
  const directory = path.join(process.env.CORTEX_HOME as string, 'config', 'hooks');
  const file = path.join(directory, 'trial-ambient-probe.json');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    id: 'trial-ambient-probe',
    event: 'agent:pre-tool',
    matcher: 'Read|Write',
    run: { command: 'printf ambient' },
  }));
  assert.deepEqual(
    buildHooksSettings('Read,Write').PreToolUse,
    [{ matcher: 'Read|Write', hooks: [{ type: 'command', command: 'printf ambient' }] }],
  );
  return () => fs.rmSync(file, { force: true });
}

// This pins SHIPPED behaviour, and shipped behaviour is a verbatim transport: the rule set is
// assigned to the `--settings` `hooks` key unchanged. Design §13.10 GS5's rendering into Claude's
// hooks vocabulary is UNLANDED, so the payload below is not known to be honoured by the Claude CLI
// — §13.10 marks that fact `??` and forbids asserting it from memory (design:4482-4492), and the
// only decision-envelope literal Cortex ships is a PermissionRequest allow, evidence for the
// envelope and not for this event or direction. It is not load-bearing at Gate 2: GC2 fixes the
// allow-list to the role's frozen `tools` verbatim and GC3 enumerates no deny, so the guard permits
// exactly what the frozen surface already permits and §3.1(h.4)'s six tools are absent from the
// `--tools` argument itself. The deny first governs at the first gate that can enter a lease state
// other than `parent-writable` — Gates 3/6 (`thread-owned`, `draining`) and Gate 7
// (`answer-frozen`) — which owns landing GS5 and establishing the CLI contract against a stand-in.
it('emits exactly the compiled guard as the Claude hooks object, unrendered (T6)', () => {
  const built = spec();
  const trial = createTrialAdapter(built);
  const guard = built.policy.role_policy_guard.parent;
  const unmount = mountAmbientHook();
  try {
    const hooks = settingsHooks(claudeTest.computeSpawnArgs(trial.spawnConfig));
    assert.deepEqual(hooks, guard);
    assert.equal('PreToolUse' in hooks, false);
  } finally {
    unmount();
  }
});

it('never consults the ambient hook registry when a guard is present (T6)', () => {
  const guard = { 'parent-writable': ['Read', 'Write'] };
  const unmount = mountAmbientHook();
  try {
    const base = {
      tools: 'Read,Write', needsResume: false, sessionId: 'sid',
      mcpComposition: 'none' as const, streamDeltas: false,
    };
    // A guard wins over an ambient surface that is present and non-empty …
    assert.deepEqual(
      settingsHooks(buildSpawnArgs({ ...base, disableHooks: false, benchmarkPolicyGuard: guard })),
      guard,
    );
    // … and over `disableHooks: true`, which keeps meaning "no AMBIENT hooks" (GT5).
    assert.deepEqual(
      settingsHooks(buildSpawnArgs({ ...base, disableHooks: true, benchmarkPolicyGuard: guard })),
      guard,
    );
    // Without a guard the same call still reaches the registry, so the win above is real.
    assert.deepEqual(
      settingsHooks(buildSpawnArgs({ ...base, disableHooks: false })),
      { ...buildHooksSettings('Read,Write') },
    );
    assert.deepEqual(settingsHooks(buildSpawnArgs({ ...base, disableHooks: true })), {});
  } finally {
    unmount();
  }
});

it('refuses to construct a benchmark adapter for a guard-less slot (T8)', () => {
  const loaded = loadPolicy();
  const unguarded = structuredClone(loaded.policy) as any;
  delete unguarded.role_policy_guard.parent;
  assert.throws(
    () => createTrialAdapter(spec({ policy: unguarded, config: loaded.config })),
    (error: unknown) => {
      assert.ok(error instanceof PolicyCompilationError);
      assert.equal(error.reason, 'policy_guard_absent');
      assert.equal(error.code, 30);
      return true;
    },
  );
});

// --- T9: strict benchmark MCP composition ---

it('emits a strict zero-server MCP surface for the none composition (T9)', () => {
  const built = spec();
  const trial = createTrialAdapter(built);
  const args = claudeTest.computeSpawnArgs(trial.spawnConfig);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(
    args.slice(args.indexOf('--mcp-config'), args.indexOf('--strict-mcp-config')),
    ['--mcp-config', built.policy.roles.parent.mcpConfigPaths[0]],
  );
  const servers = JSON.parse(
    fs.readFileSync(built.policy.roles.parent.mcpConfigPaths[0], 'utf8'),
  ).mcpServers;
  assert.deepEqual(Object.keys(servers), []);
});

it('exposes exactly cortex-benchmark-thread for the thread-run composition (T9)', () => {
  const mcp = writeAsset('mcp-benchmark.json', JSON.stringify({
    mcpServers: { 'cortex-benchmark-thread': { command: 'cortex', args: ['mcp'] } },
  }));
  const loaded = loadPolicy((input) => {
    input.roles.parent.mcp_composition = 'benchmark-thread-run';
    input.roles.parent.mcp_config_paths = [mcp];
    // The benchmark thread-run surface admits only CLI versions proven to sustain a long MCP call.
    input.cli_artifact.version = LONG_MCP_CALL_VERSION_GOVERNANCE.claude.verified_versions[0];
  }, 'thread-run');
  const trial = createTrialAdapter(spec(
    { policy: loaded.policy, config: loaded.config }, 'thread-run',
  ));
  const args = claudeTest.computeSpawnArgs(trial.spawnConfig);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(
    args.slice(args.indexOf('--mcp-config'), args.indexOf('--strict-mcp-config')),
    ['--mcp-config', mcp],
  );
  assert.equal(args.some(value => value.includes('mcp-config-slack')), false);
  assert.equal(args.some(value => value.includes('mcp-config-feishu')), false);
  assert.equal(args.some(value => value.includes('mcp-config-web')), false);
});

// --- T12: static ambient-reach prohibition ---

const FORBIDDEN_MODULES = [
  'src/agent-adapter/index.ts',
  'src/agent-adapter/pi/discovery.ts',
  'src/agent-adapter/pi/agent-dir.ts',
];
const FORBIDDEN_BINDINGS = [
  'getAdapter', 'registerPISessionPath', 'piProviderDiscovery', 'discoverPIProviders',
  'ensureAuthVisible', 'ensurePIAgentDirs',
];

function sourceRoot(): string {
  return path.resolve('src');
}

function resolveImport(specifier: string, importer: string): string | null {
  const aliases: Record<string, string> = {
    '@core/': 'src/core/', '@domain/': 'src/domain/', '@store/': 'src/store/',
    '@events/': 'src/events/', '@platform/': 'src/platform/', '@orch/': 'src/orchestration/',
  };
  let target: string | null = null;
  for (const [alias, directory] of Object.entries(aliases)) {
    if (specifier.startsWith(alias)) {
      target = path.resolve(directory + specifier.slice(alias.length));
    }
  }
  if (target === null && specifier.startsWith('.')) {
    target = path.resolve(path.dirname(importer), specifier);
  }
  if (target === null) return null;
  const candidate = target.endsWith('.js') ? `${target.slice(0, -3)}.ts` : `${target}.ts`;
  return fs.existsSync(candidate) ? candidate : null;
}

interface ImportEdge {
  specifier: string;
  bindings: string[];
}

function runtimeImports(source: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const pattern = /^import\s+(?!type\b)([\s\S]*?)\s*from\s*'([^']+)';$/gm;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1];
    const named = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}'));
    const bindings = clause.includes('{')
      ? named.split(',').map(value => value.trim()).filter(value => !value.startsWith('type '))
        .map(value => value.split(/\s+as\s+/)[0].trim()).filter(Boolean)
      : [clause.trim()];
    edges.push({ specifier: match[2], bindings });
  }
  for (const match of source.matchAll(/^import\s+'([^']+)';$/gm)) {
    edges.push({ specifier: match[1], bindings: [] });
  }
  return edges;
}

function runtimeGraph(entry: string): { modules: Set<string>; bindings: Set<string> } {
  const modules = new Set<string>();
  const bindings = new Set<string>();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (modules.has(current)) continue;
    modules.add(current);
    for (const edge of runtimeImports(fs.readFileSync(current, 'utf8'))) {
      const resolved = resolveImport(edge.specifier, current);
      if (resolved === null || !resolved.startsWith(sourceRoot())) continue;
      for (const binding of edge.bindings) bindings.add(binding);
      queue.push(resolved);
    }
  }
  return { modules, bindings };
}

it('cannot reach the ambient adapter registry or PI ambient state (T12)', () => {
  const graph = runtimeGraph('src/domain/benchmark/trial-adapter-factory.ts');
  assert.ok(graph.modules.size > 5, 'import graph was not walked');
  for (const forbidden of FORBIDDEN_MODULES) {
    assert.equal(
      graph.modules.has(path.resolve(forbidden)), false,
      `benchmark construction path imports ${forbidden}`,
    );
  }
  for (const binding of FORBIDDEN_BINDINGS) {
    assert.equal(graph.bindings.has(binding), false, `benchmark construction path imports ${binding}`);
  }
});

it('detects a forbidden import when one exists (T12 self-check)', () => {
  const graph = runtimeGraph('src/domain/agents/facade.ts');
  assert.equal(graph.modules.has(path.resolve('src/agent-adapter/index.ts')), true);
  assert.equal(graph.bindings.has('getAdapter'), true);
});
