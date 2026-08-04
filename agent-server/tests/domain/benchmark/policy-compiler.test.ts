// input:  policy compiler, runner invocation, two-schema loader
// output: Gate-1 schema, identity, freeze, failure, and projection proofs
// pos:    Regression suite for compiled benchmark trial policy
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import type { ResolvedProfileConfig } from '../../../src/domain/agents/profile-manager.js';
import type { AgentRunCliOptions } from '../../../src/domain/agent-run/agent-run-cli.js';
import {
  loadAgentRunConfig, loadAgentRunConfigWithPolicy,
} from '../../../src/domain/agent-run/run-config.js';
import { runOneShotAgent } from '../../../src/domain/agent-run/runner.js';
import { parseArmDefinitionSet } from '../../../src/domain/benchmark/arm-schema.js';
import {
  BENCHMARK_FAILURES,
  BENCHMARK_FAILURE_INVARIANTS,
  remainingDeadlineMs,
  type BenchmarkFailureReason,
} from '../../../src/domain/benchmark/resolved-policy.js';
import {
  capabilityWhitelistForArm,
  childTemplateWhitelistForArm,
} from '../../../src/domain/benchmark/capabilities.js';
import {
  CAPABILITIES_BY_BACKEND, Capability, LONG_MCP_CALL_VERSION_GOVERNANCE,
} from '../../../src/agent-adapter/capabilities.js';
import {
  compileResolvedTrialPolicy,
  PolicyCompilationError,
  projectAgentRunConfig,
  rejectPolicyReresolution,
  type ArmResolution,
  type PolicyCompilerDependencies,
} from '../../../src/domain/benchmark/policy-compiler.js';
import { profileRepo } from '../../../src/store/profile-repo.js';

const FIXED_WALL_MS = 1_900_000_000_000;
const FIXED_MONOTONIC_NS = 18_765_432_100_000_000n;
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-policy-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeAsset(name: string, content: string): string {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function profile(overrides: Partial<ResolvedProfileConfig> = {}): ResolvedProfileConfig {
  return {
    name: 'benchmark-profile',
    model: 'claude-sonnet',
    backend: 'claude',
    mode: 'api',
    provider: 'anthropic',
    extraEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:49152' },
    extraOption: {},
    claudeBackend: 'print',
    thinking: 'high',
    fallback: [],
    ...overrides,
  };
}

function arm() {
  return {
    schema_version: 'cortex-benchmark-arm/2' as const,
    kind: 'cortex' as const,
    name: 'cortex-direct',
    backend: 'claude' as const,
    provider: 'anthropic',
    model: 'claude-sonnet',
    credential_capability: 'claude-api-key',
    orchestration: { mode: 'direct' as const, ask_manager: false },
    limits: {
      max_thread_starts: 0,
      max_parent_questions: 0,
      max_task_depth: 0,
      max_tasks: 0,
      max_provider_requests: 8,
      max_resident_agent_processes: 3,
      max_cost_usd: '2.50',
      deadline_seconds: 90,
    },
  };
}

function resolution(): ArmResolution {
  const systemPrompt = writeAsset('parent-system.txt', 'You are the benchmark parent.\n');
  const directive = writeAsset('parent-directive.txt', 'Solve the task.\n');
  const cli = writeAsset('claude-fixture', '#!/bin/sh\nexit 0\n');
  const mcp = writeAsset('mcp-empty.json', '{"mcpServers":{}}\n');
  return {
    schema_version: 'cortex-benchmark-arm-resolution/1',
    arm: arm(),
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
        runner_or_backend: 'claude',
        provider: 'anthropic',
        protocol: 'anthropic-messages',
        credential_kind: 'api-key-bearer',
        proxy_adapter_version: 'cortex-bench-trial-proxy/1',
      },
    }],
    credential: {
      upstream_base_url: 'https://api.anthropic.com',
      route_identity_host: 'api.anthropic.com',
      proxy_base_url: 'http://127.0.0.1:49152',
      dummy_token_ref: 'trial-token-handle',
    },
    cli_artifact: { path: cli, version: 'fixture-1.0.0' },
    model_alias_policy: { kind: 'exact' },
    roles: {
      parent: {
        system_prompt_path: systemPrompt,
        directive_path: directive,
        tools: ['Read', 'Write'],
        plugin_dirs: [],
        mcp_composition: 'none',
        mcp_config_paths: [mcp],
        disable_hooks: true,
        benchmark_policy_guard: {
          parent_writable: ['Read', 'Write'],
          thread_active: ['Read'],
        },
      },
    },
    thread_templates: {},
    thread_agents: {},
    artifact_inventory_spec: {
      expected: ['stdout', 'stderr', 'manifest', 'workspace_diff'],
    },
  };
}

function dependencies(
  profileValue = profile(),
  stderrLines: string[] = [],
): PolicyCompilerDependencies {
  return {
    wall_clock_ms: () => FIXED_WALL_MS,
    monotonic_ns: () => FIXED_MONOTONIC_NS,
    resolve_profile: () => profileValue,
    stderr: { write: value => { stderrLines.push(String(value)); return true; } },
  };
}

function writeLoaderProfile(): void {
  const configDir = path.join(process.env.CORTEX_HOME as string, 'config');
  const value = {
    model: 'claude-sonnet', backend: 'claude', mode: 'api', provider: 'anthropic',
    extraEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:49152' },
    extraOption: {}, claudeBackend: 'print', thinking: 'high', fallback: [],
  };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
    defaultProfile: 'benchmark-profile',
    profiles: { 'benchmark-profile': value, 'alternate-profile': value },
  }));
  profileRepo.invalidate();
}

function runnerOptions(
  runConfigFile: string,
  profileName: string,
  rootRunId: string,
  label: string,
): AgentRunCliOptions {
  const trajectoryRoot = path.join(root, `trajectory-${label}`);
  return {
    promptFile: writeAsset(`prompt-${label}.txt`, 'Solve the task.\n'),
    agentSlot: 'parent', profile: profileName, cwd: root, outputFormat: 'jsonl',
    eventsFile: path.join(trajectoryRoot, 'events.jsonl'), trajectoryRoot,
    runConfigFile, supervisorBinary: path.join(root, 'unused-supervisor'),
    graceMs: 1_000, rootRunId,
  };
}

function installFailingVersionProbe(marker: string): () => void {
  const bin = path.join(root, 'bin');
  const probe = writeAsset('bin/claude', '#!/bin/sh\ntouch "$VERSION_PROBE_MARKER"\nexit 1\n');
  fs.chmodSync(probe, 0o755);
  const previousPath = process.env.PATH;
  const previousMarker = process.env.VERSION_PROBE_MARKER;
  process.env.PATH = bin;
  process.env.VERSION_PROBE_MARKER = marker;
  return () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.VERSION_PROBE_MARKER;
    else process.env.VERSION_PROBE_MARKER = previousMarker;
  };
}

async function expectInvocationMismatch(
  profileName: string,
  rootRunId: string,
  label: string,
  expected: RegExp,
): Promise<void> {
  writeLoaderProfile();
  const file = writeAsset(`arm-resolution-${label}.json`, JSON.stringify(resolution()));
  const options = runnerOptions(file, profileName, rootRunId, label);
  const marker = path.join(root, `version-probe-${label}`);
  const restoreEnv = installFailingVersionProbe(marker);
  let stderr = '';
  let exitCode: number;
  try {
    exitCode = await runOneShotAgent(options, {
      stdout: { write: () => true },
      stderr: { write: value => { stderr += String(value); return true; } },
    });
  } finally {
    restoreEnv();
  }
  assert.equal(exitCode, 1);
  assert.match(stderr, expected);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(options.trajectoryRoot), false);
}

function configureCoderReview(input: ArmResolution, includeRoles = true): void {
  const value = input.arm as ReturnType<typeof arm>;
  value.orchestration.mode = 'coder-review' as 'direct';
  Object.assign(value.orchestration, { coder_review_variant: 'audit-retry' });
  value.limits.max_thread_starts = 1;
  input.thread_templates = {
    'benchmark-coder-review': path.resolve(
      'defaults/config/thread-templates/templates/benchmark-coder-review.json',
    ),
  };
  input.thread_agents = {
    'benchmark-coder': path.resolve(
      'defaults/config/thread-templates/agents/benchmark-coder.json',
    ),
    'benchmark-reviewer': path.resolve(
      'defaults/config/thread-templates/agents/benchmark-reviewer.json',
    ),
  };
  if (!includeRoles) return;
  input.roles['benchmark-coder'] = structuredClone(input.roles.parent);
  input.roles['benchmark-reviewer'] = structuredClone(input.roles.parent);
}

function configureBenchmarkMcp(input: ArmResolution): void {
  const mcp = writeAsset('mcp-benchmark-thread.json', JSON.stringify({
    mcpServers: { 'cortex-benchmark-thread': { command: 'cortex', args: ['mcp'] } },
  }));
  input.roles.parent.mcp_composition = 'benchmark-thread-run';
  input.roles.parent.mcp_config_paths = [mcp];
}

function configureVendorBaseline(input: ArmResolution): void {
  const value = input.arm as Record<string, unknown>;
  value.kind = 'vendor-baseline';
  value.vendor_agent = 'claude-code';
  delete value.backend;
  delete value.orchestration;
  delete input.roles.parent.benchmark_policy_guard;
}

function expectFailure(
  input: ArmResolution,
  reason: BenchmarkFailureReason,
  code: number,
  deps = dependencies(),
  expectedPayload: Record<string, unknown> = {},
): PolicyCompilationError {
  const lines: string[] = [];
  const compilerDeps = { ...deps, stderr: { write: (value: unknown) => {
    lines.push(String(value));
    return true;
  } } } as PolicyCompilerDependencies;
  let thrown: unknown;
  try {
    compileResolvedTrialPolicy(input, compilerDeps);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof PolicyCompilationError);
  assert.equal(thrown.reason, reason);
  assert.equal(thrown.code, code);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    code, failure_class: thrown.failureClass, reason, ...expectedPayload,
  });
  return thrown;
}

it('compiles an ordered, absolute, closed, deeply frozen cortex policy', () => {
  const stderr: string[] = [];
  const input = resolution();
  const policy = compileResolvedTrialPolicy(input, dependencies(profile(), stderr));

  assert.equal(stderr.length, 0);
  assert.equal(policy.deadline.compiled_at_epoch_ms, FIXED_WALL_MS);
  assert.equal(policy.deadline.absolute_epoch_ms, FIXED_WALL_MS + 90_000);
  assert.equal(policy.deadline.monotonic_origin_ns, FIXED_MONOTONIC_NS);
  assert.deepEqual(policy.child_template_whitelist, []);
  assert.deepEqual(policy.capability_whitelist, []);
  assert.equal(policy.derived.effective_admission_budget, 2);
  assert.equal('effective_admission_budget' in policy.limits, false);
  assert.equal(policy.model_execution.configured_route_base_host, 'api.anthropic.com');
  assert.notEqual(policy.model_execution.configured_route_base_host, '127.0.0.1:49152');
  assert.deepEqual(policy.asset_inventory.map(entry => entry.kind), [
    'arm', 'credential_capability', 'profile', 'cli_artifact', 'provider_route',
    'prompt', 'prompt', 'tool_set', 'mcp_server', 'limits',
  ]);
  assert.deepEqual(
    policy.asset_inventory.map(entry => entry.ordinal),
    policy.asset_inventory.map((_, index) => index + 1),
  );
  assert.match(policy.arm_canonical_sha256, /^[0-9a-f]{64}$/);
  assert.match(policy.asset_inventory_sha256, /^[0-9a-f]{64}$/);
  assert.match(policy.identity.model_execution_identity_hash.parent, /^[0-9a-f]{64}$/);
  assert.match(policy.identity.role_tool_surface_hash.parent, /^[0-9a-f]{64}$/);
  assert.match(policy.identity.bundle_manifest_hash, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.arm));
  assert.ok(Object.isFrozen(policy.asset_inventory));
  assert.ok(Object.isFrozen(policy.roles.parent.tools));
  assert.throws(() => { (policy.limits as { max_tasks: number }).max_tasks = 1; }, TypeError);
  assert.throws(() => { (policy.child_template_whitelist as string[]).push('other'); }, TypeError);
});

it('keeps MEIH stable when only the ephemeral proxy authority changes (D-ROUTE a)', () => {
  const first = resolution();
  const second = resolution();
  second.credential.proxy_base_url = 'http://127.0.0.1:59153';
  const firstHash = compileResolvedTrialPolicy(
    first, dependencies(),
  ).identity.model_execution_identity_hash.parent;
  const secondHash = compileResolvedTrialPolicy(
    second, dependencies(),
  ).identity.model_execution_identity_hash.parent;
  assert.equal(secondHash, firstHash);
});

it('moves MEIH when the logical route identity host changes (D-ROUTE b)', () => {
  const first = resolution();
  const second = resolution();
  second.credential.route_identity_host = 'alternate.anthropic.invalid';
  const firstHash = compileResolvedTrialPolicy(
    first, dependencies(),
  ).identity.model_execution_identity_hash.parent;
  const secondHash = compileResolvedTrialPolicy(
    second, dependencies(),
  ).identity.model_execution_identity_hash.parent;
  assert.notEqual(secondHash, firstHash);
});

it('validates every ordered arm cross-field rule with its assigned failure', () => {
  const cases: Array<{
    label: string;
    mutate: (input: ArmResolution) => void;
    reason: BenchmarkFailureReason;
    code: number;
  }> = [
    {
      label: 'cortex fields',
      mutate: input => { delete (input.arm as Record<string, unknown>).backend; },
      reason: 'arm_field_conflict', code: 2,
    },
    {
      label: 'vendor fields',
      mutate: input => { Object.assign(input.arm as object, { kind: 'vendor-baseline', vendor_agent: 'codex' }); },
      reason: 'arm_field_conflict', code: 2,
    },
    {
      label: 'coder variant required',
      mutate: input => { (input.arm as ReturnType<typeof arm>).orchestration.mode = 'coder-review' as 'direct'; },
      reason: 'coder_review_variant_invalid', code: 3,
    },
    {
      label: 'coder variant forbidden',
      mutate: input => {
        Object.assign((input.arm as ReturnType<typeof arm>).orchestration, {
          coder_review_variant: 'audit-retry',
        });
      },
      reason: 'coder_review_variant_invalid', code: 3,
    },
    {
      label: 'ask manager mode',
      mutate: input => { (input.arm as ReturnType<typeof arm>).orchestration.ask_manager = true; },
      reason: 'ask_manager_unsupported_mode', code: 4,
    },
    {
      label: 'thread start consistency',
      mutate: input => { (input.arm as ReturnType<typeof arm>).limits.max_thread_starts = 1; },
      reason: 'arm_field_conflict', code: 2,
    },
    {
      label: 'question consistency',
      mutate: input => { (input.arm as ReturnType<typeof arm>).limits.max_parent_questions = 1; },
      reason: 'arm_field_conflict', code: 2,
    },
    {
      label: 'non-manager task limits',
      mutate: input => { (input.arm as ReturnType<typeof arm>).limits.max_tasks = 1; },
      reason: 'arm_field_conflict', code: 2,
    },
    {
      label: 'capacity',
      mutate: input => {
        const value = input.arm as ReturnType<typeof arm>;
        Object.assign(value.orchestration, { mode: 'manager' });
        Object.assign(value.limits, {
          max_thread_starts: 1, max_task_depth: 3, max_tasks: 4,
          max_resident_agent_processes: 3,
        });
      },
      reason: 'capacity_rule_violated', code: 7,
    },
    {
      label: 'vendor pi provider',
      mutate: input => {
        const value = input.arm as Record<string, unknown>;
        value.kind = 'vendor-baseline';
        value.vendor_agent = 'pi';
        delete value.backend;
        delete value.orchestration;
        delete value.provider;
        (value.limits as Record<string, unknown>).max_thread_starts = 0;
      },
      reason: 'arm_field_conflict', code: 2,
    },
  ];

  for (const testCase of cases) {
    const input = resolution();
    testCase.mutate(input);
    const error = expectFailure(input, testCase.reason, testCase.code);
    assert.ok(error.message.includes(testCase.reason), testCase.label);
  }
});

it('reports ArmDefinition failures before malformed phase-resolution assets', () => {
  const input = resolution();
  (input.arm as ReturnType<typeof arm>).limits.max_provider_requests = 0;
  input.roles.parent = null as never;
  expectFailure(input, 'limit_out_of_range', 5);
});

it('reports credential rule 9 before provider rule 10 when both fail', () => {
  const input = resolution();
  const value = input.arm as Record<string, unknown>;
  value.kind = 'vendor-baseline';
  value.vendor_agent = 'pi';
  delete value.backend;
  delete value.orchestration;
  delete value.provider;
  (value.limits as Record<string, unknown>).max_thread_starts = 0;
  input.credential_capabilities = [];
  expectFailure(input, 'credential_capability_unknown', 8);
});

it('rejects duplicate arm names in a declared arm set', () => {
  assert.throws(
    () => parseArmDefinitionSet([arm(), arm()]),
    error => error instanceof Error && error.message.includes('arm names must be unique'),
  );
});

it('rejects schema, malformed role assets, and non-object guard inputs as typed JSON', () => {
  expectFailure(null as never, 'arm_schema_invalid', 1);

  const invalidSchema = resolution();
  (invalidSchema.arm as Record<string, unknown>).schema_version = 'cortex-benchmark-arm/1';
  expectFailure(invalidSchema, 'arm_schema_invalid', 1);

  const malformedRole = resolution();
  malformedRole.roles.parent = null as never;
  expectFailure(malformedRole, 'arm_schema_invalid', 1);

  const scalarGuard = resolution();
  scalarGuard.roles.parent.benchmark_policy_guard = '/tmp/guard-v1.json' as never;
  expectFailure(scalarGuard, 'arm_schema_invalid', 1);

  const invalidNestedGuard = resolution();
  invalidNestedGuard.roles.parent.benchmark_policy_guard = {
    thread_active: { Write: (() => 'deny') as never },
  };
  expectFailure(invalidNestedGuard, 'arm_schema_invalid', 1);

  const missingAliasPolicy = resolution();
  delete (missingAliasPolicy as unknown as Record<string, unknown>).model_alias_policy;
  expectFailure(missingAliasPolicy, 'arm_schema_invalid', 1);

  const invalidLimit = resolution();
  (invalidLimit.arm as ReturnType<typeof arm>).limits.max_provider_requests = 0;
  expectFailure(invalidLimit, 'limit_out_of_range', 5);
});

it('uses lossless monotonic time for the remaining-deadline accessor', () => {
  const policy = compileResolvedTrialPolicy(resolution(), dependencies());
  assert.equal(policy.deadline.monotonic_origin_ns, FIXED_MONOTONIC_NS);
  assert.equal(remainingDeadlineMs(policy, FIXED_MONOTONIC_NS + 5_000_000_000n), 85_000);
  assert.equal(remainingDeadlineMs(policy, FIXED_MONOTONIC_NS + 95_000_000_000n), 0);
});

it('enforces credential, profile, image, and asset failure codes', () => {
  const unknown = resolution();
  unknown.credential_capabilities = [];
  expectFailure(unknown, 'credential_capability_unknown', 8);

  const unsupported = resolution();
  unsupported.credential_capabilities[0].state = 'unsupported';
  expectFailure(unsupported, 'credential_capability_unsupported', 9);

  const insufficient = resolution();
  insufficient.paid_run = true;
  expectFailure(insufficient, 'credential_capability_state_insufficient', 10);

  const unresolved = resolution();
  expectFailure(unresolved, 'profile_unresolvable', 11, {
    ...dependencies(),
    resolve_profile: () => { throw new Error('missing'); },
  });

  const mismatchCases: Array<{
    field: 'model' | 'backend' | 'provider';
    armValue: string;
    profileValue: string;
  }> = [
    { field: 'model', armValue: 'claude-sonnet', profileValue: 'claude-opus' },
    { field: 'backend', armValue: 'claude', profileValue: 'pi' },
    { field: 'provider', armValue: 'anthropic', profileValue: 'other-provider' },
  ];
  for (const mismatch of mismatchCases) {
    const mismatchedProfile = profile({ [mismatch.field]: mismatch.profileValue });
    expectFailure(
      resolution(),
      'arm_profile_value_mismatch',
      43,
      dependencies(mismatchedProfile),
      {
        field: mismatch.field,
        arm_value: mismatch.armValue,
        profile_value: mismatch.profileValue,
      },
    );
  }

  const fallback = resolution();
  expectFailure(fallback, 'profile_has_fallbacks', 12, dependencies(profile({
    fallback: [{
      model: 'fallback', backend: 'claude', mode: null, provider: null,
      extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
    }],
  })));

  const extra = resolution();
  expectFailure(extra, 'profile_extra_option_unsupported', 13, dependencies(profile({
    extraOption: { '--permission-mode': 'default' },
  })));

  const image = resolution();
  image.task.image_digest = 'latest';
  expectFailure(image, 'image_digest_unpinned', 21);

  const missing = resolution();
  missing.cli_artifact.path = path.join(root, 'missing-cli');
  expectFailure(missing, 'asset_missing', 15);

  const unreadable = resolution();
  expectFailure(unreadable, 'asset_unreadable', 16, {
    ...dependencies(),
    read_file: file => {
      if (file === unreadable.cli_artifact.path) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return fs.readFileSync(file);
    },
  });

  const mismatch = resolution();
  mismatch.expected_asset_hashes = { 'cli_artifact:claude': '0'.repeat(64) };
  expectFailure(mismatch, 'asset_hash_mismatch', 17);
});

it('rejects duplicate skills, invalid MCP surfaces, and unfreezable policy values', () => {
  const duplicate = resolution();
  const first = path.join(root, 'plugin-a', 'skills', 'inspect');
  const second = path.join(root, 'plugin-b', 'skills', 'inspect');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(first, 'SKILL.md'), 'first\n');
  fs.writeFileSync(path.join(second, 'SKILL.md'), 'second\n');
  duplicate.roles.parent.plugin_dirs = [path.dirname(path.dirname(first)), path.dirname(path.dirname(second))];
  expectFailure(duplicate, 'duplicate_skill_name', 18);

  const invalidMcp = resolution();
  fs.writeFileSync(invalidMcp.roles.parent.mcp_config_paths[0], JSON.stringify({
    mcpServers: { ambient: { command: 'false' } },
  }));
  expectFailure(invalidMcp, 'mcp_composition_invalid', 19);

  const unfreezable = resolution();
  unfreezable.artifact_inventory_spec = new Map() as never;
  expectFailure(unfreezable, 'policy_freeze_failed', 22);
});

it('rejects nonpositive absolute deadlines and unproven PI benchmark support', () => {
  const deadline = resolution();
  expectFailure(deadline, 'deadline_nonpositive', 6, {
    ...dependencies(),
    wall_clock_ms: () => Number.MAX_SAFE_INTEGER,
  });

  const pi = resolution();
  Object.assign(pi.arm as ReturnType<typeof arm>, { backend: 'pi', provider: 'openai-codex' });
  expectFailure(pi, 'backend_unsupported_for_kind', 14, dependencies(profile({
    backend: 'pi', provider: 'openai-codex', thinking: 'high',
  })));
});

function piResolution(): ArmResolution {
  const input = resolution();
  Object.assign(input.arm as ReturnType<typeof arm>, { backend: 'pi', provider: 'openai-codex' });
  input.pi_benchmark_capability_proven = true;
  return input;
}

const piDependencies = (): PolicyCompilerDependencies => dependencies(profile({
  backend: 'pi', provider: 'openai-codex',
}));

it('admits a PI arm to the long MCP call and keeps code 28 live for a backend without it', () => {
  // The capability was admitted on measured evidence: a real PI MCP call held 63324 ms through the
  // production bridge while a no-options control client on a second server was cut at 60 s.
  const compiled = compileResolvedTrialPolicy(piResolution(), piDependencies());
  assert.equal(compiled.model_execution.backend, 'pi');

  // The raiser must not die with the flip. The arm schema's `backend` enum is closed
  // (`arm-schema.ts:89`), so a capability-less backend cannot be synthesised by name; it is
  // synthesised by declaration instead — PI's shipped set is swapped for one without the entry.
  const shipped = CAPABILITIES_BY_BACKEND.pi;
  CAPABILITIES_BY_BACKEND.pi = new Set(
    [...shipped].filter(entry => entry !== Capability.BenchmarkLongMcpCall),
  );
  try {
    expectFailure(piResolution(), 'backend_lacks_long_mcp_call', 28, piDependencies());
  } finally {
    CAPABILITIES_BY_BACKEND.pi = shipped;
  }
});

it('gates a PI arm on its proven benchmark capability in both directions', () => {
  const unproven = piResolution();
  unproven.pi_benchmark_capability_proven = false;
  expectFailure(unproven, 'backend_unsupported_for_kind', 14, piDependencies());

  const compiled = compileResolvedTrialPolicy(piResolution(), piDependencies());
  assert.equal(compiled.pi_benchmark_capability_proven, true);
});

it('refuses an unverified CLI version only where a benchmark MCP surface exists', () => {
  const unorderable = resolution();
  configureBenchmarkMcp(unorderable);
  expectFailure(unorderable, 'cli_version_unsupported_for_long_mcp_call', 29);

  const unverifiedRelease = resolution();
  configureBenchmarkMcp(unverifiedRelease);
  unverifiedRelease.cli_artifact.version = '2.1.219 (Claude Code)';
  expectFailure(unverifiedRelease, 'cli_version_unsupported_for_long_mcp_call', 29);

  // An empty or absent version never reaches the membership test: the resolution shape rejects it.
  const empty = resolution();
  configureBenchmarkMcp(empty);
  empty.cli_artifact.version = '';
  expectFailure(empty, 'arm_schema_invalid', 1);

  const verified = resolution();
  configureBenchmarkMcp(verified);
  verified.cli_artifact.version = '2.1.220 (Claude Code)';
  const supported = compileResolvedTrialPolicy(verified, dependencies());
  assert.equal(supported.model_execution.claude_cli_version, '2.1.220 (Claude Code)');

  // Scope boundary: an arm with no MCP client has no long call to orphan.
  const noSurface = compileResolvedTrialPolicy(resolution(), dependencies());
  assert.equal(noSurface.model_execution.claude_cli_version, 'fixture-1.0.0');
});

it('exempts a bridge-governed backend by declaration and refuses every undeclared one', () => {
  // Which process owns the MCP client decides who governs the call. Claude's CLI owns it and reads
  // its own per-call budget, so the concrete version is evidence and the allowlist binds. PI's calls
  // are issued by the Cortex bridge over a pinned SDK, so no `pi` binary version is evidence either
  // way. Both facts are declared; neither is inferred from an empty list.
  assert.equal(LONG_MCP_CALL_VERSION_GOVERNANCE.claude.governed_by, 'cli-version');
  assert.equal(LONG_MCP_CALL_VERSION_GOVERNANCE.pi.governed_by, 'cortex-bridge');

  const bridged = piResolution();
  configureBenchmarkMcp(bridged);
  bridged.cli_artifact.version = 'pi-0.0.0-never-listed';
  const compiled = compileResolvedTrialPolicy(bridged, piDependencies());
  assert.equal(compiled.model_execution.cli_version, 'pi-0.0.0-never-listed');

  // Silence must stay refusal. A backend nobody declared takes the refusing branch even when its arm
  // is otherwise the one that just compiled — being unlisted is never an exemption.
  const registry = LONG_MCP_CALL_VERSION_GOVERNANCE as Record<string, unknown>;
  const declared = registry.pi;
  delete registry.pi;
  try {
    const undeclared = piResolution();
    configureBenchmarkMcp(undeclared);
    undeclared.cli_artifact.version = 'pi-0.0.0-never-listed';
    expectFailure(undeclared, 'cli_version_unsupported_for_long_mcp_call', 29, piDependencies());
  } finally {
    registry.pi = declared;
  }
});

it('refuses any compiled cortex role that carries no policy guard', () => {
  const parentless = resolution();
  delete parentless.roles.parent.benchmark_policy_guard;
  expectFailure(parentless, 'policy_guard_absent', 30);

  const reviewerless = resolution();
  configureCoderReview(reviewerless);
  delete reviewerless.roles['benchmark-reviewer'].benchmark_policy_guard;
  expectFailure(reviewerless, 'policy_guard_absent', 30);
});

it('fails a vendor baseline before it can emit an absent guard slot', () => {
  const input = resolution();
  configureVendorBaseline(input);

  expectFailure(input, 'policy_guard_absent', 30);
});

it('carries every compiled role guard on the frozen policy, keyed by slot', () => {
  const input = resolution();
  configureCoderReview(input);
  const policy = compileResolvedTrialPolicy(input, dependencies());

  assert.deepEqual(Object.keys(policy.role_policy_guard).sort(), [
    'benchmark-coder', 'benchmark-reviewer', 'parent',
  ]);
  assert.deepEqual(policy.role_policy_guard.parent, {
    parent_writable: ['Read', 'Write'],
    thread_active: ['Read'],
  });
  assert.ok(Object.isFrozen(policy.role_policy_guard));
  assert.ok(Object.isFrozen(policy.role_policy_guard.parent));
  assert.throws(
    () => { (policy.role_policy_guard as Record<string, unknown>).parent = {}; },
    TypeError,
  );
});

it('enforces closed template, capability, and required-role whitelists', () => {
  const missingRoles = resolution();
  configureCoderReview(missingRoles, false);
  expectFailure(missingRoles, 'asset_missing', 15);

  const input = resolution();
  configureCoderReview(input);
  const policy = compileResolvedTrialPolicy(input, dependencies());
  assert.deepEqual(policy.child_template_whitelist, ['benchmark-coder-review']);
  assert.deepEqual(policy.capability_whitelist, ['artifact.write', 'task.read']);
  assert.deepEqual(Object.keys(policy.roles).sort(), [
    'benchmark-coder', 'benchmark-reviewer', 'parent',
  ]);

  const denied = structuredClone(input);
  denied.thread_templates.ambient = input.thread_templates['benchmark-coder-review'];
  expectFailure(denied, 'template_not_whitelisted', 20);
});

it('feeds every role surface hash into the bundle manifest hash', () => {
  const firstInput = resolution();
  configureCoderReview(firstInput);
  const first = compileResolvedTrialPolicy(firstInput, dependencies());

  const secondInput = structuredClone(firstInput);
  secondInput.roles['benchmark-reviewer'].benchmark_policy_guard = {
    parent_writable: ['Read', 'Write'],
    thread_active: ['Read', 'Write'],
  };
  const second = compileResolvedTrialPolicy(secondInput, dependencies());

  assert.equal(
    first.identity.role_tool_surface_hash.parent,
    second.identity.role_tool_surface_hash.parent,
  );
  assert.notEqual(
    first.identity.role_tool_surface_hash['benchmark-reviewer'],
    second.identity.role_tool_surface_hash['benchmark-reviewer'],
  );
  assert.notEqual(first.identity.bundle_manifest_hash, second.identity.bundle_manifest_hash);
});

it('stores the contract whitelist vectors without wildcards', () => {
  assert.deepEqual(childTemplateWhitelistForArm(arm()), []);
  assert.deepEqual(capabilityWhitelistForArm(arm()), []);

  const manager = arm();
  manager.orchestration.mode = 'manager' as 'direct';
  manager.orchestration.ask_manager = true;
  assert.deepEqual(childTemplateWhitelistForArm(manager), [
    'benchmark-coder-review', 'benchmark-manager',
  ]);
  assert.deepEqual(capabilityWhitelistForArm(manager), [
    'artifact.write', 'dependency.declare', 'qa.answer', 'qa.ask', 'task.claim',
    'task.create', 'task.decompose', 'task.propose_block', 'task.propose_complete', 'task.read',
  ]);
});

it('classifies all 44 failure codes and reports both invariant classes as JSON', () => {
  assert.deepEqual(BENCHMARK_FAILURES.map(value => value.code),
    Array.from({ length: 44 }, (_, index) => index + 1));
  assert.equal(new Set(BENCHMARK_FAILURES.map(value => value.reason)).size, 44);
  assert.equal(BENCHMARK_FAILURES.filter(value => value.failureClass === 'P').length, 28);
  assert.equal(BENCHMARK_FAILURES.filter(value => value.failureClass === 'R').length, 16);
  assert.deepEqual(BENCHMARK_FAILURES.find(value => value.code === 44), {
    code: 44,
    reason: 'run_config_schema_unknown',
    failureClass: 'P',
  });
  assert.deepEqual(BENCHMARK_FAILURE_INVARIANTS.P, [
    'nonzero_exit', 'no_partial_policy_or_process_admitted', 'json_reason_stderr',
  ]);
  assert.deepEqual(BENCHMARK_FAILURE_INVARIANTS.R, [
    'nonzero_exit', 'strict_finalization', 'json_reason_stderr',
  ]);

  const prestart = resolution();
  (prestart.arm as ReturnType<typeof arm>).limits.max_resident_agent_processes = 0;
  const pError = expectFailure(prestart, 'limit_out_of_range', 5);
  assert.equal(pError.failureClass, 'P');

  const lines: string[] = [];
  assert.throws(
    () => rejectPolicyReresolution('profile', 'benchmark-profile', {
      write: value => { lines.push(String(value)); return true; },
    }),
    error => error instanceof PolicyCompilationError && error.failureClass === 'R',
  );
  assert.deepEqual(JSON.parse(lines[0]), {
    code: 23, failure_class: 'R', reason: 'policy_reresolution_attempted',
  });
});

it('projects disposable run config without changing policy authority', () => {
  const policy = compileResolvedTrialPolicy(resolution(), dependencies());
  const projection = projectAgentRunConfig(policy, 'parent');
  const file = writeAsset('compiled-run-config.json', `${JSON.stringify(projection)}\n`);
  const loaded = loadAgentRunConfig(file);
  assert.equal(loaded.role.systemPrompt, policy.roles.parent.systemPrompt);
  assert.deepEqual(loaded.role.tools, policy.roles.parent.tools);
  assert.deepEqual(loaded.limits, policy.limits);
  assert.deepEqual(loaded.runConfig, policy.arm);
});

it('compiles an emitted arm-resolution document at the loader boundary', () => {
  writeLoaderProfile();
  const input = resolution();
  const file = writeAsset('arm-resolution.json', `${JSON.stringify(input)}\n`);
  const loaded = loadAgentRunConfigWithPolicy({
    runConfigFile: file,
    agentSlot: 'parent',
  });

  assert.ok(loaded.policy);
  assert.ok(Object.isFrozen(loaded.policy));
  assert.equal(loaded.policy.schema_version, 'cortex-benchmark-resolved-policy/2');
  assert.equal(loaded.policy.trial_id, input.trial_id);
  assert.equal(loaded.config.role.systemPrompt, 'You are the benchmark parent.\n');
  assert.deepEqual(loaded.config.role.tools, ['Read', 'Write']);
  assert.deepEqual(loaded.config.runConfig, arm());
});

it('keeps malformed recognized arm-resolution bodies on code 1', () => {
  const file = writeAsset('malformed-arm-resolution.json', JSON.stringify({
    schema_version: 'cortex-benchmark-arm-resolution/1',
    arm: null,
  }));
  assert.throws(
    () => loadAgentRunConfigWithPolicy({ runConfigFile: file, agentSlot: 'parent' }),
    error => error instanceof PolicyCompilationError
      && error.code === 1
      && error.reason === 'arm_schema_invalid'
      && error.failureClass === 'P',
  );
});

it('rejects a benchmark profile-name mismatch before probing or admission', async () => {
  await expectInvocationMismatch(
    'alternate-profile',
    'trial-001.cortex-direct',
    'profile',
    /profile_name mismatch.*expected 'alternate-profile'.*received 'benchmark-profile'/i,
  );
});

it('rejects a benchmark root-run-id mismatch before probing or admission', async () => {
  await expectInvocationMismatch(
    'benchmark-profile',
    'different-root-run',
    'root',
    /root_run_id mismatch.*expected 'different-root-run'.*received 'trial-001.cortex-direct'/i,
  );
});

it('loads the stable representative compiled projection fixture directly', () => {
  // Stable cross-language handoff: a second implementation must reproduce this exact path and
  // schema. The CLI stand-in is a fixed test asset with contents frozen forever, precisely so the
  // golden's `cli_artifact` hash does not track production source churn — it previously pointed at
  // `src/domain/agent-run/identity.ts`, so every edit to that file moved the fixture. No Python
  // consumer of this golden exists yet; when one lands it hashes the stub, not a TypeScript source.
  const fixture = path.resolve('tests/benchmark-resolved-run-config.golden.json');
  const input = resolution();
  input.cli_artifact.path = path.resolve('tests/benchmark-cli-artifact-stub');
  input.roles.parent.system_prompt_path = path.resolve('tests/benchmark-policy-system-prompt.txt');
  input.roles.parent.directive_path = path.resolve('tests/benchmark-policy-system-prompt.txt');
  input.roles.parent.mcp_config_paths = [path.resolve('defaults/config/mcp-config-empty.json')];
  const policy = compileResolvedTrialPolicy(input, dependencies());
  const expected = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  assert.deepEqual(projectAgentRunConfig(policy, 'parent', path.dirname(fixture)), expected);

  const loaded = loadAgentRunConfig(fixture);
  assert.equal(loaded.role.systemPrompt, 'You are the representative Cortex parent.\n');
  assert.deepEqual(loaded.role.tools, ['Read', 'Write']);
  assert.deepEqual(loaded.runConfig, arm());
});
