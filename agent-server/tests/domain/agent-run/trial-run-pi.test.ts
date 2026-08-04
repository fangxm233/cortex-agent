// input:  a PI-labelled trial policy, the real supervisor binary and a real PI-shaped child
// output: supervised spawn, quiescence, cancellation and deadline parity for the PI backend
// pos:    Run-level battery rows T1-T5 for the PI trial adapter
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. The far side of every assertion here is the real `cortex-supervisor` binary and a real
// child process — nothing is faked at the supervisor boundary. What this file does NOT re-prove is
// `classify` / `classifySupervisor` (runner.ts:547-571), which turn a supervision outcome into a
// terminal state: those are pure functions of the handle asserted here and are already proven for
// both backends by `trial-run.test.ts`. The reason this battery stops at the handle is manager note
// F8 N2 — `runOneShotAgent` compiles its policy, and a compiled PI arm is still refused with code
// 28 until the T15 prover flips the capability. See the PI construction suite's header note.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, it } from 'vitest';

import type { AgentProcessSpawner, AgentProcessSupervision } from '../../../src/agent-adapter/types.js';
import { preparePinnedTrialPaths } from '../../../src/domain/agent-run/pinned-node-process.js';
import { attachSupervisor, type SupervisorSession } from '../../../src/domain/agent-run/supervisor.js';
import { loadAgentRunConfigWithPolicy } from '../../../src/domain/agent-run/run-config.js';
import type { ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';
import {
  createTrialAdapter, type TrialAdapter, type TrialAdapterSpec,
} from '../../../src/domain/benchmark/trial-adapter-factory.js';
import { profileRepo } from '../../../src/store/profile-repo.js';

const installRoot = fileURLToPath(new URL('../../../', import.meta.url));
const supervisorBinary = path.join(installRoot, 'native/cortex-supervisor/dist/cortex-supervisor');
const CLI_VERSION = 'fixture-pi/9.9.9';

let root = '';

beforeAll(() => {
  const built = spawnSync('flock', [
    '-x', '/tmp/cortex-supervisor-build.lock', 'npm', 'run', 'build:supervisor',
  ], { cwd: installRoot, encoding: 'utf8' });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
}, 180_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-pi-run-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
  return file;
}

interface PiBehaviour {
  /** Never answer, so only the supervisor's cancel or deadline path can end the process. */
  hang?: boolean;
  /** Fork a long-lived grandchild that records its own pid, so quiescence has something to cover. */
  grandchildPidFile?: string;
}

/** A real PI-shaped child: it records what it was actually given and then behaves as asked. The
 *  pinned trial environment carries no test variables, so behaviour is baked into the source. */
function writePiCli(observation: string, behaviour: PiBehaviour): string {
  const script = path.join(root, 'bundle', 'pi-trial.mjs');
  write(script, `import fs from 'node:fs';
import { spawn } from 'node:child_process';
fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
  env: process.env, argv: process.argv.slice(2),
  pid: process.pid, ppid: process.ppid, cwd: process.cwd(),
}));
${behaviour.grandchildPidFile
    ? `spawn('/bin/sh', ['-c', 'echo $$ > ${JSON.stringify(behaviour.grandchildPidFile)}; sleep 30'], { stdio: 'ignore' }).unref();`
    : ''}
${behaviour.hang ? 'setInterval(() => {}, 1000);' : 'setTimeout(() => process.exit(0), 150);'}
`);
  return write(
    path.join(root, 'bundle', 'pi-trial'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    0o755,
  );
}

function writeProfile(): void {
  write(path.join(process.env.CORTEX_HOME as string, 'config', 'profiles.json'), JSON.stringify({
    defaultProfile: 'benchmark-profile',
    profiles: {
      'benchmark-profile': {
        model: 'claude-sonnet', backend: 'claude', mode: 'api', provider: 'anthropic',
        extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: 'high', fallback: [],
      },
    },
  }));
  profileRepo.invalidate();
}

function armResolution(cli: string): Record<string, unknown> {
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
    trial_id: 'trial-001', root_run_id: 'trial-001.cortex-direct',
    task: {
      task_id: 'terminal-task', image_ref: 'registry.invalid/task@sha256:fixture',
      image_digest: `sha256:${'a'.repeat(64)}`,
    },
    profile_name: 'benchmark-profile', paid_run: false,
    credential_capabilities: [{
      id: 'claude-api-key', state: 'offline-contract-passed',
      key: {
        runner_or_backend: 'claude', provider: 'anthropic', protocol: 'anthropic-messages',
        credential_kind: 'api-key-bearer', proxy_adapter_version: 'cortex-bench-trial-proxy/1',
      },
    }],
    credential: {
      upstream_base_url: 'https://api.anthropic.com', route_identity_host: 'api.anthropic.com',
      proxy_base_url: 'http://127.0.0.1:49152', dummy_token_ref: 'trial-token-handle',
    },
    cli_artifact: { path: cli, version: CLI_VERSION },
    model_alias_policy: { kind: 'exact' },
    roles: {
      parent: {
        system_prompt_path: write(path.join(root, 'parent-system.txt'), 'You are the benchmark parent.\n'),
        directive_path: write(path.join(root, 'parent-directive.txt'), 'Solve the task.\n'),
        tools: ['Read', 'Write'], plugin_dirs: [], mcp_composition: 'none',
        mcp_config_paths: [write(path.join(root, 'mcp-empty.json'), '{"mcpServers":{}}\n')],
        disable_hooks: true,
        benchmark_policy_guard: { 'parent-writable': ['read', 'grep'] },
      },
    },
    thread_templates: {}, thread_agents: {},
    artifact_inventory_spec: { expected: ['stdout', 'stderr', 'manifest'] },
  };
}

interface Fixture {
  trial: TrialAdapter;
  observation: string;
  workspace: string;
  kill(): boolean;
  session(): SupervisorSession;
  supervision(): AgentProcessSupervision;
}

/** Build a PI trial and spawn it under the real supervisor, exactly as `supervisedSpawner`
 *  (runner.ts:489) does: the session is captured, and the handle it produces is what the adapter
 *  surfaces on its process. */
function piTrial(behaviour: PiBehaviour = {}, deadlineMs?: number): Fixture {
  writeProfile();
  const observation = path.join(root, 'pi-observation.json');
  const cli = writePiCli(observation, behaviour);
  const runConfigFile = write(path.join(root, 'arm-resolution.json'), JSON.stringify(armResolution(cli)));
  const loaded = loadAgentRunConfigWithPolicy({ runConfigFile, agentSlot: 'parent' });
  const policy = structuredClone(loaded.policy!) as any;
  policy.arm.backend = 'pi';
  policy.pi_benchmark_capability_proven = true;
  policy.model_execution.backend = 'pi';
  policy.model_execution.cli_name = 'pi';

  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const spec: TrialAdapterSpec = {
    policy: policy as ResolvedTrialPolicy,
    slot: 'parent',
    config: loaded.config,
    paths: preparePinnedTrialPaths(path.join(root, 'trial-home')),
    supervisor: { binary: supervisorBinary, graceMs: 200, deadlineMs },
    cwd: workspace,
  };
  const trial = createTrialAdapter(spec);

  let captured: SupervisorSession | null = null;
  const spawner: AgentProcessSpawner = (command, args, options) => {
    captured = attachSupervisor({
      binary: supervisorBinary,
      args: [command, ...args],
      graceMs: 200,
      deadlineMs,
      cwd: options.cwd?.toString(),
      env: options.env,
      stdio: 'pipe',
    });
    return {
      process: captured.process as never,
      supervision: captured as unknown as AgentProcessSupervision,
    };
  };
  trial.spawnConfig.processSpawner = spawner;
  const proc = trial.adapter.spawn(trial.spawnConfig);
  assert.ok(proc.supervision, 'PI surfaced no supervision handle (P1)');
  return {
    trial,
    observation,
    workspace,
    kill: () => proc.kill(),
    session: () => captured!,
    supervision: () => proc.supervision!,
  };
}

function observed(built: Fixture): { argv: string[]; ppid: number; cwd: string; env: Record<string, string> } {
  return JSON.parse(fs.readFileSync(built.observation, 'utf8'));
}

async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await delay(10);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// --- T1: the PI process is a child of the supervisor session ---

it('runs the policy PI binary under the real supervisor (T1)', async () => {
  const built = piTrial();
  const started = await built.supervision().started;
  assert.ok(started.pid > 0);
  assert.ok(started.pgid > 0);
  await built.supervision().exited;

  const record = observed(built);
  // The supervisor spawned it, so its parent is not this test process.
  assert.notEqual(record.ppid, process.pid);
  assert.equal(record.cwd, fs.realpathSync(built.workspace));
  // The binary that actually ran is the policy's artifact, in PI's RPC mode.
  assert.ok(record.argv.includes('--mode'));
  assert.ok(record.argv.includes('rpc'));
  await built.supervision().dispose();
}, 60_000);

// --- T2: the trial closes the session it opened, and no module singleton keeps one ---

it('closes exactly its own PI session (T2)', async () => {
  const built = piTrial();
  await built.supervision().started;
  assert.deepEqual(built.trial.adapter.listSessions(), [built.trial.spawnConfig.sessionKey]);
  await built.supervision().exited;
  await built.trial.close();
  assert.deepEqual(built.trial.adapter.listSessions(), []);
  await built.supervision().dispose();
}, 60_000);

// --- T3: quiescence covers a descendant PI left behind ---

it('proves quiescence over a descendant the PI process forked (T3)', async () => {
  const pidFile = path.join(root, 'grandchild.pid');
  const built = piTrial({ grandchildPidFile: pidFile });
  await built.supervision().started;
  await waitForFile(pidFile);
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(grandchild > 0);

  await built.supervision().exited;
  built.supervision().cancel('cancel');
  await built.supervision().quiescent;
  // The descendant asked for 30s; quiescence must not have resolved while it was alive.
  assert.equal(processAlive(grandchild), false, `descendant ${grandchild} outlived quiescence`);
  await built.supervision().dispose();
}, 60_000);

// --- T4: cancellation parity ---

it('cancels a hanging PI process through the supervisor (T4)', async () => {
  const built = piTrial({ hang: true });
  await built.supervision().started;
  await waitForFile(built.observation);
  assert.equal(built.kill(), true);
  const closed = await built.supervision().closed;
  // The same handle members `classifySupervisor` reads for exit 130 / state 'cancelled'.
  assert.equal(closed.code, 130, JSON.stringify(closed));
  await built.supervision().quiescent;
  await built.supervision().dispose();
}, 60_000);

// --- T5: deadline parity ---

it('ends a PI process that outlives its deadline through the supervisor (T5)', async () => {
  const built = piTrial({ hang: true }, 700);
  await built.supervision().started;
  const closed = await built.supervision().closed;
  // The same handle members `classifySupervisor` reads for exit 124 / state 'timeout'.
  assert.equal(closed.code, 124, JSON.stringify(closed));
  await built.supervision().quiescent;
  await built.supervision().dispose();
}, 60_000);

// --- T11 far side: the PI process really wrote only under the trial root ---

it('confines the running PI process to the trial root (T11)', async () => {
  const built = piTrial();
  await built.supervision().exited;
  const record = observed(built);
  const trialRoot = fs.realpathSync(path.join(root, 'trial-home'));
  assert.equal(record.env.HOME.startsWith(trialRoot), true, record.env.HOME);
  assert.equal(record.env.PI_CODING_AGENT_DIR.startsWith(trialRoot), true, record.env.PI_CODING_AGENT_DIR);
  assert.equal(record.env.SLACK_BOT_TOKEN, undefined);
  assert.equal(record.env.ANTHROPIC_API_KEY, undefined);
  await built.supervision().dispose();
}, 60_000);
