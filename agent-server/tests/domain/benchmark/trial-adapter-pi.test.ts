// input:  a compiled trial policy re-labelled PI, pinned trial paths and fake spawners
// output: per-trial PI construction, ambient-reach and battery proofs
// pos:    Regression suite for design §13 (13.3) P1-P13, (13.4) A1-A15 and battery T2/T7-T14
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// WHY THE POLICY IS CLONED RATHER THAN COMPILED (manager note F8 N2). `f063` deliberately withheld
// the `benchmark-long-mcp-call` capability from PI, so `validateLongMcpCallCapability`
// (policy-compiler.ts:266) refuses every compiled PI arm with code 28. That refusal is correct and
// stays until the T15 prover flips it; these tests therefore compile a Claude arm and re-label the
// frozen result, which is exactly the surface `createTrialAdapter` consumes. The refusal itself is
// still asserted below, so the clone cannot hide a regression in it.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, it } from 'vitest';

import { LONG_MCP_CALL_VERSION_GOVERNANCE } from '../../../src/agent-adapter/capabilities.js';
import { getAdapter } from '../../../src/agent-adapter/index.js';
import { PIAdapter } from '../../../src/agent-adapter/pi/adapter.js';
import { PI_AGENT_DIR, PI_MODELS_PATH, PI_SESSIONS_DIR } from '../../../src/agent-adapter/pi/defaults.js';
import {
  BENCHMARK_THREAD_SERVER_NAME, buildServerStates,
} from '../../../src/agent-adapter/pi/mcp-bridge.js';
import { PI_BENCHMARK_DEADLINE_ENV, remainingTrialMs } from '../../../src/agent-adapter/pi/mcp-duration.js';
import {
  GATE2_LEASE_STATE, PI_LEASE_STATE_ENV, PI_MCP_COMPOSITION_ENV, PI_POLICY_GUARD_ENV,
  resolvePiToolGate,
} from '../../../src/agent-adapter/pi/policy-guard.js';
import type { SpawnedAgentProcess } from '../../../src/agent-adapter/types.js';
import { PINNED_RUNTIME_PATH, preparePinnedTrialPaths } from '../../../src/domain/agent-run/pinned-node-process.js';
import {
  loadAgentRunConfigWithPolicy, type ResolvedAgentRunConfig,
} from '../../../src/domain/agent-run/run-config.js';
import { PolicyCompilationError, type ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';
import {
  createTrialAdapter, type TrialAdapterSpec,
} from '../../../src/domain/benchmark/trial-adapter-factory.js';
import { profileRepo } from '../../../src/store/profile-repo.js';

const CLI_VERSION = 'fixture-pi/9.9.9';
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-pi-'));
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
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
    defaultProfile: 'benchmark-profile',
    profiles: {
      'benchmark-profile': {
        model: 'claude-sonnet', backend: 'claude', mode: 'api', provider: 'anthropic',
        extraEnv: { ANTHROPIC_BASE_URL: 'http://host-profile.invalid:1234' },
        extraOption: {}, claudeBackend: 'print', thinking: 'high', fallback: [],
      },
    },
  }));
  profileRepo.invalidate();
}

const PI_GUARD = {
  'parent-writable': ['read', 'grep', 'glob', 'thread_run'],
  'answer-frozen': ['read'],
};

function armResolution(): Record<string, unknown> {
  return {
    schema_version: 'cortex-benchmark-arm-resolution/1',
    arm: {
      schema_version: 'cortex-benchmark-arm/2',
      kind: 'cortex', name: 'cortex-direct', backend: 'claude', provider: 'anthropic',
      model: 'claude-sonnet', credential_capability: 'claude-api-key',
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
      task_id: 'terminal-task', image_ref: 'registry.invalid/task@sha256:fixture',
      image_digest: `sha256:${'a'.repeat(64)}`,
    },
    profile_name: 'benchmark-profile',
    paid_run: false,
    credential_capabilities: [{
      id: 'claude-api-key', state: 'offline-contract-passed',
      key: {
        runner_or_backend: 'claude', provider: 'anthropic', protocol: 'anthropic-messages',
        credential_kind: 'api-key-bearer', proxy_adapter_version: 'cortex-bench-trial-proxy/1',
      },
    }],
    credential: {
      upstream_base_url: 'https://api.anthropic.com',
      route_identity_host: 'api.anthropic.com',
      proxy_base_url: 'http://127.0.0.1:49152',
      dummy_token_ref: 'trial-token-handle',
    },
    cli_artifact: { path: writeAsset('bundle/pi-trial', '#!/bin/sh\nexit 0\n', 0o755), version: CLI_VERSION },
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
        benchmark_policy_guard: PI_GUARD,
      },
    },
    thread_templates: {},
    thread_agents: {},
    artifact_inventory_spec: { expected: ['stdout', 'stderr', 'manifest'] },
  };
}

/** Compile a Claude arm, then re-label the frozen policy PI. See the header note (F8 N2). */
function piPolicy(mutate: (input: any) => void = () => {}, label = 'pi'): {
  policy: ResolvedTrialPolicy;
  config: ResolvedAgentRunConfig;
} {
  writeProfile();
  const input = armResolution();
  mutate(input);
  const file = writeAsset(`${label}-resolution.json`, JSON.stringify(input));
  const loaded = loadAgentRunConfigWithPolicy({ runConfigFile: file, agentSlot: 'parent' });
  const policy = structuredClone(loaded.policy!) as any;
  policy.arm.backend = 'pi';
  policy.pi_benchmark_capability_proven = true;
  policy.model_execution.backend = 'pi';
  policy.model_execution.cli_name = 'pi';
  return { policy: policy as ResolvedTrialPolicy, config: loaded.config };
}

function spec(overrides: Partial<TrialAdapterSpec> = {}, label = 'pi'): TrialAdapterSpec {
  const loaded = overrides.policy && overrides.config
    ? { policy: overrides.policy, config: overrides.config }
    : piPolicy(() => {}, label);
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

interface SpawnRecord {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  supervision?: unknown;
  child?: any;
}

function capturingSpawner(record: SpawnRecord, supervision?: unknown) {
  return (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: unknown }) => {
    record.command = command;
    record.args = args;
    record.env = options.env;
    record.cwd = options.cwd === undefined ? undefined : String(options.cwd);
    const child: any = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = (): boolean => { child.emit('close', 0); return true; };
    record.child = child;
    return { process: child, supervision } as unknown as SpawnedAgentProcess;
  };
}

function spawnPi(built: TrialAdapterSpec, supervision?: unknown): {
  trial: ReturnType<typeof createTrialAdapter>;
  record: SpawnRecord;
} {
  const trial = createTrialAdapter(built);
  const record: SpawnRecord = {};
  trial.spawnConfig.processSpawner = capturingSpawner(record, supervision);
  trial.adapter.spawn(trial.spawnConfig);
  return { trial, record };
}

// --- S8 / P1: the backend now constructs, and only through the spawn config ---

it('constructs a fresh unregistered PI adapter for a proven arm (S5, S8)', () => {
  const trial = createTrialAdapter(spec());
  assert.equal(trial.backend, 'pi');
  assert.equal(trial.adapter.backend, 'pi');
  assert.ok(trial.adapter instanceof PIAdapter);
  assert.notEqual(trial.adapter, getAdapter('pi'));
  assert.notEqual(createTrialAdapter(spec({}, 'second')).adapter, trial.adapter);
});

it('still refuses an unproven PI arm (S8 fail-closed)', () => {
  const loaded = piPolicy();
  const unproven = structuredClone(loaded.policy) as any;
  unproven.pi_benchmark_capability_proven = false;
  assert.throws(
    () => createTrialAdapter(spec({ policy: unproven, config: loaded.config })),
    (error: unknown) => {
      assert.ok(error instanceof PolicyCompilationError);
      assert.equal(error.reason, 'backend_unsupported_for_kind');
      assert.equal(error.code, 14);
      return true;
    },
  );
});

it('refuses a guard-less PI slot before constructing anything (GT2, T8)', () => {
  const loaded = piPolicy();
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

it('spawns through the spawn config supervisor and surfaces its handle (P1, T1 seam)', () => {
  const supervision = { started: Promise.resolve({ pid: 1, pgid: 1 }) };
  const built = spec();
  const trial = createTrialAdapter(built);
  const record: SpawnRecord = {};
  trial.spawnConfig.processSpawner = capturingSpawner(record, supervision);
  const proc = trial.adapter.spawn(trial.spawnConfig);
  assert.equal(proc.supervision, supervision);
  assert.equal(record.command, built.policy.asset_inventory
    .find(asset => asset.kind === 'cli_artifact')!.resolved_path);
});

it('refuses a benchmark spawn that carries no supervisor (S6.1, A12)', () => {
  const trial = createTrialAdapter(spec());
  trial.spawnConfig.processSpawner = undefined;
  assert.throws(
    () => trial.adapter.spawn(trial.spawnConfig),
    /missing required inputs: processSpawner/,
  );
});

it('refuses a benchmark spawn whose ambient fallbacks would be taken (A12, A13)', () => {
  for (const member of ['cliPath', 'cwd', 'pinnedEnv', 'piGatewayBaseUrl', 'streamDeltas'] as const) {
    const trial = createTrialAdapter(spec({}, `missing-${member}`));
    trial.spawnConfig.processSpawner = capturingSpawner({});
    (trial.spawnConfig as any)[member] = undefined;
    assert.throws(
      () => trial.adapter.spawn(trial.spawnConfig),
      new RegExp(`missing required inputs: .*${member}`),
      `${member} fallback is reachable on the benchmark path`,
    );
  }
});

// --- P2 / P3: binary path and version from the policy ---

it('takes the binary path and version from the policy, never from PATH (P2, P3)', () => {
  const built = spec();
  const { record } = spawnPi(built);
  const artifact = built.policy.asset_inventory.find(asset => asset.kind === 'cli_artifact')!;
  assert.equal(record.command, artifact.resolved_path);
  assert.notEqual(record.command, 'pi');
  assert.equal(built.policy.model_execution.cli_version, CLI_VERSION);
  assert.equal(built.policy.model_execution.cli_name, 'pi');
});

// --- P4 / P5 / P6 / P7: trial-local agent, session, auth and provider directories ---

it('places the agent, session and provider directories under the trial root (P4, P5, P7)', () => {
  const built = spec();
  const { trial, record } = spawnPi(built);
  const agentDir = record.env!.PI_CODING_AGENT_DIR!;
  assert.equal(agentDir.startsWith(built.paths.root), true, agentDir);
  assert.notEqual(agentDir, PI_AGENT_DIR);

  const sessionDir = record.args![record.args!.indexOf('--session-dir') + 1];
  assert.equal(sessionDir.startsWith(built.paths.root), true, sessionDir);
  assert.notEqual(sessionDir, PI_SESSIONS_DIR);
  assert.equal((trial.adapter as PIAdapter).sessionDir, sessionDir);

  const models = path.join(agentDir, 'models.json');
  assert.equal(fs.existsSync(models), true);
  assert.notEqual(models, PI_MODELS_PATH);
});

it('writes the trial auth from the policy dummy token, never a host symlink (P6, A5, A6)', () => {
  const built = spec();
  const { record } = spawnPi(built);
  const authPath = path.join(record.env!.PI_CODING_AGENT_DIR!, 'auth.json');
  assert.equal(fs.lstatSync(authPath).isSymbolicLink(), false);
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.deepEqual(Object.keys(auth), ['anthropic']);
  assert.equal(auth.anthropic.key, built.policy.credential.dummy_token_ref);
});

it('refuses to spawn when the trial credential cannot be prepared (P6)', () => {
  const built = spec();
  const trial = createTrialAdapter(built);
  const agentDir = path.join(built.paths.root, 'pi-agent');
  fs.rmSync(agentDir, { recursive: true });
  fs.writeFileSync(agentDir, 'not-a-directory');
  const record: SpawnRecord = {};
  trial.spawnConfig.processSpawner = capturingSpawner(record);
  assert.throws(() => trial.adapter.spawn(trial.spawnConfig));
  assert.equal(record.command, undefined);
});

// --- P8 / P12: one provider, routed at the policy proxy ---

it('writes exactly the arm provider routed at the policy proxy (P8, P12, A7, A8)', () => {
  const built = spec();
  const { record } = spawnPi(built);
  const catalog = JSON.parse(
    fs.readFileSync(path.join(record.env!.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(catalog.providers), ['anthropic']);
  assert.equal(
    catalog.providers.anthropic.baseUrl,
    built.policy.credential.proxy_base_url,
  );
});

it('never routes a PI trial at the host gateway (P12)', () => {
  const trial = createTrialAdapter(spec());
  assert.equal(trial.spawnConfig.piGatewayBaseUrl, 'http://127.0.0.1:49152');
});

it('refuses to spawn when the trial provider catalog cannot be written (P7, P8, P12)', () => {
  const built = spec();
  const trial = createTrialAdapter(built);
  fs.mkdirSync(path.join(built.paths.root, 'pi-agent', 'models.json'));
  const record: SpawnRecord = {};
  trial.spawnConfig.processSpawner = capturingSpawner(record);
  assert.throws(() => trial.adapter.spawn(trial.spawnConfig));
  assert.equal(record.command, undefined);
});

// --- P9: the extension set is derived from the role ---

it('omits the hook bridge for a role that declares no hook surface (P9, T7)', () => {
  const { record } = spawnPi(spec());
  const extensions = record.args!.filter((value, index) => record.args![index - 1] === '--extension');
  assert.equal(extensions.length, 2);
  assert.equal(extensions.some(value => value.includes('mcp-bridge')), true);
  assert.equal(extensions.some(value => value.includes('tool-shims')), true);
  assert.equal(extensions.some(value => value.includes('hook-bridge')), false);
});

it('keeps the hook bridge for a role that does declare one (P9)', () => {
  // §6.8 G2 makes `disable_hooks: true` mandatory in the arm schema, so the declaring case is
  // constructed on the frozen policy the adapter actually reads.
  const loaded = piPolicy(() => {}, 'hooks');
  (loaded.policy as any).roles.parent.disableHooks = false;
  const { record } = spawnPi(spec({ policy: loaded.policy, config: loaded.config }, 'hooks'));
  const extensions = record.args!.filter((value, index) => record.args![index - 1] === '--extension');
  assert.equal(extensions.length, 3);
  assert.equal(extensions.some(value => value.includes('hook-bridge')), true);
});

// --- P11 / GT6 / T7: the guard decides, the fail-open allowlist does not travel ---

it('exports the guard and its lease state, and not the fail-open allowlist (P11, GT6, T7)', () => {
  const built = spec();
  const { record } = spawnPi(built);
  assert.deepEqual(JSON.parse(record.env![PI_POLICY_GUARD_ENV]!), PI_GUARD);
  assert.equal(record.env![PI_LEASE_STATE_ENV], GATE2_LEASE_STATE);
  assert.equal(record.env!.CORTEX_PI_ALLOWED_TOOLS, undefined);
});

it('the exported guard drives a guarded, fail-closed gate on the far side (GT6, T7, T8)', () => {
  const { record } = spawnPi(spec());
  const gate = resolvePiToolGate(record.env!);
  assert.equal(gate.guarded, true);
  assert.equal(gate.decide('read').allow, true);
  // PI-native names, not Claude labels: the Claude label must not be what opens the tool.
  assert.equal(gate.decide('bash').allow, false);
  assert.equal(gate.decide('write', 'Write').allow, false);
  assert.equal(gate.decide('Read').allow, false);
});

// --- P13 / T10: the strict composition, not merely the absence of a refusal ---

it('lands the strict none composition rather than merely not throwing (P13, T10)', () => {
  const { record } = spawnPi(spec());
  assert.equal(record.env![PI_MCP_COMPOSITION_ENV], 'none');
  assert.deepEqual(buildServerStates(record.env!), []);
});

it('lands exactly cortex-benchmark-thread for the thread-run composition (P13, T10)', () => {
  const mcp = writeAsset('mcp-benchmark.json', JSON.stringify({
    mcpServers: { 'cortex-benchmark-thread': { command: 'cortex', args: ['mcp'] } },
  }));
  const loaded = piPolicy(input => {
    input.roles.parent.mcp_composition = 'benchmark-thread-run';
    input.roles.parent.mcp_config_paths = [mcp];
    // Code 29 gates the thread-run surface on a CLI version proven to sustain a long MCP call.
    // The arm compiles as Claude here (see the header note), so it is Claude's verified set.
    input.cli_artifact.version = LONG_MCP_CALL_VERSION_GOVERNANCE.claude.verified_versions[0];
  }, 'thread-run');
  const { record } = spawnPi(spec({ policy: loaded.policy, config: loaded.config }, 'thread-run'));
  assert.equal(record.env![PI_MCP_COMPOSITION_ENV], 'benchmark-thread-run');
  assert.deepEqual(
    buildServerStates(record.env!).map(state => state.name),
    [BENCHMARK_THREAD_SERVER_NAME],
  );
});

it('carries the trial deadline so an MCP call is bounded by it (§5.6 P2, P5)', () => {
  const built = spec();
  const { record } = spawnPi(built);
  assert.equal(
    record.env![PI_BENCHMARK_DEADLINE_ENV],
    String(built.policy.deadline.absolute_epoch_ms),
  );
  const remaining = remainingTrialMs(record.env!)!;
  assert.ok(remaining > 0 && remaining <= 90_000, `remaining=${remaining}`);
});

// --- A13 / A15: the child environment and per-spawn settings ---

it('pins the PI child environment allowlist-first (A13, C7)', () => {
  const built = spec();
  const saved = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = 'xoxb-host-secret';
  try {
    const { record } = spawnPi(built);
    assert.equal(record.env!.HOME, built.paths.home);
    assert.equal(record.env!.CORTEX_HOME, built.paths.cortexHome);
    assert.equal(record.env!.XDG_CONFIG_HOME, built.paths.xdgConfigHome);
    assert.equal(record.env!.TMPDIR, built.paths.tempDir);
    assert.equal(record.env!.PATH, PINNED_RUNTIME_PATH);
    assert.equal(record.env!.SLACK_BOT_TOKEN, undefined);
    assert.equal(record.env!.SLACK_CHANNEL, undefined);
    assert.equal(record.env!.FEISHU_CHANNEL, undefined);
  } finally {
    if (saved === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = saved;
  }
});

it('takes cwd from the spec rather than the DATA_DIR fallback (A12)', () => {
  const built = spec();
  const { record } = spawnPi(built);
  assert.equal(record.cwd, built.cwd);
});

it('freezes the delta policy per spawn instead of reading watched settings (A15)', () => {
  const trial = createTrialAdapter(spec());
  assert.equal(trial.spawnConfig.streamDeltas, false);
});

// --- A9 / A10: resume discovery is dead, and the registries are per-trial ---

it('never reaches the resume filename scan on a fresh trial (A9)', () => {
  const trial = createTrialAdapter(spec());
  assert.equal(trial.spawnConfig.resume, false);
  assert.equal(trial.spawnConfig.sessionId, null);
});

it('keeps the session map and path registry per trial (A10, T2)', async () => {
  const first = createTrialAdapter(spec({}, 'iso-first'));
  const second = createTrialAdapter(spec({}, 'iso-second'));
  const firstRecord: SpawnRecord = {};
  const secondRecord: SpawnRecord = {};
  first.spawnConfig.processSpawner = capturingSpawner(firstRecord);
  second.spawnConfig.processSpawner = capturingSpawner(secondRecord);
  first.adapter.spawn(first.spawnConfig);
  second.adapter.spawn(second.spawnConfig);

  assert.deepEqual(first.adapter.listSessions(), [first.spawnConfig.sessionKey]);
  assert.deepEqual(second.adapter.listSessions(), [second.spawnConfig.sessionKey]);
  firstRecord.child.emit('close', 0);
  await first.close();
  assert.deepEqual(first.adapter.listSessions(), []);
  assert.deepEqual(second.adapter.listSessions(), [second.spawnConfig.sessionKey]);
  secondRecord.child.emit('close', 0);
  await second.close();
});

// --- T11: the host's PI state is byte-identical across a full construction and spawn ---

function hostPiState(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const target of [PI_AGENT_DIR, PI_SESSIONS_DIR, path.join(os.homedir(), '.pi')]) {
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        const stat = fs.lstatSync(full);
        snapshot[full] = stat.isSymbolicLink()
          ? `link:${fs.readlinkSync(full)}`
          : `file:${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
      }
    };
    snapshot[`exists:${target}`] = String(fs.existsSync(target));
    walk(target);
  }
  return snapshot;
}

it('leaves host PI state byte-identical before and after a full trial spawn (T11)', () => {
  const before = hostPiState();
  const built = spec();
  const { record } = spawnPi(built);
  // The trial genuinely wrote PI state — just not the host's.
  assert.equal(fs.existsSync(path.join(record.env!.PI_CODING_AGENT_DIR!, 'models.json')), true);
  assert.deepEqual(hostPiState(), before);
});

// --- T14: unavailable accounting stays null ---

it('preserves unreported accounting for a PI trial (T14, R5)', () => {
  const trial = createTrialAdapter(spec());
  assert.equal(trial.spawnConfig.preserveUnreportedAccounting, true);
});

// --- T13 construction half: the identity the run will report ---

it('carries backend-neutral PI identity into the construction surface (T13, I5, I6)', () => {
  const built = spec();
  const trial = createTrialAdapter(built);
  assert.equal(trial.backend, 'pi');
  assert.equal(built.policy.model_execution.cli_name, 'pi');
  assert.equal(built.policy.model_execution.cli_version, CLI_VERSION);
  assert.notEqual(built.policy.model_execution.cli_version, null);
});
