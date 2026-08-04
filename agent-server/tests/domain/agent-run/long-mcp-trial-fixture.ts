// input:  a temp trial root, a hold-server budget, an arm deadline and a supervisor mode
// output: a compiled Claude trial whose declared MCP server is the holding fixture
// pos:    Shared fixture for the Gate-2 long-call and transport-teardown suites
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { AgentRunCliOptions } from '../../../src/domain/agent-run/agent-run-cli.js';
import { loadAgentRunConfigWithPolicy } from '../../../src/domain/agent-run/run-config.js';
import { runOneShotAgent, type AgentRunIo } from '../../../src/domain/agent-run/runner.js';
import type { ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';
import { profileRepo } from '../../../src/store/profile-repo.js';

export const installRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const supervisorBinary = path.join(
  installRoot, 'native/cortex-supervisor/dist/cortex-supervisor',
);
export const HOLD_SERVER = fileURLToPath(new URL('./long-mcp-hold-server.mjs', import.meta.url));
export const CLAUDE_CLI = fileURLToPath(new URL('./long-mcp-claude-cli.mjs', import.meta.url));

/** The only version `BENCHMARK_LONG_MCP_CALL_CLI_VERSIONS` admits; any other refuses to compile
 *  with §2.6 code 29 the moment a role exposes the benchmark MCP surface (§5.7 C6). */
export const CLI_VERSION = '2.1.220 (Claude Code)';
export const SDK_DEFAULT_TIMEOUT_MS = 60_000;

export function buildSupervisor(): void {
  const built = spawnSync('flock', [
    '-x', '/tmp/cortex-supervisor-build.lock', 'npm', 'run', 'build:supervisor',
  ], { cwd: installRoot, encoding: 'utf8' });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
}

export function write(file: string, content: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
  return file;
}

export function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Design §4.6 / ruling R2(c): the containment unit is the process *group*, so "nothing survived"
 *  is asked of the group and not only of the pids the test happens to know about. */
export function groupAlive(pgid: number): boolean {
  return processAlive(-pgid);
}

/**
 * The shipped `fake-supervisor.ts` fixture behind a `cortex-supervisor`-shaped shim, so a trial can
 * be given a supervisor that ends its control stream without a `quiescent` record. Transpiled the
 * same way `trial-run.test.ts` does it, because the supervisor path takes a binary, not a module.
 */
export function installFakeSupervisor(root: string, mode: string): string {
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

export async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    assert.ok(Date.now() < deadline, `pid ${pid} outlived the trial`);
    await delay(20);
  }
}

export async function waitForFile(file: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${file}`);
    await delay(20);
  }
}

export interface HoldServerOptions {
  holdMs: number;
  progressMs?: number;
  /** Self-destruct mid-call, the way the shipped sidecar's own `process.exit(1)` would. */
  exitAfterMs?: number;
  exitCode?: number;
  name?: string;
}

export interface HoldServer {
  args: string[];
  pidFile: string;
  startedFile: string;
  abortedFile: string;
}

/** Parameters travel in argv, not the environment: the trial child environment is pinned and
 *  carries no test variables, which is the same constraint the shipped trial fixtures work under. */
export function holdServerArgs(root: string, options: HoldServerOptions): HoldServer {
  const dir = path.join(root, 'hold', options.name ?? 'server');
  fs.mkdirSync(dir, { recursive: true });
  const pidFile = path.join(dir, 'pid.json');
  const startedFile = path.join(dir, 'started.json');
  const abortedFile = path.join(dir, 'aborted.json');
  return {
    pidFile,
    startedFile,
    abortedFile,
    args: [
      HOLD_SERVER,
      '--hold-ms', String(options.holdMs),
      '--progress-ms', String(options.progressMs ?? 0),
      '--exit-after-ms', String(options.exitAfterMs ?? 0),
      '--exit-code', String(options.exitCode ?? 1),
      '--pid-file', pidFile,
      '--started-file', startedFile,
      '--aborted-file', abortedFile,
    ],
  };
}

export interface ClaudeTrialOptions {
  hold: HoldServerOptions;
  deadlineSeconds: number;
  /** Answer the turn while the tool call is still in flight, leaving the sidecar alive. */
  detachMcp?: boolean;
}

export interface ClaudeTrial {
  options: AgentRunCliOptions;
  policy: ResolvedTrialPolicy;
  observation: string;
  mcpResult: string;
  server: HoldServer;
  rootRunId: string;
}

function writeProfile(): void {
  write(path.join(process.env.CORTEX_HOME as string, 'config', 'profiles.json'), JSON.stringify({
    defaultProfile: 'benchmark-profile',
    profiles: {
      'benchmark-profile': {
        model: 'claude-sonnet', backend: 'claude', mode: 'api', provider: 'anthropic',
        extraOption: {}, claudeBackend: 'print', thinking: 'high', fallback: [],
      },
    },
  }));
  profileRepo.invalidate();
}

function armResolution(
  root: string, rootRunId: string, cli: string, mcpConfig: string, deadlineSeconds: number,
): Record<string, unknown> {
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
        deadline_seconds: deadlineSeconds,
      },
    },
    arm_path: '/harness/arms/cortex-direct.yaml',
    trial_id: 'trial-long-mcp',
    root_run_id: rootRunId,
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
    cli_artifact: { path: cli, version: CLI_VERSION },
    model_alias_policy: { kind: 'exact' },
    roles: {
      parent: {
        system_prompt_path: write(path.join(root, 'parent-system.txt'), 'You are the benchmark parent.\n'),
        directive_path: write(path.join(root, 'parent-directive.txt'), 'Solve the task.\n'),
        tools: ['Read', 'Write'],
        plugin_dirs: [],
        mcp_composition: 'benchmark-thread-run',
        mcp_config_paths: [mcpConfig],
        disable_hooks: true,
        benchmark_policy_guard: { parent_writable: ['Read', 'Write'], thread_active: ['Read'] },
      },
    },
    thread_templates: {},
    thread_agents: {},
    artifact_inventory_spec: { expected: ['stdout', 'stderr', 'manifest'] },
  };
}

export function claudeTrial(root: string, trial: ClaudeTrialOptions): ClaudeTrial {
  writeProfile();
  const rootRunId = 'trial-long-mcp.cortex-direct';
  const observation = path.join(root, 'backend-observation.json');
  const mcpResult = path.join(root, 'mcp-result.json');
  const server = holdServerArgs(root, trial.hold);
  const mcpConfig = write(path.join(root, 'mcp-benchmark-thread.json'), `${JSON.stringify({
    mcpServers: { 'cortex-benchmark-thread': { command: process.execPath, args: server.args } },
  })}\n`);
  const cli = write(
    path.join(root, 'bundle', 'claude-trial'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLAUDE_CLI)} `
    + `--cortex-observation ${JSON.stringify(observation)} `
    + `--cortex-mcp-result ${JSON.stringify(mcpResult)} `
    + `${trial.detachMcp ? '--cortex-detach-mcp ' : ''}"$@"\n`,
    0o755,
  );
  const runConfigFile = write(
    path.join(root, 'arm-resolution.json'),
    JSON.stringify(armResolution(root, rootRunId, cli, mcpConfig, trial.deadlineSeconds)),
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
    graceMs: 200,
    rootRunId,
  };
  fs.mkdirSync(options.trajectoryRoot, { recursive: true });
  const policy = loadAgentRunConfigWithPolicy({ runConfigFile, agentSlot: 'parent' }).policy!;
  return { options, policy, observation, mcpResult, server, rootRunId };
}

export interface TrialOutcome {
  exitCode: number;
  stdout: any[];
  terminal: any;
  stderr: string;
}

export async function runTrial(trial: ClaudeTrial): Promise<TrialOutcome> {
  const lines: string[] = [];
  const errors: string[] = [];
  const io: AgentRunIo = {
    stdout: { write: (chunk: string) => { lines.push(chunk); return true; } },
    stderr: { write: (chunk: string) => { errors.push(chunk); return true; } },
  };
  const exitCode = await runOneShotAgent(trial.options, io);
  const stdout = lines.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { exitCode, stdout, terminal: stdout.at(-1), stderr: errors.join('') };
}

export function terminalManifestFile(trial: ClaudeTrial): string {
  return path.join(trial.options.trajectoryRoot, `run-${trial.rootRunId}.terminal.json`);
}

export function journalRecords(trial: ClaudeTrial): any[] {
  return fs.readFileSync(trial.options.eventsFile, 'utf8').trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line));
}
