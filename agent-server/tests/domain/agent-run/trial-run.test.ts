// input:  a compiled arm resolution, the real supervisor and a generated backend CLI
// output: end-to-end proof that a trial run is supervised, isolated, normalized and composite-published
// pos:    Run-level battery for the Gate-2 trial adapter seam
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeAll, beforeEach, it, vi } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent-adapter/claude/adapter.js';
import { PINNED_RUNTIME_PATH } from '../../../src/domain/agent-run/pinned-node-process.js';
import { loadAgentRunConfigWithPolicy } from '../../../src/domain/agent-run/run-config.js';
import {
  deriveSubagentLinks, runOneShotAgent, type AgentRunIo,
} from '../../../src/domain/agent-run/runner.js';
import type { AgentRunCliOptions } from '../../../src/domain/agent-run/agent-run-cli.js';
import type { ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';
import { profileRepo } from '../../../src/store/profile-repo.js';
import {
  COMPOSITE_MANIFEST_KEYS, COMPOSITE_MANIFEST_SCHEMA_VERSION, canonicalCompositeManifestBytes,
  checkIdsForMode, validateCompositeManifest,
} from '../../../src/domain/benchmark/composite-manifest.js';
import {
  ATTEMPT_EDGE_KINDS, ATTEMPT_RECORD_KEYS, mintAttemptId,
  type AttemptEdge, type AttemptRecord,
} from '../../../src/domain/benchmark/attempt-record.js';
import {
  writeStartedMarker, writeTerminalManifest,
} from '../../../src/domain/agent-run/manifest.js';
import { createHash } from 'node:crypto';
import { BENCHMARK_FAILURES } from '../../../src/domain/benchmark/resolved-policy.js';
import {
  mergeTrajectory, TrajectoryMergeError,
} from '../../../src/domain/agent-run/trajectory-merge.js';

const installRoot = fileURLToPath(new URL('../../../', import.meta.url));
const supervisorBinary = path.join(installRoot, 'native/cortex-supervisor/dist/cortex-supervisor');
const CLI_VERSION = 'fixture-claude/9.9.9';
const ROOT_RUN_ID = 'trial-001.cortex-direct';

let root = '';
/** Overridden only by the lease-echo test, which needs a listener that answers the control route. */
let proxyBaseUrl = 'http://127.0.0.1:49152';

beforeAll(() => {
  const built = spawnSync('flock', [
    '-x', '/tmp/cortex-supervisor-build.lock', 'npm', 'run', 'build:supervisor',
  ], { cwd: installRoot, encoding: 'utf8' });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
}, 120_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-run-'));
  proxyBaseUrl = 'http://127.0.0.1:49152';
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface BackendBehaviour {
  /** Never answer, so the supervisor's deadline or cancel path is the only way out. */
  hang?: boolean;
  /** Fork a long-lived grandchild that records its own pid before sleeping. */
  grandchildPidFile?: string;
  /** Report provider usage, so the session's resolved context window becomes observable. */
  reportUsage?: boolean;
  /**
   * Emit a NATIVE subagent tool call and no `subagent_activity` attesting it — the OC-11
   * invisibility case. `name` is `Agent` or `Task`: the CLI declares both for one tool, so a census
   * keyed on `Agent` alone passes vacuously on the alias (G4-SA12).
   */
  nativeSubagentCall?: { id: string; name: string };
  /**
   * Report BOTH usage and a turn cost, so the adapter emits a complete `cost_record`. §9.6 A5
   * forbids the merge from treating a missing counter as zero, so without this the trajectory merge
   * correctly refuses with `aggregate_metrics_underivable` and F8 publishes no tree.
   */
  accounted?: boolean;
  /**
   * Emit the `thread_run` tool call — and its successful result — that a parent which admitted a
   * pipeline thread really makes. §9.3 M1's link map is keyed on that call id, so a seeded child
   * with no call in the parent's journal is a shape production cannot produce.
   */
  threadRunCall?: { id: string; threadId: string };
}

interface Fixture {
  options: AgentRunCliOptions;
  policy: ResolvedTrialPolicy;
  trialRoot: string;
  observation: string;
  workspace: string;
}

function write(file: string, content: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
  return file;
}

/** A real backend process: it records the environment and argv it was actually given, writes into
 *  its own `$HOME`, and speaks just enough stream-json for one turn. Behaviour is baked into the
 *  source because the pinned trial environment carries no test variables into the child. */
function writeBackendCli(file: string, observation: string, behaviour: BackendBehaviour): string {
  const script = path.join(root, 'bundle', 'claude-trial.mjs');
  write(script, `import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
  env: process.env, argv: process.argv.slice(2),
  pid: process.pid, ppid: process.ppid, cwd: process.cwd(),
}));
fs.writeFileSync(process.env.HOME + '/backend-wrote-here', 'trial');
${behaviour.grandchildPidFile
    ? `spawn('/bin/sh', ['-c', 'echo $$ > ${JSON.stringify(behaviour.grandchildPidFile)}; sleep 30'], { stdio: 'ignore' }).unref();`
    : ''}
${behaviour.hang
    ? 'setInterval(() => {}, 1000);'
    : `const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.once('line', (line) => {
  const request = JSON.parse(line);
${behaviour.reportUsage || behaviour.accounted
    ? `  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-reported-trial', usage: { input_tokens: 1000, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } }));`
    : ''}
${behaviour.nativeSubagentCall
    ? `  console.log(JSON.stringify({ type: 'assistant', message: { id: 'a0', model: 'claude-reported-trial', content: [{ type: 'tool_use', id: ${JSON.stringify(behaviour.nativeSubagentCall.id)}, name: ${JSON.stringify(behaviour.nativeSubagentCall.name)}, input: {} }] } }));`
    : ''}
${behaviour.threadRunCall
    ? `  console.log(JSON.stringify({ type: 'assistant', message: { id: 'a2', model: 'claude-reported-trial', content: [{ type: 'tool_use', id: ${JSON.stringify(behaviour.threadRunCall.id)}, name: 'thread_run', input: { action: 'start' } }] } }));
  console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: ${JSON.stringify(behaviour.threadRunCall.id)}, is_error: false, content: ${JSON.stringify(JSON.stringify({ thread_id: behaviour.threadRunCall.threadId, state: 'completed' }))} }] } }));`
    : ''}
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'a1', model: 'claude-reported-trial', content: [{ type: 'text', text: 'trial reply' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: request.session_id, result: 'trial reply', num_turns: 1${behaviour.accounted ? ", total_cost_usd: 0.0025, usage: { input_tokens: 1000, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }" : ''} }));
  lines.close();
});`}
`);
  return write(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, 0o755);
}

/** The fake supervisor selects its lifecycle mode from the environment, and the pinned trial
 *  environment carries no test variables, so the mode is baked into the launcher. */
function installFakeSupervisor(mode: string): string {
  const compiled = path.join(root, 'bin', 'fake-supervisor.mjs');
  write(compiled, ts.transpileModule(
    fs.readFileSync(fileURLToPath(new URL('./fake-supervisor.ts', import.meta.url)), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText);
  return write(
    path.join(root, 'bin', 'cortex-supervisor'),
    `#!/bin/sh\nFAKE_SUPERVISOR_MODE=${mode} exec ${JSON.stringify(process.execPath)} `
    + `${JSON.stringify(compiled)} "$@"\n`,
    0o755,
  );
}

function writeProfile(): void {
  write(path.join(process.env.CORTEX_HOME as string, 'config', 'profiles.json'), JSON.stringify({
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

type ArmMode = 'direct' | 'coder-review';

function armResolution(cli: string, mode: ArmMode = 'direct'): Record<string, unknown> {
  const coderReview = mode === 'coder-review';
  // §1.3 rule 7 keeps BOTH task limits at 0 for every non-manager mode, and `arm-schema.ts`
  // requires `max_thread_starts` to be exactly 1 for coder-review and 0 otherwise.
  const parentRole = {
    system_prompt_path: write(path.join(root, 'parent-system.txt'), 'You are the benchmark parent.\n'),
    directive_path: write(path.join(root, 'parent-directive.txt'), 'Solve the task.\n'),
    tools: ['Read', 'Write'],
    plugin_dirs: [],
    mcp_composition: 'none',
    mcp_config_paths: [write(path.join(root, 'mcp-empty.json'), '{"mcpServers":{}}\n')],
    disable_hooks: true,
  };
  const templateDir = path.join(installRoot, 'defaults/config/thread-templates');
  return {
    schema_version: 'cortex-benchmark-arm-resolution/1',
    arm: {
      schema_version: 'cortex-benchmark-arm/2',
      kind: 'cortex', name: 'cortex-direct', backend: 'claude', provider: 'anthropic',
      model: 'claude-sonnet', credential_capability: 'claude-api-key',
      orchestration: coderReview
        ? { mode: 'coder-review', coder_review_variant: 'audit-retry', ask_manager: false }
        : { mode: 'direct', ask_manager: false },
      limits: {
        max_thread_starts: coderReview ? 1 : 0,
        max_parent_questions: 0, max_task_depth: 0, max_tasks: 0,
        max_provider_requests: 8, max_resident_agent_processes: 3, max_cost_usd: '2.50',
        deadline_seconds: 90,
      },
    },
    arm_path: '/harness/arms/cortex-direct.yaml',
    trial_id: 'trial-001',
    root_run_id: ROOT_RUN_ID,
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
        credential_kind: 'api-key-bearer', proxy_adapter_version: 'cortex-bench-trial-proxy/2',
      },
    }],
    credential: {
      upstream_base_url: 'https://api.anthropic.com',
      route_identity_host: 'api.anthropic.com',
      proxy_base_url: proxyBaseUrl,
      dummy_token_ref: 'trial-token-handle',
    },
    cli_artifact: { path: cli, version: CLI_VERSION },
    model_alias_policy: { kind: 'exact' },
    roles: coderReview
      ? {
          parent: parentRole,
          // The role-slot vocabulary is CLOSED; these are the two the template names.
          'benchmark-coder': structuredClone(parentRole),
          'benchmark-reviewer': structuredClone(parentRole),
        }
      : { parent: parentRole },
    thread_templates: coderReview
      ? {
          'benchmark-coder-review':
            path.join(templateDir, 'templates/benchmark-coder-review.json'),
        }
      : {},
    thread_agents: coderReview
      ? {
          'benchmark-coder': path.join(templateDir, 'agents/benchmark-coder.json'),
          'benchmark-reviewer': path.join(templateDir, 'agents/benchmark-reviewer.json'),
        }
      : {},
    artifact_inventory_spec: { expected: ['stdout', 'stderr', 'manifest'] },
  };
}

function fixture(
  behaviour: BackendBehaviour = {}, deadlineMs?: number, mode: ArmMode = 'direct',
): Fixture {
  writeProfile();
  const observation = path.join(root, 'backend-observation.json');
  const cli = writeBackendCli(path.join(root, 'bundle', 'claude-trial'), observation, behaviour);
  const runConfigFile = write(
    path.join(root, 'arm-resolution.json'), JSON.stringify(armResolution(cli, mode)),
  );
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const agentDir = path.join(root, 'agent');
  const options: AgentRunCliOptions = {
    promptFile: write(path.join(root, 'prompt.txt'), 'finish the trial\n'),
    agentSlot: 'parent',
    profile: 'benchmark-profile',
    cwd: workspace,
    outputFormat: 'jsonl',
    eventsFile: path.join(agentDir, 'trajectory', 'events.jsonl'),
    trajectoryRoot: path.join(agentDir, 'trajectory'),
    runConfigFile,
    supervisorBinary,
    deadlineMs,
    graceMs: 200,
    rootRunId: ROOT_RUN_ID,
  };
  fs.mkdirSync(options.trajectoryRoot, { recursive: true });
  const policy = loadAgentRunConfigWithPolicy({ runConfigFile, agentSlot: 'parent' }).policy!;
  return { options, policy, trialRoot: path.join(agentDir, 'trial-home'), observation, workspace };
}

interface RunOutcome {
  exitCode: number;
  stdout: Record<string, any>[];
  stderr: string;
  terminal: Record<string, any>;
}

function collectingIo(lines: string[], errors: string[]): AgentRunIo {
  return {
    stdout: { write: (chunk: string) => { lines.push(chunk); return true; } },
    stderr: { write: (chunk: string) => { errors.push(chunk); return true; } },
  };
}

async function runTrial(built: Fixture): Promise<RunOutcome> {
  const lines: string[] = [];
  const errors: string[] = [];
  const exitCode = await runOneShotAgent(built.options, collectingIo(lines, errors));
  const stdout = lines.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { exitCode, stdout, stderr: errors.join(''), terminal: stdout.at(-1)! };
}

function observed(built: Fixture): {
  env: Record<string, string>; argv: string[]; pid: number; ppid: number; cwd: string;
} {
  return JSON.parse(fs.readFileSync(built.observation, 'utf8'));
}

async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await delay(10);
  }
}

function terminalManifest(built: Fixture): Record<string, any> {
  return JSON.parse(fs.readFileSync(
    path.join(built.options.trajectoryRoot, `run-${ROOT_RUN_ID}.terminal.json`), 'utf8',
  ));
}

function journalRecords(built: Fixture): Record<string, any>[] {
  return fs.readFileSync(built.options.eventsFile, 'utf8').trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line));
}

// --- T1: the backend process is a child of the supervisor session ---

it('runs the policy CLI under the real supervisor (T1)', async () => {
  const built = fixture();
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(outcome.terminal.state, 'completed');
  const record = observed(built);
  // The supervisor spawns the backend, so the backend's parent is not this test process.
  assert.notEqual(record.ppid, process.pid);
  assert.equal(record.cwd, fs.realpathSync(built.workspace));
  // C2 far side: the process that actually ran is the policy's CLI, not a PATH lookup of `claude`.
  assert.ok(record.argv.includes('--strict-mcp-config'));
  assert.equal(outcome.terminal.manifest.supervisor.quiescent, true);
  // T2 far side: the trial closed the session it really opened. Claude sessions are registered in
  // a module-level map, so a session the trial leaked would still be visible from here.
  assert.equal(new ClaudeAdapter().listSessions().includes(`agent-run:${ROOT_RUN_ID}`), false);
}, 60_000);

it('does not probe a PATH-resolved Claude version when the policy pins one (C3)', async () => {
  const built = fixture();
  const marker = path.join(root, 'unexpected-version-probe');
  const probeDir = path.join(root, 'probe-bin');
  write(
    path.join(probeDir, 'claude'),
    `#!/bin/sh\nprintf probed > ${JSON.stringify(marker)}\nexit 1\n`,
    0o755,
  );
  const savedPath = process.env.PATH;
  let outcome: RunOutcome;
  try {
    process.env.PATH = probeDir;
    outcome = await runTrial(built);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(
    outcome.stdout[0].model_execution_identity_hash,
    built.policy.identity.model_execution_identity_hash.parent,
  );
}, 60_000);

// --- T3: quiescence covers descendants the backend leaves behind ---

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

it('proves quiescence over a descendant the backend forked (T3)', async () => {
  const pidFile = path.join(root, 'grandchild.pid');
  const built = fixture({ grandchildPidFile: pidFile });
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(outcome.terminal.state, 'completed');
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(grandchild > 0);
  // The descendant asked for 30s. The run must not have returned while it was still alive.
  assert.equal(processAlive(grandchild), false, `descendant ${grandchild} outlived the trial`);
  assert.equal(outcome.terminal.manifest.supervisor.quiescent, true);
}, 60_000);

it('classifies a supervisor that never proves quiescence as a containment failure (T3)', async () => {
  const built = fixture();
  built.options.supervisorBinary = installFakeSupervisor('no-quiescent');
  const outcome = await runTrial(built);
  assert.equal(outcome.terminal.state, 'failed');
  assert.equal(outcome.terminal.terminal_reason, 'containment_failure');
  assert.equal(outcome.terminal.manifest, null);
  assert.notEqual(outcome.exitCode, 0);
}, 60_000);

// --- T4: cancellation parity ---

it('classifies an interrupted trial as cancelled with exit 130 (T4)', async () => {
  const built = fixture({ hang: true });
  // Emitting the event drives the runner's own handler without signalling the worker. The test
  // harness installs its own SIGINT cleanup, which would exit the worker, so it is detached for
  // exactly the length of the emit and restored afterwards.
  const harness = process.listeners('SIGINT') as Array<(...args: any[]) => void>;
  const run = runTrial(built);
  await waitForFile(built.observation);
  await delay(50);
  assert.equal(process.listenerCount('SIGINT'), harness.length + 1);
  try {
    for (const listener of harness) process.removeListener('SIGINT', listener);
    process.emit('SIGINT');
  } finally {
    for (const listener of harness) process.once('SIGINT', listener);
  }
  const outcome = await run;
  assert.equal(outcome.exitCode, 130, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(outcome.terminal.state, 'cancelled');
  assert.equal(outcome.terminal.terminal_reason, 'cancelled');
  assert.equal(outcome.terminal.manifest.supervisor.quiescent, true);
  assert.equal(process.listenerCount('SIGINT'), harness.length);
}, 60_000);

// --- T5: deadline parity ---

it('classifies a trial that outlives its deadline as a timeout (T5)', async () => {
  const built = fixture({ hang: true }, 700);
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 124, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(outcome.terminal.state, 'timeout');
  assert.equal(outcome.terminal.terminal_reason, 'deadline');
}, 60_000);

// --- T11: trial-local state ---

it('confines the backend to the trial root and drops host leaks (T11, C5, C7)', async () => {
  const saved = { ...process.env };
  process.env.SLACK_BOT_TOKEN = 'xoxb-host-secret';
  process.env.ANTHROPIC_API_KEY = 'sk-host-secret';
  let built: Fixture;
  let outcome: RunOutcome;
  try {
    built = fixture();
    outcome = await runTrial(built);
  } finally {
    for (const key of ['SLACK_BOT_TOKEN', 'ANTHROPIC_API_KEY']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  const { env } = observed(built);
  const trialRoot = fs.realpathSync(built.trialRoot);
  for (const key of ['HOME', 'CORTEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'CLAUDE_CONFIG_DIR', 'TMPDIR', 'CORTEX_PROJECTS_DIR']) {
    assert.equal(
      path.resolve(env[key]).startsWith(`${trialRoot}${path.sep}`), true,
      `${key}=${env[key]} escaped ${trialRoot}`,
    );
  }
  assert.equal(env.PATH, PINNED_RUNTIME_PATH);
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.SLACK_CHANNEL, undefined);
  assert.equal(env.FEISHU_CHANNEL, undefined);
  // C6 far side: the child is routed at the policy proxy, never the host profile's base URL.
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:49152');
  // The write the backend really performed landed inside the trial root.
  assert.equal(fs.existsSync(path.join(built.trialRoot, 'home', 'backend-wrote-here')), true);
}, 60_000);

// --- A15: settings the session reads come from the trial config dir, not the host ---

it('resolves the context window from the trial config dir, not the host (A15)', async () => {
  const built = fixture({ reportUsage: true });
  // Both values are in the CLI's accepted range and below the model window, so whichever file the
  // session read is legible in the window it reports.
  write(path.join(built.trialRoot, 'claude-config', 'settings.json'),
    JSON.stringify({ autoCompactWindow: 150_000 }));
  const hostConfig = path.join(root, 'host-claude-config');
  write(path.join(hostConfig, 'settings.json'), JSON.stringify({ autoCompactWindow: 100_000 }));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  let outcome: RunOutcome;
  try {
    process.env.CLAUDE_CONFIG_DIR = hostConfig;
    outcome = await runTrial(built);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  const usage = journalRecords(built)
    .map(record => record.event).filter(event => event?.type === 'context_usage');
  assert.equal(usage.length > 0, true, 'no context_usage event was journalled');
  // 100_000 here would mean the session fell through to the ambient CLAUDE_CONFIG_DIR.
  assert.deepEqual([...new Set(usage.map(record => record.contextWindow))], [150_000]);
}, 60_000);

// --- T13: normalized identity ---

it('attributes the run to the policy identities it was compiled with (T13, R1, R4)', async () => {
  const built = fixture();
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  const header = outcome.stdout[0];
  const slot = built.policy.identity;
  assert.equal(header.role_tool_surface_hash, slot.role_tool_surface_hash.parent);
  assert.equal(header.model_execution_identity_hash, slot.model_execution_identity_hash.parent);
  const manifest = terminalManifest(built);
  assert.equal(manifest.role_tool_surface_hash, slot.role_tool_surface_hash.parent);
  assert.equal(manifest.model_execution_identity_hash, slot.model_execution_identity_hash.parent);
  const events = journalRecords(built).slice(1);
  assert.ok(events.length > 0);
  assert.deepEqual([...new Set(events.map(record => record.backend))], ['claude']);
  assert.deepEqual([...new Set(events.map(record => record.requested_model))], ['claude-sonnet']);
}, 60_000);

it('uses policy identity and event metadata when the pre-compile profile disagrees (S2)', async () => {
  const built = fixture();
  const compiledProfiles = structuredClone(profileRepo.readSync()) as any;
  const ambientProfiles = structuredClone(compiledProfiles);
  Object.assign(ambientProfiles.profiles['benchmark-profile'], {
    model: 'claude-opus',
    provider: 'ambient-provider',
    thinking: 'low',
    extraOption: { '--ambient-only': 'true' },
  });
  const readProfiles = vi.spyOn(profileRepo, 'readSync')
    .mockImplementationOnce(() => ambientProfiles)
    .mockImplementation(() => compiledProfiles);
  let outcome: RunOutcome;
  try {
    outcome = await runTrial(built);
  } finally {
    readProfiles.mockRestore();
  }
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(
    outcome.stdout[0].model_execution_identity_hash,
    built.policy.identity.model_execution_identity_hash.parent,
  );
  const events = journalRecords(built).slice(1);
  assert.deepEqual([...new Set(events.map(record => record.provider))], ['anthropic']);
  assert.deepEqual([...new Set(events.map(record => record.requested_model))], ['claude-sonnet']);
}, 60_000);

// With correct code the compiled role and the spawned role cannot disagree — that is what R4 is
// for. The branch is therefore proven by injecting the defect class it guards against: the bytes
// the compiler hashed and the bytes the spawn surface is built from stop agreeing.
it('refuses a run whose spawned role diverges from the compiled role (R4)', async () => {
  const built = fixture();
  const directive = path.join(root, 'parent-directive.txt');
  const original = fs.readFileSync(directive);
  let reads = 0;
  const readFileSync = fs.readFileSync;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, options: any) => {
    if (String(file) === directive && reads++ > 0) {
      return options ? 'Solve a different task.\n' : Buffer.from('Solve a different task.\n');
    }
    return readFileSync(file, options);
  }) as typeof fs.readFileSync);
  let outcome: RunOutcome;
  try {
    outcome = await runTrial(built);
  } finally {
    spy.mockRestore();
    fs.writeFileSync(directive, original);
  }
  assert.ok(reads >= 2, `directive was read ${reads} times`);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.terminal.state, 'failed');
  assert.equal(outcome.terminal.terminal_reason, 'protocol_violation');
  assert.match(outcome.stderr, /Role surface hash mismatch for slot 'parent'/);
  // Fail-closed: no backend process was admitted.
  assert.equal(fs.existsSync(built.observation), false);
}, 60_000);

// --- T14: normalized usage ---

it('reports unavailable accounting as null rather than zero (T14, R5)', async () => {
  const built = fixture();
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  const manifest = terminalManifest(built);
  assert.equal(manifest.cost_usd, null);
  assert.deepEqual(manifest.tokens, { input: null, output: null });
  assert.equal(manifest.steps, 1);
}, 60_000);

// --- T15: the credential lease is echoed before the model process is admitted ---

interface EchoCapture {
  method: string;
  target: string;
  authorization: string | undefined;
  body: string;
  modelWasAdmitted: boolean;
}

async function leaseEchoListener(
  captures: EchoCapture[], observation: string,
): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      captures.push({
        method: request.method ?? '', target: request.url ?? '',
        authorization: request.headers.authorization, body,
        // The backend fixture writes this file the instant it starts, so its absence here is the
        // ordering proof rather than a timing guess.
        modelWasAdmitted: fs.existsSync(observation),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true, lease_state: 'reconciled', armed_remaining_ms: 60_000,
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

it('echoes the trial lease to the proxy before any model process is admitted (T15)', async () => {
  const captures: EchoCapture[] = [];
  const observation = path.join(root, 'backend-observation.json');
  const listener = await leaseEchoListener(captures, observation);
  proxyBaseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  let outcome: RunOutcome;
  const built = fixture();
  try {
    outcome = await runTrial(built);
  } finally {
    await new Promise<void>(resolve => { listener.close(() => resolve()); });
  }
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].method, 'POST');
  assert.equal(captures[0].target, '/_cortex/lease-echo');
  assert.equal(captures[0].authorization, 'Bearer trial-token-handle');
  assert.equal(captures[0].modelWasAdmitted, false);
  assert.equal(fs.existsSync(built.observation), true);
  const document = JSON.parse(captures[0].body);
  assert.equal(document.trial_id, 'trial-001');
  // The two instants are the container's own compile reads; only their difference — the arm's
  // declared budget — and `remaining_ms` cross to the host.
  assert.equal(document.absolute_epoch_ms - document.compiled_at_epoch_ms, 90_000);
  assert.ok(document.remaining_ms > 0 && document.remaining_ms <= 90_000);
}, 60_000);

it('runs the trial to completion when the lease echo cannot be delivered (T15)', async () => {
  const built = fixture();
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(outcome.terminal.state, 'completed');
  assert.match(outcome.stderr, /lease echo unavailable/);
}, 60_000);

// --- T16: F7/F8 — the composite manifest has a PRODUCER ON THE PRODUCTION PATH ---
//
// G4-PB7. Nothing below hands the runner a pre-built object. `fixture()` writes a real arm
// document, the SHIPPED `loadAgentRunConfigWithPolicy` compiles it, and `runTrial` drives the real
// `runOneShotAgent` — the same five-link chain G4-PB3 names, with no test helper, subclass or
// monkeypatch supplying what production must compose. The manifest is observed through the file F8
// publishes, which is the design's own acceptance surface (design:2817-2818), not through a spy.
// Before this wave the trajectory merge had NO production writer at all (§17 17.4.2).

it('publishes a valid composite manifest from inside runOneShotAgent (T16)', async () => {
  const built = fixture();
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);

  const published = path.join(built.options.trajectoryRoot, 'composite-manifest.json');
  assert.equal(fs.existsSync(published), true, 'F8 published no composite manifest');
  const bytes = fs.readFileSync(published);
  const manifest = JSON.parse(bytes.toString('utf8'));

  // Eleven top-level members, in declaration order (G4-CM1, count ruled by enumeration).
  assert.deepEqual(Object.keys(manifest), [...COMPOSITE_MANIFEST_KEYS]);
  assert.equal(manifest.schema_version, COMPOSITE_MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.trial_id, 'trial-001');
  assert.equal(manifest.root_run_id, ROOT_RUN_ID);

  // §9.4 D2: exactly one node — the parent attempt — and zero spawn/dispatch/decompose edges.
  assert.equal(manifest.nodes.length, 1);
  assert.deepEqual(manifest.edges, []);
  const node = manifest.nodes[0];
  assert.equal(node.attempt_id, `run-${ROOT_RUN_ID}`);
  assert.equal(node.attempt_id, mintAttemptId(ROOT_RUN_ID, null));
  assert.equal(node.attempt_ordinal, 1);
  assert.equal(node.thread_id, null);
  // The attempt_id names the REAL lifecycle pair (§9.2 invariant 4).
  assert.equal(fs.existsSync(
    path.join(built.options.trajectoryRoot, `${node.attempt_id}.started.json`),
  ), true);

  // All 39 members present, every key, `| null` only ever a nullable VALUE (G4-CM2).
  assert.deepEqual(Object.keys(node), [...ATTEMPT_RECORD_KEYS]);
  // G4-CM11 taskless shape: task_id re-uses trial_id, and roots.root_task_id is the ONE flag.
  assert.equal(node.task_id, 'trial-001');
  assert.equal(manifest.roots.root_task_id, null);
  assert.equal(manifest.roots.parent_attempt_id, node.attempt_id);
  // D-NULL3: null means UNDERIVABLE — never 0, never "".
  assert.equal(node.dispatch_generation, null);
  assert.equal(node.root_thread_id, null);
  assert.equal(node.template, null);

  // The observed identity scalars are the run's own, and the frozen expectation is the policy's map.
  assert.equal(node.model_execution_identity_hash,
    built.policy.identity.model_execution_identity_hash.parent);
  assert.deepEqual(manifest.identity.model_execution_identity_hash,
    built.policy.identity.model_execution_identity_hash);

  // O-G4-ACCT: the shipped nine-member record, `checks` included.
  assert.equal(Object.keys(manifest.accounting).length, 9);
  assert.ok(Array.isArray(manifest.accounting.checks));
  assert.equal(Object.keys(manifest.accounting.proxy).length, 7);
  assert.equal(manifest.accounting.trial_id, manifest.trial_id);

  // predicate: exhaustive for the mode, and NEVER a pass nobody earned.
  //
  // Wave 2 could assert "no row passes" because NO row was evaluated — `publishCompositeManifest`
  // supplied no `evaluatedChecks` at all, so every §9.4 id published as `unavailable`. That is the
  // F21 pattern (a check that exists and is never evaluated), not a property worth pinning. D2 is
  // now genuinely evaluated, so the invariant is restated in the form it was always meant to have:
  // exactly the rows this pin decides carry a verdict, and every other row is still `unavailable`.
  assert.equal(manifest.predicate.mode, 'direct');
  assert.deepEqual(manifest.predicate.checks.map((c: any) => c.check_id), checkIdsForMode('direct'));

  const byId = new Map<string, any>(manifest.predicate.checks.map((c: any) => [c.check_id, c]));
  // §9.4 D2 EVALUATED and earned: one node, zero descent edges, complete native-subagent census.
  assert.equal(byId.get('D2').result, 'pass');
  assert.equal(byId.get('D2').detail, null);
  // Every OTHER id is untouched by this pin and must still read `unavailable` — never a pass.
  for (const check of manifest.predicate.checks) {
    if (check.check_id === 'D2') continue;
    assert.equal(check.result, 'unavailable', `${check.check_id} must not claim a verdict`);
    assert.equal(check.detail, 'not evaluated at this pin');
  }

  // The document the producer emitted passes its own structural validator, in production.
  const stems = fs.readdirSync(built.options.trajectoryRoot)
    .filter(name => name.endsWith('.started.json'))
    .map(name => name.slice(0, -'.started.json'.length));
  assert.deepEqual(validateCompositeManifest(manifest, {
    limits: {
      max_task_depth: built.policy.limits.max_task_depth,
      max_tasks: built.policy.limits.max_tasks,
    },
    lifecycleStems: stems,
  }), []);

  // G4-CM5: the published bytes re-read and re-hash to the manifest's identity.
  assert.deepEqual(bytes, canonicalCompositeManifestBytes(manifest));
}, 60_000);

it('G4-PB6: trajectory-merge-cli is NOT promoted to a bin, and F8 spawns no CLI (T17)', () => {
  // One production writer, one publication: a second route to the same publication turns the
  // `output_path_exists` hard failure into a race.
  const pkg = JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.bin), ['cortex', 'cortex-hook', 'cortex-run', 'cortex-task']);
  assert.equal(JSON.stringify(pkg.bin).includes('trajectory-merge'), false);
  // G4-PB5: the publication path contains no spawn. F8 runs after F2 has proven quiescence, so a
  // Node subprocess here would falsify the very evidence §9.4 G2 publishes.
  const source = fs.readFileSync(
    fileURLToPath(new URL('../../../src/domain/benchmark/composite-manifest.ts', import.meta.url)),
    'utf8',
  );
  // Asserted as the CAPABILITY, not as the word: `spawn` is also the name of a §9.2 edge kind, and
  // §9.2 is frozen, so a bare /spawn/ would only ever be satisfiable by renaming the design's own
  // vocabulary. What G4-PB5 forbids is reaching the process-spawning API at all.
  assert.equal(/child_process/.test(source), false);
  assert.equal(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(source), false);
});

// --- T18: F8 publishes the merged ATIF trajectory ON THE PRODUCTION PATH ---
//
// §9.5 F8 publishes "the composite manifest AND the merged recursive ATIF" (design:2815). Before
// this wave `mergeTrajectory` had ZERO production callers — its only non-test `src/` reference was
// `trajectory-merge-cli.ts:127`, and T17 above proves that CLI is deliberately not a bin. The
// trajectory is therefore observed through the file F8 publishes, driven by the real runner.

it('publishes the merged ATIF trajectory from inside runOneShotAgent (T18)', async () => {
  const built = fixture({ accounted: true });
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);

  const published = path.join(built.options.trajectoryRoot, 'trajectory.json');
  assert.equal(fs.existsSync(published), true, `F8 published no ATIF trajectory: ${outcome.stderr}`);
  const trajectory = JSON.parse(fs.readFileSync(published, 'utf8'));

  // A real ATIF-v1.7 document about THIS run, not a stub.
  assert.equal(trajectory.trajectory_id, ROOT_RUN_ID);
  assert.equal(typeof trajectory.final_metrics, 'object');
  // §9.4 D2: a direct trial has exactly one attempt, so the tree has no subagent level at all.
  assert.equal(Object.hasOwn(trajectory, 'subagent_trajectories'), false);

  // F8 is atomic and one-shot: a second publication to the same path is a hard failure, which is
  // why exactly one writer may exist (T17).
  assert.throws(() => mergeTrajectory({
    trajectoryRoot: built.options.trajectoryRoot, outputPath: published,
  }), (error: unknown) => (error as TrajectoryMergeError).reason === 'output_path_exists');

  // ...and F8 committed its staged half rather than leaving both names occupied.
  assert.equal(fs.existsSync(`${published}.staging`), false);
}, 60_000);

// --- T19: the §9.4 census is LOAD-BEARING, and its failure rides the shipped code 41 ---
//
// The structural shape here is PERFECT — one node, zero edges, a valid manifest. The only thing
// wrong is that the parent made a native subagent call nothing attests, which is exactly OC-11's
// invisibility. A census that is not evaluated cannot see it; that is the F21 pattern this test
// exists to refuse.

it('an UNATTESTED native subagent call fails D2 and raises code 41 (T19)', async () => {
  const built = fixture({ nativeSubagentCall: { id: 'sub-1', name: 'Task' } });
  const outcome = await runTrial(built);

  // The refusal leaves its coded reason on stderr as JSON — the class-R invariant.
  const refusal = outcome.stderr.split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .find(record => record?.reason === 'terminal_predicate_unmet');
  assert.ok(refusal, `no code-41 refusal on stderr:\n${outcome.stderr}`);

  // BY INTEGER, never by matching a message string. 41 is the SHIPPED registry entry.
  assert.equal(refusal.code, 41);
  assert.equal(refusal.code, BENCHMARK_FAILURES.find(f => f.reason === 'terminal_predicate_unmet')!.code);
  assert.deepEqual(refusal.unmet, ['D2']);
  // The failing check names the unattested call, so the report is actionable.
  assert.match(refusal.checks[0].detail, /sub-1/);

  // Fails CLOSED: an ungradable trial publishes NO composite manifest.
  assert.equal(
    fs.existsSync(path.join(built.options.trajectoryRoot, 'composite-manifest.json')), false,
    'a trial that failed its terminal predicate must not publish a gradable manifest',
  );

  // ...and fails closed AT THE PROCESS BOUNDARY. Without this the trial could refuse its own
  // predicate and still exit 0, which a harness would score as a SUCCESSFUL trial — the manifest's
  // absence would be read as "nothing to grade" rather than "refused". Pinned to the shipped class-R
  // convention: the 41 rides the stderr JSON, while the terminal record carries the generic
  // protocol_violation, exactly as code 40 already behaves (see :576 for the code-40 precedent).
  assert.notEqual(outcome.exitCode, 0, 'a predicate refusal must not exit 0');
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.terminal.terminal_reason, 'protocol_violation');
}, 60_000);

it('the SAME native call ATTESTED by a subagent_activity passes D2 (T19b)', async () => {
  // The control for T19: identical shape, and the only difference is that the census is complete.
  // Without this pair, a mutant that made the census always-fail would survive T19.
  const built = fixture();
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 0);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(built.options.trajectoryRoot, 'composite-manifest.json'), 'utf8',
  ));
  assert.equal(manifest.predicate.checks.find((c: any) => c.check_id === 'D2').result, 'pass');
}, 60_000);

// --- T20: nodes[] and edges[] are DERIVED from the lifecycle pairs on disk ---
//
// The parent process cannot spawn a real pipeline thread under a fake backend, so the child's
// evidence is written the way the orchestrator writes it — through the SAME production writers
// (`writeStartedMarker`, `writeTerminalManifest`) into the SAME trajectory root
// (`benchmark-local-thread-orchestrator.ts:404,424`), carrying the trial's OWN policy identity.
// Nothing hands the runner a node, an edge or a manifest: it discovers the pair by scanning, and
// the assertion is made against the file F8 published.

function writeChildAttempt(built: Fixture, threadId: string, role: string): string {
  const root = built.options.trajectoryRoot;
  const identity = {
    modelExecutionIdentityHash: built.policy.identity.model_execution_identity_hash[role],
    roleToolSurfaceHash: built.policy.identity.role_tool_surface_hash[role],
    bundleManifestHash: built.policy.identity.bundle_manifest_hash,
  };
  const journalPath = path.join(root, `thread-${threadId}.journal.ndjson`);
  const at = '2026-08-01T00:00:01.000Z';
  const base = {
    schema_version: 'cortex-bench-journal/1', root_run_id: ROOT_RUN_ID, thread_id: threadId,
    agent_slot: role,
    model_execution_identity_hash: identity.modelExecutionIdentityHash,
    role_tool_surface_hash: identity.roleToolSurfaceHash,
    bundle_manifest_hash: identity.bundleManifestHash,
  };
  // A child that READ CACHE, which is what a real second turn does. The numbers follow the shipped
  // adapter's own convention (`adapter.ts:140-147`): `prompt_tokens` = input + cacheCreation +
  // cacheRead, `cached_tokens` = cacheRead, `tokens_in` = `prompt_tokens`. `cached_tokens` is
  // load-bearing: the runner's OWN terminal manifest carries no `cache_read` member at all
  // (`runner.ts:719-722`), so a summation over terminal manifests can never derive a cached total,
  // while the shipped accumulator can. That asymmetry is what makes the two producers distinguishable.
  const events = [
    { type: 'assistant_text', text: 'child works' },
    {
      type: 'cost_record', provider: 'anthropic', model: 'claude-reported-trial',
      tokens_in: 25, tokens_out: 2, prompt_tokens: 25, cached_tokens: 15, cost_usd: 0.001,
    },
    { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.001 },
  ];
  const prompt = 'c'.repeat(64);
  const records = [
    {
      ...base, type: 'run_header', seq: 0, ts: at, resolved_cwd: built.workspace,
      canonical_instruction_sha256: prompt, model_visible_prompt_sha256: prompt,
      system_prompt_sha256: prompt, tool_manifest_sha256: prompt, plugin_manifest_sha256: prompt,
    },
    ...events.map((event, index) => ({
      ...base, type: 'event', step: 1, seq: index + 1, ts: at,
      backend: 'claude', provider: 'anthropic',
      requested_model: 'claude-sonnet', reported_model: 'claude-reported-trial', event,
    })),
  ];
  const bytes = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  fs.writeFileSync(journalPath, bytes);

  writeStartedMarker({
    trajectoryRoot: root, rootRunId: ROOT_RUN_ID, threadId, journalPath,
    now: () => new Date(at),
  });
  // The real writer VALIDATES linkage against the journal bytes, so a child whose evidence does not
  // cohere cannot be written at all — which is what makes this a faithful stand-in for the
  // orchestrator rather than a hand-placed file.
  writeTerminalManifest({
    trajectoryRoot: root, rootRunId: ROOT_RUN_ID, threadId, state: 'completed',
    startedAt: at, endedAt: at, journalPath,
    journalSha256: createHash('sha256').update(bytes).digest('hex'),
    eventCount: events.length,
    // §9.4 G2: the child is quiescent with no surviving descendants.
    supervisor: { quiescent: true, descendants: 0 },
    steps: 1, costUsd: 0.001,
    tokens: { input: 25, output: 2, cache_read: 15, cache_creation: 0 },
    ...identity,
    terminalReason: 'ok',
  });
  return `thread-${threadId}`;
}

it('emits one AttemptRecord per attempt and a spawn edge between them (T20)', async () => {
  const built = fixture(
    { accounted: true, threadRunCall: { id: 'toolu_thread_1', threadId: 'c1' } },
    undefined, 'coder-review',
  );
  const childId = writeChildAttempt(built, 'c1', 'benchmark-coder');

  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);

  const manifest = JSON.parse(fs.readFileSync(
    path.join(built.options.trajectoryRoot, 'composite-manifest.json'), 'utf8',
  ));

  // TWO nodes, one per lifecycle pair — derived, not hardcoded.
  assert.equal(manifest.nodes.length, 2);
  assert.deepEqual(
    manifest.nodes.map((node: any) => node.attempt_id).sort(),
    [mintAttemptId(ROOT_RUN_ID, null), childId].sort(),
  );

  // The child is a THREAD attempt and carries the G4-N14 thread-scoped identity in full.
  const child = manifest.nodes.find((node: any) => node.attempt_id === childId);
  assert.equal(child.thread_id, 'c1');
  assert.equal(child.root_thread_id, 'c1');
  assert.equal(child.template, 'benchmark-coder-review');
  assert.equal(child.role, 'benchmark-coder');
  assert.deepEqual(Object.keys(child), [...ATTEMPT_RECORD_KEYS]);

  // ONE edge, drawn from the CLOSED union, parent -> child.
  assert.equal(manifest.edges.length, 1);
  assert.deepEqual(manifest.edges[0], {
    kind: 'spawn',
    from: { ref: 'attempt', id: mintAttemptId(ROOT_RUN_ID, null) },
    to: { ref: 'attempt', id: childId },
  });
  assert.equal((ATTEMPT_EDGE_KINDS as readonly string[]).includes(manifest.edges[0].kind), true);

  // G4-CM18: the edge projects onto its `from` node and onto no other.
  const parentNode = manifest.nodes.find(
    (node: any) => node.attempt_id === mintAttemptId(ROOT_RUN_ID, null),
  );
  assert.deepEqual(parentNode.edges, manifest.edges);
  assert.deepEqual(child.edges, []);

  // The published document passes the real validator at the arm's own taskless limits.
  assert.deepEqual(validateCompositeManifest(manifest, {
    limits: {
      max_task_depth: built.policy.limits.max_task_depth,
      max_tasks: built.policy.limits.max_tasks,
    },
    lifecycleStems: fs.readdirSync(built.options.trajectoryRoot)
      .filter(name => name.endsWith('.started.json'))
      .map(name => name.slice(0, -'.started.json'.length)),
  }), []);

  // --- §9.4 C7, all THREE conjuncts decided (B2) ---
  //
  // The link map was DERIVED FROM THE DAG and handed to the merge through the shipped
  // `MergeTrajectoryOptions.subagentLinks` seam (G4-PB8, `design:8368`), so the published tree
  // reports `explicit` — the value C7 (`design:2778`) asserts and §9.3 M1 (`design:2715`) makes
  // mandatory in-trial. Before this the argument was never passed, the merge fell back to parsing
  // model-produced tool text, and the conjunct was never decided at all.
  const trajectory = JSON.parse(fs.readFileSync(
    path.join(built.options.trajectoryRoot, 'trajectory.json'), 'utf8',
  ));
  assert.equal(trajectory.extra.subagent_link_source, 'explicit');
  assert.equal(trajectory.subagent_trajectories.length, 1);
  const c7 = manifest.predicate.checks.find((check: any) => check.check_id === 'C7');
  assert.equal(c7.result, 'pass', c7.detail);
  assert.equal(c7.detail, null);

  // --- §9.5 F8's publication is all-or-nothing, in the SUCCESS direction (B1) ---
  //
  // Exactly one tree, and no staging residue: the staged half is committed by `link(2)` and its
  // staging name removed, so a re-run in the same artifacts root meets the guard and not a leftover.
  assert.equal(
    fs.existsSync(path.join(built.options.trajectoryRoot, 'trajectory.json.staging')), false,
    'the staged ATIF was left behind next to the published one',
  );

  // --- §9.6 A2: ONE producer for the journal side (M1) ---
  //
  // The journal totals ARE the shipped accumulator's own answer, read back off the two documents F8
  // published rather than re-summed here. A2 names the accumulator's four operands, which fixes the
  // mapping: `prompt_tokens → tokens.input`, `tokens_out → tokens.output`,
  // `cached_tokens → tokens.cached`, `cost_usd → cost_usd`.
  const metrics = trajectory.final_metrics;
  const journal = manifest.accounting.journal;
  assert.equal(journal.source, 'trajectory_merge');
  assert.equal(Number(journal.cost_usd.value), metrics.total_cost_usd);
  assert.deepEqual(journal.steps, { status: 'available', value: metrics.total_steps });
  assert.deepEqual(journal.tokens.input,
    { status: 'available', value: metrics.total_prompt_tokens });
  assert.deepEqual(journal.tokens.output,
    { status: 'available', value: metrics.total_completion_tokens });
  // The discriminating figure. `cache_read` is not a member of the runner's terminal manifest at
  // all (`runner.ts:719-722`), so the DELETED second summation could only ever report `cached` as
  // unavailable; the accumulator derives it from the child's `cost_record`. A restored second
  // producer fails HERE, on a non-zero number.
  assert.deepEqual(journal.tokens.cached, { status: 'available', value: 15 });
  assert.equal(metrics.total_cached_tokens, 15);
  assert.equal(metrics.total_steps, 2);
}, 60_000);

// --- T21: §9.6 A2/A5 — the journal side is the accumulator's, and it REFUSES rather than guess ---
//
// MGR-F1 and M1 meet here. §9.6 A2 (`design:2840`) names ONE producer for the journal side — "the
// shipped accumulator, which refuses to guess" — and marks the row `shipped`. When that accumulator
// refuses, EVERY journal figure is unavailable. It is not replaced by a second summation over the
// terminal manifests, and no operand is silently skipped: a sum that skipped the missing ones would
// publish a total meaning "the trial spent nothing" where the truth is "nobody knows what it spent".
//
// `steps` is the conjunct that separates the two producers in this direction. The terminal manifest
// carries `steps: 1` (T14 asserts it), so a summation over terminal manifests reports `available 1`
// here while the accumulator — which refused wholesale — has nothing to report.

it('publishes an UNAVAILABLE journal side when the accumulator refused (T21, §9.6 A2/A5)', async () => {
  // Reachability is structural, not contrived: this backend reports no cost and no usage, so the
  // adapter emits no `cost_record`, and `fragmentCostMetrics` refuses `aggregate_metrics_underivable`.
  const built = fixture();
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);

  // The merge really did refuse, and said so with its own shipped reason.
  const refusal = outcome.stderr.split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .find(record => record?.reason === 'aggregate_metrics_underivable');
  assert.ok(refusal, `the accumulator did not refuse:\n${outcome.stderr}`);

  // A refusal to derive the trajectory is NOT a refusal of the trial: §9.4 D2 does not read the
  // tree, so the manifest is still published and the terminal truth F6 wrote is preserved.
  const manifest = JSON.parse(fs.readFileSync(
    path.join(built.options.trajectoryRoot, 'composite-manifest.json'), 'utf8',
  ));
  assert.equal(manifest.predicate.checks.find((c: any) => c.check_id === 'D2').result, 'pass');
  assert.equal(terminalManifest(built).steps, 1);

  const unavailable = { status: 'unavailable', reason: 'journal_underivable' };
  const journal = manifest.accounting.journal;
  assert.deepEqual(journal.requests, unavailable);
  assert.deepEqual(journal.cost_usd, unavailable);
  assert.deepEqual(journal.steps, unavailable);
  assert.deepEqual(journal.tokens,
    { input: unavailable, output: unavailable, cached: unavailable });

  // ...and nothing was published or left staged for a tree that does not exist.
  for (const name of ['trajectory.json', 'trajectory.json.staging']) {
    assert.equal(
      fs.existsSync(path.join(built.options.trajectoryRoot, name)), false, `${name} exists`,
    );
  }
}, 60_000);

// --- T22: G4-CM10 — an underivable non-nullable field REFUSES; it does not get a placeholder ---
//
// MGR-F3. A `direct` arm's child-template whitelist is EMPTY (`capabilities.ts:36,61`), so a thread
// attempt under one has no §9.1 field 12 the frozen policy can supply. G4-CM10 rules that case a
// `composite_manifest_invalid` refusal rather than a guess, and the refusal was pinned by nothing.
//
// This is the EMPTY-WHITELIST witness rather than the manager-mode one: it drives a real arm over a
// real seeded lifecycle pair through `runOneShotAgent` and observes the production refusal itself,
// where a manager-mode test could only pin the absence of a shipped template.

it('refuses a thread attempt whose §9.1 template is underivable (T22, G4-CM10)', async () => {
  const built = fixture();
  // Measured off the compiled policy, not assumed: `direct` derives NO child template.
  assert.deepEqual(built.policy.child_template_whitelist, []);
  // A `direct` arm compiles exactly one role, so the seeded pair enters under it. Inventing a
  // `benchmark-coder` identity here would make the fixture the authority on identity instead of
  // the frozen policy, and the merge's role-indexed M4 check would refuse it on those grounds
  // rather than on the one this test is about.
  writeChildAttempt(built, 'b1', 'parent');

  const outcome = await runTrial(built);
  const refusal = outcome.stderr.split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .find(record => record?.reason === 'composite_manifest_invalid');
  assert.ok(refusal, `no typed refusal on stderr:\n${outcome.stderr}`);
  assert.equal(refusal.code, 40);
  assert.equal(refusal.code,
    BENCHMARK_FAILURES.find(f => f.reason === 'composite_manifest_invalid')!.code);
  // The refusal came from the DAG BUILDER, not from the structural validator: a document that got
  // as far as validation would carry named violations. A placeholder template produces exactly that
  // instead, which is how this assertion separates the two.
  assert.deepEqual(refusal.violations, []);
  // The message names the field and the cardinality that made it underivable, so the report is
  // actionable rather than merely typed.
  assert.match(outcome.stderr, /thread attempt template underivable: 0 whitelisted child templates/);
  assert.equal(outcome.exitCode, 1);

  // And it refused BEFORE F8 wrote anything at all.
  for (const name of ['composite-manifest.json', 'trajectory.json', 'trajectory.json.staging']) {
    assert.equal(
      fs.existsSync(path.join(built.options.trajectoryRoot, name)), false, `${name} exists`,
    );
  }
}, 60_000);

// --- T23: §9.5 F8's publication is ATOMIC — the refusal direction, and the two traps ---
//
// F8 publishes a PAIR (`design:2815`) and the step table forbids reordering. The composite manifest
// is written last because §9.5's grader-admission rule keys on it, and the checklist that decides
// admission reads the ATIF tree — so the tree must exist before the decision, and the decision can
// still refuse. A tree merged straight to its final path therefore survives a refused trial as a
// complete, collectable interchange document for a trial that published no manifest; and because
// the merge's `output_path_exists` is a HARD failure (`trajectory-merge.ts:648-653`), that residue
// turns any second attempt in the same artifacts root into that refusal instead of its real outcome.

it('a refused trial leaves NO trajectory.json and no staging residue (T23a)', async () => {
  // The parent admitted a pipeline thread but its journal carries no `thread_run` call, so the
  // link map is UNDERIVABLE and F8 passes none. The merge then falls back to the model-visible
  // tool text §9.3 M1 forbids in-trial and reports `tool_result`, which fails C7's link-source
  // conjunct. The merge itself SUCCEEDS — so a tree really was produced and really had to be
  // discarded, which is what makes this a witness for atomicity rather than a vacuous absence.
  const built = fixture({ accounted: true }, undefined, 'coder-review');
  writeChildAttempt(built, 'c1', 'benchmark-coder');
  const outcome = await runTrial(built);

  const refusal = outcome.stderr.split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .find(record => record?.reason === 'terminal_predicate_unmet');
  assert.ok(refusal, `no code-41 refusal on stderr:\n${outcome.stderr}`);
  assert.equal(refusal.code, 41);
  assert.deepEqual(refusal.unmet, ['C7']);
  assert.match(refusal.checks[0].detail, /link source is tool_result, not explicit/);
  assert.equal(outcome.exitCode, 1);

  for (const name of ['composite-manifest.json', 'trajectory.json', 'trajectory.json.staging']) {
    assert.equal(
      fs.existsSync(path.join(built.options.trajectoryRoot, name)), false, `${name} was left behind`,
    );
  }
}, 60_000);

it('refuses a pre-existing trajectory.json instead of replacing it (T23b, §9.3 M9)', async () => {
  // Staging moved the merge's own `assertOutputPrecondition` onto the STAGING path, so the commit
  // is the only thing still guarding the final one. `rename(2)` replaces its destination in
  // silence; `link(2)` raises EEXIST. Without this, B1's fix quietly reintroduces the fail-open
  // §9.5 F8 and §9.3 M9 ("keep verbatim") exist to remove.
  const built = fixture({ accounted: true });
  const published = path.join(built.options.trajectoryRoot, 'trajectory.json');
  const prior = '{"prior":"trial"}\n';
  fs.writeFileSync(published, prior);

  const outcome = await runTrial(built);
  assert.notEqual(outcome.exitCode, 0, 'a pre-existing ATIF was accepted');
  // The prior document survives BYTE-FOR-BYTE: F8's failure is hard, not best-effort.
  assert.equal(fs.readFileSync(published, 'utf8'), prior);
  // Reported through the SHIPPED merge reason — this allocates no new vocabulary.
  const refusal = outcome.stderr.split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .find(record => record?.reason === 'output_path_exists');
  assert.ok(refusal, `no output_path_exists refusal on stderr:\n${outcome.stderr}`);
  // And the staged half is discarded, so nothing half-published survives either.
  assert.equal(fs.existsSync(`${published}.staging`), false);
  assert.equal(
    fs.existsSync(path.join(built.options.trajectoryRoot, 'composite-manifest.json')), false,
  );
}, 60_000);

it('REPORTS a discard it could not complete, rather than orphaning silently (T23c)', async () => {
  // The whole point of the discard is that no tree outlives a refused trial. A discard that fails
  // and says nothing leaves exactly the orphan B1 exists to prevent — and leaves it invisible.
  //
  // The obstruction is a real filesystem state, not a stub: something else occupies the staging
  // name as a non-empty directory. The merge refuses `output_path_exists` on it, C7 then fails
  // because no tree was published, and the discard cannot remove a directory (`rmSync`'s `force`
  // suppresses ENOENT only).
  const built = fixture({ accounted: true }, undefined, 'coder-review');
  writeChildAttempt(built, 'c1', 'benchmark-coder');
  const staging = path.join(built.options.trajectoryRoot, 'trajectory.json.staging');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'occupant'), 'not a trajectory\n');

  const outcome = await runTrial(built);
  assert.notEqual(outcome.exitCode, 0);
  assert.match(outcome.stderr, /atif discard failed/);
  assert.ok(outcome.stderr.includes(staging), `the report does not name the path:\n${outcome.stderr}`);
  // The obstruction is untouched — the run reported it instead of escalating to a recursive delete.
  assert.equal(fs.readFileSync(path.join(staging, 'occupant'), 'utf8'), 'not a trajectory\n');
}, 60_000);

// --- T24: §9.3 M1's link map is DERIVED FROM THE DAG, on a TOTAL order ---
//
// `deriveSubagentLinks` is the production function `attemptGraph` calls; T20 proves it is wired and
// what it produces end to end, and this proves what it computes. Pure inputs, pure output.

it('derives the subagent link map from the DAG in attempt-ordinal order (T24, §9.3 M1)', () => {
  const nodes = [
    { attempt_id: 'run-r1', thread_id: null, attempt_ordinal: 1 },
    { attempt_id: 'thread-a', thread_id: 'a', attempt_ordinal: 2 },
    { attempt_id: 'thread-b', thread_id: 'b', attempt_ordinal: 3 },
  ] as never as AttemptRecord[];
  const edges = [
    { kind: 'spawn', from: { ref: 'attempt', id: 'run-r1' }, to: { ref: 'attempt', id: 'thread-a' } },
    { kind: 'spawn', from: { ref: 'attempt', id: 'run-r1' }, to: { ref: 'attempt', id: 'thread-b' } },
  ] as never as AttemptEdge[];
  const call = (id: string, name = 'thread_run') => (
    { type: 'tool_use', name, toolUseId: id, input: {} } as never
  );
  const parentCalls = [call('call-1'), call('call-2')];
  const journals = (parent: never[]) => ([
    { attempt_id: 'run-r1', events: parent },
    { attempt_id: 'thread-a', events: [] },
    { attempt_id: 'thread-b', events: [] },
  ]);
  const paired = [{ callId: 'call-1', threadId: 'a' }, { callId: 'call-2', threadId: 'b' }];

  assert.deepEqual(deriveSubagentLinks(nodes, edges, journals(parentCalls)), paired);

  // THE REVERSED-EDGE CASE. `edges` is built by walking `observedLifecycleStems`, a bare unsorted
  // `readdirSync`, so its order is a directory-listing artefact. Pairing must follow G4-AI5's
  // `attempt_ordinal` (`started_at`, made total by `assignAttemptOrdinals`'s `attempt_id`
  // tie-break), so the SAME DAG with its edges reversed derives the SAME map. Zipping edges in
  // their own order returns `call-1 → b` — a silent mis-pair no merge check can catch, because
  // `nodeLinks` (`trajectory-merge.ts:562-575`) tests MEMBERSHIP in the child set, not identity.
  assert.deepEqual(deriveSubagentLinks(nodes, [edges[1], edges[0]], journals(parentCalls)), paired);

  // Both live names of the one tool. The merge indexes calls by both (`trajectory-merge.ts:283`),
  // and a map that missed the alias would be short by one link.
  assert.deepEqual(
    deriveSubagentLinks(nodes, edges, journals(
      [call('call-1'), call('call-2', 'mcp__cortex-benchmark-thread__thread_run')] as never[],
    )),
    paired,
  );

  // A trial with no thread at all derives an EMPTY map, not a null one: nothing was underivable.
  assert.deepEqual(deriveSubagentLinks(
    nodes.slice(0, 1), [], [{ attempt_id: 'run-r1', events: [] }],
  ), []);

  // Counts that disagree — a `thread_run` the §5.4 E2 call limit refused — are UNDERIVABLE, and the
  // WHOLE map is null rather than partial. `explicitLinksInCallOrder` requires a link for every
  // call a fragment made (`trajectory-merge.ts:375-377`), so a partial map is a hard merge refusal,
  // and guessing which call started which thread is exactly what §9.3 M1 forbids.
  assert.equal(
    deriveSubagentLinks(nodes, edges, journals([...parentCalls, call('call-3')] as never[])), null,
  );
  assert.equal(deriveSubagentLinks(nodes, edges, journals([call('call-1')] as never[])), null);

  // A child attempt with no `thread_id` names no thread, so the map is underivable rather than
  // carrying a link to nothing.
  const anonymous = [
    nodes[0], { ...nodes[1], thread_id: null }, nodes[2],
  ] as never as AttemptRecord[];
  assert.equal(deriveSubagentLinks(anonymous, edges, journals(parentCalls)), null);

  // A child the manifest never declared has no ordinal, so no total order exists over the children
  // and the pairing is underivable. Never sorted as if it came first.
  assert.equal(
    deriveSubagentLinks(nodes.slice(0, 2), edges, journals(parentCalls)), null,
  );
});
