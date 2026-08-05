// input:  a compiled coder-review policy, a live lease reader and per-step thread options
// output: proof that the compiled guard table is per-role and the selector is per-step
// pos:    Regression suite for the per-step guard lease state on the in-trial thread path
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. The seam under test is the compiler/spawn boundary, so nothing stands in for it: the
// real compiler produces the table, the real per-step closure overlays the selector, the real
// adapter turns the config into an environment, and the real PI gate resolver reads that
// environment back. The only stand-in is the child process, which is downstream of the overlay.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, it, vi } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent-adapter/claude/adapter.js';
import {
  compilePiPolicyGuard, guardDecision, PI_LEASE_STATE_ENV, PI_POLICY_GUARD_ENV,
  resolvePiToolGate,
} from '../../../src/agent-adapter/pi/policy-guard.js';
import { buildPiEnv } from '../../../src/agent-adapter/pi/spawn-args.js';
import type {
  AgentProcessSpawner, AgentSpawnConfig, SpawnedAgentProcess,
} from '../../../src/agent-adapter/types.js';
import { computeRoleToolSurfaceHash } from '../../../src/domain/agent-run/identity.js';
import { preparePinnedTrialPaths } from '../../../src/domain/agent-run/pinned-node-process.js';
import { roleSurfaceFromSpawnConfig } from '../../../src/domain/agent-run/role-surface.js';
import type { RunAgentOptions } from '../../../src/domain/agents/spawn-config.js';
import { createTrialAdapter } from '../../../src/domain/benchmark/trial-adapter-factory.js';
import {
  createBenchmarkTrialRunAgent,
} from '../../../src/domain/benchmark/trial-thread-adapter.js';
import type { LeaseState } from '../../../src/domain/benchmark/workspace-lease.js';
import {
  compileTrialPolicy, writeFixtureAsset, type TrialPolicyFixture,
} from './trial-thread-policy-fixture.js';

/** §6.1's closed vocabulary, spelled here so LS8(iii) can enumerate the states that are NOT the
 *  step's own. A key outside it names no state. */
const LEASE_STATES: LeaseState[] = [
  'parent-writable', 'draining', 'thread-owned', 'answer-frozen', 'released',
];

let root = '';
const spawned: AgentSpawnConfig[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-lease-'));
  spawned.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function trialCli(): string {
  return writeFixtureAsset(root, 'bundle/trial-cli', '#!/bin/sh\nexit 0\n', 0o755);
}

function fixture(label = 'claude'): TrialPolicyFixture {
  return compileTrialPolicy({ root, backend: 'claude', cli: trialCli(), label });
}

function observeSpawnConfigs(): void {
  const original = ClaudeAdapter.prototype.spawn;
  vi.spyOn(ClaudeAdapter.prototype, 'spawn').mockImplementation(function (this: ClaudeAdapter, config) {
    spawned.push(config);
    return original.call(this, config);
  });
}

function respondingSpawner(record: { env?: NodeJS.ProcessEnv } = {}): AgentProcessSpawner {
  return (_command, _args, options) => {
    record.env = options.env;
    const child: any = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = (): boolean => { child.emit('close', 0); return true; };
    child.stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(String(chunk).split('\n')[0] || '{}');
      child.stdout.write(`${JSON.stringify({
        type: 'result', subtype: 'success', is_error: false,
        session_id: request.session_id ?? 'trial-session', result: 'done', num_turns: 1,
      })}\n`);
      setImmediate(() => child.emit('close', 0));
    });
    return { process: child } as unknown as SpawnedAgentProcess;
  };
}

function trialInput(built: TrialPolicyFixture, leaseState: () => LeaseState) {
  return {
    policy: built.policy,
    config: built.config,
    paths: preparePinnedTrialPaths(path.join(root, 'trial-home')),
    supervisor: { binary: path.join(root, 'supervisor'), graceMs: 1_000 },
    leaseState,
  };
}

function stepOptions(overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  return {
    channel: 'benchmark:thread', sessionKey: 'thr:t1:benchmark-reviewer',
    sessionId: null, threadId: 't1', profileName: 'benchmark-profile',
    benchmarkAgentSlot: 'benchmark-reviewer',
    cwd: workspace,
    systemPrompt: 'template system prompt', tools: 'Bash',
    mcpComposition: 'none', disableHooks: true, loadCortexRules: false,
    streamDeltas: false, captureTranscriptLogs: false, preserveUnreportedAccounting: true,
    recordCost: false,
    ...overrides,
  };
}

// --- LS2: the key set is a function of the slot's role class and of nothing else ---

it('compiles parent under parent-writable and every in-trial child slot under thread-owned', () => {
  for (const variant of ['audit-retry', 'reviewer-fix'] as const) {
    const built = compileTrialPolicy({
      root, backend: 'claude', cli: trialCli(), label: variant, variant,
    });
    const guards = built.policy.role_policy_guard;
    const childSlot = variant === 'audit-retry' ? 'benchmark-reviewer' : 'benchmark-fixer';

    assert.deepEqual(Object.keys(guards.parent as object), ['parent-writable']);
    assert.deepEqual(Object.keys(guards['benchmark-coder'] as object), ['thread-owned']);
    assert.deepEqual(Object.keys(guards[childSlot] as object), ['thread-owned']);
    // LS8(ii): WL10's vocabulary intersection is empty for every compiled slot.
    for (const guard of Object.values(guards)) {
      const outside = Object.keys(guard as object)
        .filter(state => !LEASE_STATES.includes(state as LeaseState));
      assert.deepEqual(outside, []);
    }
    // The allow-list itself is the role's frozen tool list, in frozen order.
    assert.deepEqual(
      (guards[childSlot] as Record<string, string[]>)['thread-owned'],
      built.policy.roles[childSlot].tools,
    );
  }
});

// --- LS8(iii): the negative that a static guard passes and a coupled guard fails ---

it('denies every tool in the role list when the selector names any other lease state', () => {
  const built = fixture();
  const guard = built.policy.role_policy_guard['benchmark-reviewer'];
  const tools = built.policy.roles['benchmark-reviewer'].tools;
  const evaluator = compilePiPolicyGuard(guard);

  for (const state of LEASE_STATES.filter(value => value !== 'thread-owned')) {
    for (const tool of tools) {
      const decision = guardDecision(evaluator, tool, state);
      assert.equal(decision.allow, false, `${tool} was allowed under '${state}'`);
      assert.equal(decision.reason, `no allow-list for lease state '${state}'`);
    }
  }
  // The control: the state the compiler keyed the table with allows the same list.
  for (const tool of tools) {
    assert.equal(guardDecision(evaluator, tool, 'thread-owned').allow, true);
  }
});

// --- LS3 / LS4: the selector is the live lease, read per step at spawn-config build time ---

it('overlays the live lease state on the step spawn config beside the resume target', async () => {
  observeSpawnConfigs();
  const built = fixture();
  const runAgent = createBenchmarkTrialRunAgent(trialInput(built, () => 'thread-owned'));

  const handle = runAgent('review', {
    ...stepOptions(), processSpawner: respondingSpawner(),
  });
  await handle.promise;

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].benchmarkLeaseState, 'thread-owned');
});

it('records two different selectors when the lease state differs between two steps', async () => {
  observeSpawnConfigs();
  const built = fixture();
  const states: LeaseState[] = ['thread-owned', 'released'];
  let step = 0;
  const runAgent = createBenchmarkTrialRunAgent(
    trialInput(built, () => states[step]),
  );

  for (step = 0; step < 2; step += 1) {
    const handle = runAgent('review', {
      ...stepOptions(), processSpawner: respondingSpawner(),
    });
    await handle.promise;
  }

  assert.deepEqual(
    spawned.map(config => config.benchmarkLeaseState), ['thread-owned', 'released'],
  );
});

it('reads the lease at every step rather than once at factory construction', async () => {
  observeSpawnConfigs();
  const built = fixture();
  const reads: number[] = [];
  let calls = 0;
  const runAgent = createBenchmarkTrialRunAgent(trialInput(built, () => {
    calls += 1;
    return 'thread-owned';
  }));
  // A factory that read a value at construction would have read it before any step ran.
  assert.equal(calls, 0);

  for (let index = 0; index < 2; index += 1) {
    const handle = runAgent('review', {
      ...stepOptions(), processSpawner: respondingSpawner(),
    });
    await handle.promise;
    reads.push(calls);
  }

  assert.deepEqual(reads, [1, 2]);
});

// --- LS1 / LS5 / LS6: the table is identity, the selection is not ---

it('keeps the compiled guard byte-identical across steps while the selector varies', async () => {
  observeSpawnConfigs();
  const built = fixture();
  const states: LeaseState[] = ['thread-owned', 'parent-writable'];
  let step = 0;
  const runAgent = createBenchmarkTrialRunAgent(trialInput(built, () => states[step]));

  for (step = 0; step < 2; step += 1) {
    const handle = runAgent('review', {
      ...stepOptions(), processSpawner: respondingSpawner(),
    });
    await handle.promise;
  }

  assert.equal(spawned.length, 2);
  assert.equal(
    JSON.stringify(spawned[0].benchmarkPolicyGuard),
    JSON.stringify(spawned[1].benchmarkPolicyGuard),
  );
  assert.equal(
    JSON.stringify(spawned[0].benchmarkPolicyGuard),
    JSON.stringify(built.policy.role_policy_guard['benchmark-reviewer']),
  );
  assert.notEqual(spawned[0].benchmarkLeaseState, spawned[1].benchmarkLeaseState);
});

it('keeps the lease state out of the role surface, so the role hash is a per-role constant', () => {
  const built = fixture();
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const trial = createTrialAdapter({
    policy: built.policy, config: built.config, slot: 'benchmark-reviewer',
    paths: preparePinnedTrialPaths(path.join(root, 'trial-home')),
    supervisor: { binary: path.join(root, 'supervisor'), graceMs: 1_000 },
    cwd: workspace,
  });
  const directive = trial.roleSurface.directiveSha256;
  const surfaceOf = () => roleSurfaceFromSpawnConfig(
    trial.spawnConfig, '', trial.spawnConfig.benchmarkPolicyGuard,
  );
  const before = surfaceOf();

  // The overlay LS4 performs, applied twice to the very config the surface is taken from.
  trial.spawnConfig.benchmarkLeaseState = 'thread-owned';
  const armed = surfaceOf();
  trial.spawnConfig.benchmarkLeaseState = 'parent-writable';
  const rearmed = surfaceOf();

  // No member of the surface names the selector — not the shape, and so not the hash either.
  const members = Object.keys(armed);
  assert.deepEqual(members, [
    'systemPromptSha256', 'directiveSha256', 'tools', 'pluginDirs', 'skills',
    'mcpComposition', 'hookPolicy', 'benchmarkPolicyGuard',
  ]);
  assert.deepEqual(members.filter(name => /lease/i.test(name)), []);
  assert.equal(JSON.stringify(armed), JSON.stringify(before));
  assert.equal(JSON.stringify(armed), JSON.stringify(rearmed));
  // The role hash therefore stays a per-role constant, and it is the compiled policy's own.
  assert.equal(computeRoleToolSurfaceHash(armed), computeRoleToolSurfaceHash(rearmed));
  assert.equal(
    computeRoleToolSurfaceHash({ ...armed, directiveSha256: directive }),
    built.policy.identity.role_tool_surface_hash['benchmark-reviewer'],
  );
});

// --- LS7: both backends carry the selector; only PI consumes it here ---

it('writes the spawn config selector into the PI lease-state variable', () => {
  const guard = { 'thread-owned': ['read'] };
  const env = buildPiEnv(
    { piAgentDir: '/tmp/pi-agent', policyGuard: guard, leaseState: 'thread-owned' }, {},
  );

  assert.equal(env[PI_LEASE_STATE_ENV], 'thread-owned');
  assert.equal(env[PI_POLICY_GUARD_ENV], JSON.stringify(guard));
  // The gate the child actually resolves reads that pair back and allows the listed tool.
  assert.equal(resolvePiToolGate(env).decide('read').allow, true);
});

it('falls back to the one-shot parent default when no selector is supplied', () => {
  const env = buildPiEnv(
    { piAgentDir: '/tmp/pi-agent', policyGuard: { 'parent-writable': ['read'] } }, {},
  );

  assert.equal(env[PI_LEASE_STATE_ENV], 'parent-writable');
});
