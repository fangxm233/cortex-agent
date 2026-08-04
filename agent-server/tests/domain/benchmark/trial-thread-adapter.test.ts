// input:  a compiled coder-review policy, per-step thread options and a capturing spawner
// output: field-by-field proof of which values survive the prepared-spawn-config fork
// pos:    Regression suite for the per-step trial adapter on the benchmark thread path
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. The seam under test is the adapter/options boundary, so nothing stands in for it: the
// real `createTrialAdapter` builds the adapter, the real `runWithAdapter` decides the fork, and the
// real `ClaudeAdapter.spawn` turns the resulting config into argv and an environment. The spy on
// `spawn` records the config and then calls the original — it observes the far side, it does not
// replace it. The only stand-in is the child process itself, which is downstream of the fork.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, it, vi } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent-adapter/claude/adapter.js';
import type {
  AgentProcessSpawner, AgentSpawnConfig, SpawnedAgentProcess,
} from '../../../src/agent-adapter/types.js';
import { runWithAdapter } from '../../../src/domain/agents/facade.js';
import type { RunAgentOptions } from '../../../src/domain/agents/spawn-config.js';
import { preparePinnedTrialPaths } from '../../../src/domain/agent-run/pinned-node-process.js';
import {
  createTrialAdapter, trialAgentConfig,
} from '../../../src/domain/benchmark/trial-adapter-factory.js';
import {
  createBenchmarkTrialRunAgent,
} from '../../../src/domain/benchmark/trial-thread-adapter.js';
import {
  compileTrialPolicy, FIXTURE_PROXY_BASE_URL, writeFixtureAsset, type TrialPolicyFixture,
} from './trial-thread-policy-fixture.js';

let root = '';
const spawned: AgentSpawnConfig[] = [];
const closedSessions: string[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-thread-'));
  spawned.length = 0;
  closedSessions.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A CLI artifact that exists and is executable; the spawner below never reaches it. */
function trialCli(): string {
  return writeFixtureAsset(root, 'bundle/trial-cli', '#!/bin/sh\nexit 0\n', 0o755);
}

function fixture(label = 'claude'): TrialPolicyFixture {
  return compileTrialPolicy({ root, backend: 'claude', cli: trialCli(), label });
}

interface SpawnRecord { command?: string; args?: string[]; env?: NodeJS.ProcessEnv; cwd?: string }

/** A child that answers one print-mode turn with the text the test names, so the run settles here
 *  rather than in a fixture that hard-codes a terminal string of its own. */
function respondingSpawner(record: SpawnRecord, text: string | null): AgentProcessSpawner {
  return (command, args, options) => {
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
    child.stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(String(chunk).split('\n')[0] || '{}');
      if (text !== null) {
        child.stdout.write(`${JSON.stringify({
          type: 'assistant',
          message: { id: 'a1', model: 'fixture-model', content: [{ type: 'text', text }] },
        })}\n`);
      }
      child.stdout.write(`${JSON.stringify({
        type: 'result', subtype: 'success', is_error: false,
        session_id: request.session_id ?? 'trial-session', result: text ?? '', num_turns: 1,
      })}\n`);
      setImmediate(() => child.emit('close', 0));
    });
    return { process: child } as unknown as SpawnedAgentProcess;
  };
}

/** Records every config that reaches the real adapter, then lets the real spawn run. */
function observeSpawnConfigs(): void {
  const original = ClaudeAdapter.prototype.spawn;
  vi.spyOn(ClaudeAdapter.prototype, 'spawn').mockImplementation(function (this: ClaudeAdapter, config) {
    spawned.push(config);
    return original.call(this, config);
  });
  const originalClose = ClaudeAdapter.prototype.close;
  vi.spyOn(ClaudeAdapter.prototype, 'close').mockImplementation(function (this: ClaudeAdapter, key) {
    closedSessions.push(String(key));
    return originalClose.call(this, key);
  });
}

function trialInput(built: TrialPolicyFixture) {
  return {
    policy: built.policy,
    config: built.config,
    paths: preparePinnedTrialPaths(path.join(root, 'trial-home')),
    supervisor: { binary: path.join(root, 'supervisor'), graceMs: 1_000 },
  };
}

/** The options the real step loop hands `runAgent` for one benchmark step. */
function stepOptions(overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  return {
    channel: 'benchmark:thread', sessionKey: 'thr:t1:benchmark-reviewer',
    sessionId: 'resume-me', threadId: 't1', profileName: 'benchmark-profile',
    benchmarkAgentSlot: 'benchmark-reviewer',
    cwd: workspace,
    // The per-slot surface the thread template carries; the policy's own role must win over it.
    systemPrompt: 'template system prompt', tools: 'Bash',
    mcpComposition: 'none', disableHooks: true, loadCortexRules: false,
    streamDeltas: false, captureTranscriptLogs: false, preserveUnreportedAccounting: true,
    recordCost: false,
    ...overrides,
  };
}

async function runOneStep(
  built: TrialPolicyFixture,
  options: RunAgentOptions,
  text: string | null = 'reviewer verdict',
): Promise<{ record: SpawnRecord; spawner: AgentProcessSpawner; result: any }> {
  const record: SpawnRecord = {};
  const spawner = respondingSpawner(record, text);
  const runAgent = createBenchmarkTrialRunAgent(trialInput(built));
  const handle = runAgent('review the change', { ...options, processSpawner: spawner });
  return { record, spawner, result: await handle.promise };
}

// --- The fork: which values survive into the spawn config the adapter is handed ---

it('carries every trial-isolation field and the step\'s own resume, cwd and spawner', async () => {
  observeSpawnConfigs();
  const built = fixture();
  const options = stepOptions();
  const guard = built.policy.role_policy_guard['benchmark-reviewer'];
  const role = built.policy.roles['benchmark-reviewer'];

  const { record, spawner } = await runOneStep(built, options);

  assert.equal(spawned.length, 1);
  const config = spawned[0];
  // Fields that exist only inside the factory's own option block.
  assert.equal(config.cliPath, built.policy.asset_inventory
    .find(asset => asset.kind === 'cli_artifact')!.resolved_path);
  assert.deepEqual(config.benchmarkPolicyGuard, guard);
  assert.equal(config.benchmarkDeadlineEpochMs, built.policy.deadline.absolute_epoch_ms);
  assert.deepEqual(config.mcpConfigPaths, role.mcpConfigPaths);
  assert.ok(config.pinnedEnv, 'the pinned trial environment did not survive the fork');
  assert.equal(config.pinnedEnv!.CORTEX_HOME, path.join(root, 'trial-home', 'cortex-home'));
  // The proxy authority enters only inside the factory.
  assert.equal(config.anthropicBaseUrl, FIXTURE_PROXY_BASE_URL);
  // Fields only the thread's own per-step options carry.
  assert.equal(config.sessionId, 'resume-me');
  assert.equal(config.resume, true);
  assert.equal(config.cwd, options.cwd);
  assert.equal(config.processSpawner, spawner, 'the lease-checking spawner did not survive the fork');
  // The per-slot surface is the compiled role's, never the template's projection.
  assert.equal(config.systemPrompt, fs.readFileSync(built.systemPromptOf('benchmark-reviewer'), 'utf8'));
  assert.equal(config.rawTools, role.tools.join(','));
  // The far side ran: the config became argv and an environment on the real spawn boundary.
  assert.equal(record.command, config.cliPath);
  assert.equal(record.cwd, options.cwd);
  assert.equal(record.env!.CORTEX_HOME, config.pinnedEnv!.CORTEX_HOME);
});

it('loses every trial-isolation field when the step options build the spawn config instead', () => {
  observeSpawnConfigs();
  const built = fixture();
  const options = stepOptions();
  const trial = createTrialAdapter({
    ...trialInput(built), slot: 'benchmark-reviewer', cwd: options.cwd!,
  });
  const record: SpawnRecord = {};

  // The other branch of the fork, executed for real: no prepared config, so `buildAgentSpawnConfig`
  // runs on the thread's own per-step options.
  const handle = runWithAdapter(
    trial.adapter, 'review the change',
    { ...options, processSpawner: respondingSpawner(record, 'reviewer verdict') },
    trialAgentConfig(built.policy, trial.backend), undefined,
  );
  handle.promise.catch(() => {});

  assert.equal(spawned.length, 1);
  const config = spawned[0];
  assert.equal(config.cliPath, undefined);
  assert.equal(config.pinnedEnv, undefined);
  assert.equal(config.benchmarkPolicyGuard, undefined);
  assert.equal(config.benchmarkDeadlineEpochMs, undefined);
  assert.equal(config.mcpConfigPaths, undefined);
  assert.notEqual(config.anthropicBaseUrl, FIXTURE_PROXY_BASE_URL);
  // The per-slot surface degrades to the template's projection rather than the compiled role.
  assert.equal(config.systemPrompt, 'template system prompt');
  assert.equal(config.rawTools, 'Bash');
  // What this branch does keep, and the only reason it is tempting.
  assert.equal(config.sessionId, 'resume-me');
  assert.equal(config.resume, true);
  assert.equal(config.cwd, options.cwd);
  assert.ok(config.processSpawner);
});

it('leaves the factory\'s own config without the step\'s resume target and spawner', () => {
  const built = fixture();
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const trial = createTrialAdapter({
    ...trialInput(built), slot: 'benchmark-reviewer', cwd: workspace,
  });

  // The prepared config is complete on the trial axis and empty on the per-step axis: taking it
  // unchanged would start every step as a fresh backend session with no admission boundary.
  assert.ok(trial.spawnConfig.cliPath);
  assert.ok(trial.spawnConfig.benchmarkPolicyGuard);
  assert.equal(trial.spawnConfig.sessionId, null);
  assert.equal(trial.spawnConfig.resume, false);
  assert.equal(trial.spawnConfig.processSpawner, undefined);
});

// --- One adapter per step ---

it('builds one adapter per step, in that step\'s own cwd, and closes each before the next', async () => {
  observeSpawnConfigs();
  const built = fixture();
  const first = path.join(root, 'shared');
  const second = path.join(root, 'snapshot');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const runAgent = createBenchmarkTrialRunAgent(trialInput(built));

  const one = runAgent('step one', {
    ...stepOptions({ cwd: first, benchmarkAgentSlot: 'benchmark-coder' }),
    processSpawner: respondingSpawner({}, 'coder done'),
  });
  await one.promise;
  const closedAfterFirstStep = closedSessions.length;
  const two = runAgent('step two', {
    ...stepOptions({ cwd: second, benchmarkAgentSlot: 'benchmark-reviewer' }),
    processSpawner: respondingSpawner({}, null),
  });
  await two.promise;

  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].cwd, first);
  assert.equal(spawned[1].cwd, second);
  // A reused adapter would carry the first step's cwd into the second.
  assert.notEqual(spawned[0].cwd, spawned[1].cwd);
  assert.equal(closedAfterFirstStep, 1, 'the first step\'s adapter was still open at the next step');
  assert.equal(closedSessions.length, 2);
});

// --- The refusals that keep the choke point single ---

it('refuses a benchmark step whose options carry no lease-checking spawner', () => {
  const built = fixture();
  const runAgent = createBenchmarkTrialRunAgent(trialInput(built));

  assert.throws(() => runAgent('review', stepOptions()), /spawner/i);
});

it('refuses a benchmark step that names no trial role', () => {
  const built = fixture();
  const runAgent = createBenchmarkTrialRunAgent(trialInput(built));

  assert.throws(
    () => runAgent('review', {
      ...stepOptions({ benchmarkAgentSlot: undefined }),
      processSpawner: respondingSpawner({}, 'x'),
    }),
    /role/i,
  );
});

it('refuses a benchmark step that names no workspace', () => {
  const built = fixture();
  const runAgent = createBenchmarkTrialRunAgent(trialInput(built));

  assert.throws(
    () => runAgent('review', {
      ...stepOptions({ cwd: undefined }),
      processSpawner: respondingSpawner({}, 'x'),
    }),
    /workspace|cwd/i,
  );
});

// --- The import obligation this module can actually carry ---

it('imports no adapter registry of its own', () => {
  const source = fs.readFileSync(
    path.resolve('src/domain/benchmark/trial-thread-adapter.ts'), 'utf8',
  );
  const specifiers = [...source.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map(match => match[1]);
  assert.ok(specifiers.length > 0);
  assert.equal(specifiers.some(specifier => /agent-adapter\/index\.js$/.test(specifier)), false);
});
