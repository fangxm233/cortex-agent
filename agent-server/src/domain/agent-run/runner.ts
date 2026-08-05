// input:  parsed options, resolved config/policy, cost metadata
// output: supervised turn, journal, nullable accounting, manifest
// pos:    Agent-run lifecycle coordinator
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { readStdinBufferSync } from '@core/cli-utils.js';
import { setProcessLogPolicy } from '@core/log.js';
import type { AgentHandle, AgentResult } from '@core/types/agent-types.js';
import { ClaudeAdapter } from '../../agent-adapter/claude/adapter.js';
import type {
  AgentAdapter, AgentProcessSpawner, AgentProcessSupervision, AgentSpawnConfig, Backend,
  NormalizedEvent,
} from '../../agent-adapter/index.js';
import {
  buildAgentSpawnConfig, runWithAdapter,
  type AgentConfig, type RunAgentOptions, type RunObserver,
} from '../agents/facade.js';
import { listProfiles, resolveProfileConfig } from '../agents/profile-manager.js';
import {
  createTrialAdapter, trialAgentConfig, trialRunOptions,
  type TrialAdapter, type TrialAdapterSpec,
} from '../benchmark/trial-adapter-factory.js';
import { publishLeaseEcho } from '../benchmark/lease-echo.js';
import { PolicyCompilationError, reportBenchmarkFailure } from '../benchmark/resolved-policy.js';
import { preparePinnedTrialPaths } from './pinned-node-process.js';
import {
  canonicalJsonSha256, freezeIdentity, IdentityProfileFallbackError,
  type BundleManifestInput, type FrozenIdentity, type RoleToolSurfaceInput,
} from './identity.js';
import {
  openJournal, TrajectoryWriteFailedError, type Journal, type JournalEventInput,
} from './journal.js';
import {
  resolveLifecyclePaths, writeStartedMarker, writeTerminalManifest,
  type TerminalManifestInput, type TerminalReason, type TerminalState,
} from './manifest.js';
import { buildTerminalManifest } from './manifest-contract.js';
import {
  loadAgentRunConfigWithPolicy, resolvedRouteHost, validateResolvedExecution,
  type LoadedAgentRunConfig, type ResolvedAgentRunConfig,
} from './run-config.js';
import { roleSurfaceFromSpawnConfig } from './role-surface.js';
import {
  attachSupervisor, exitCodeFor, type ExitReason, type SupervisorSession,
} from './supervisor.js';
import type { AgentRunCliOptions } from './agent-run-cli.js';

export interface AgentRunIo {
  stdout: Pick<Writable, 'write'> & Partial<Pick<Writable, 'on'>>;
  stderr: Pick<Writable, 'write'>;
}

interface PromptInput {
  raw: Buffer;
  modelVisible: string;
}

interface PreparedRun {
  options: AgentRunCliOptions;
  rootRunId: string;
  modelPrompt: string;
  profile: ReturnType<typeof resolveProfileConfig>;
  config: ResolvedAgentRunConfig;
  policy?: LoadedAgentRunConfig['policy'];
  /** Present exactly on the benchmark path; owns the adapter instance and its close (S5). */
  trial: TrialAdapter | null;
  backend: Backend;
  identity: FrozenIdentity;
  spawnConfig: AgentSpawnConfig;
  baseOptions: RunAgentOptions;
  hashes: ReturnType<typeof promptHashes>;
  startedAt: string;
}

interface RunStats {
  input: number;
  output: number;
  sawInput: boolean;
  sawOutput: boolean;
}

interface ExecutionOutcome {
  result: AgentResult | null;
  error: unknown;
  childExit: { code: number | null; signal: string | null } | null;
  supervisorExit: { code: number | null; signal: NodeJS.Signals | null } | null;
  quiescent: boolean;
  cancelled: boolean;
}

interface ClassifiedOutcome {
  reason: TerminalReason;
  state: TerminalState;
  exitCode: number;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function readPrompt(file: string): PromptInput {
  if (file === '-') {
    const raw = readStdinBufferSync();
    return { raw, modelVisible: raw.toString('utf8') };
  }
  try {
    const raw = fs.readFileSync(file);
    return { raw, modelVisible: raw.toString('utf8') };
  } catch (error) {
    throw new Error(`Failed to read --prompt-file '${file}': ${(error as Error).message}`);
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedRoleManifests(role: RoleToolSurfaceInput): {
  plugin_dirs: RoleToolSurfaceInput['pluginDirs'];
  skills: RoleToolSurfaceInput['skills'];
} {
  return {
    plugin_dirs: [...role.pluginDirs].sort((left, right) => compareText(left.path, right.path)),
    skills: [...role.skills].sort((left, right) => compareText(left.name, right.name)),
  };
}

function promptHashes(prompt: PromptInput, role: RoleToolSurfaceInput) {
  return {
    canonicalInstructionSha256: sha256(prompt.raw),
    modelVisiblePromptSha256: sha256(prompt.modelVisible),
    systemPromptSha256: role.systemPromptSha256,
    directiveSha256: role.directiveSha256,
    toolManifestSha256: canonicalJsonSha256(role.tools),
    pluginManifestSha256: canonicalJsonSha256(sortedRoleManifests(role)),
  };
}

function bundleIdentity(
  options: AgentRunCliOptions,
  config: ResolvedAgentRunConfig,
): Omit<BundleManifestInput, 'modelExecutionIdentityHash' | 'roleToolSurfaceHash'> {
  return {
    runConfig: config.runConfig,
    limits: {
      configured: config.limits,
      deadline_ms: options.deadlineMs ?? null,
      grace_ms: options.graceMs,
    },
    resolvedPaths: {
      cwd: options.cwd,
      events_file: options.eventsFile,
      trajectory_root: options.trajectoryRoot,
      run_config_file: options.runConfigFile ?? null,
      mcp_config_paths: config.role.mcpConfigPaths,
    },
    adapterHashes: config.adapterHashes,
    harnessHashes: config.harnessHashes,
  };
}

function freezeRunIdentity(
  options: AgentRunCliOptions,
  profile: PreparedRun['profile'],
  config: ResolvedAgentRunConfig,
  roleSurface: RoleToolSurfaceInput,
  policy: LoadedAgentRunConfig['policy'],
): FrozenIdentity {
  const execution = policy?.model_execution;
  const resolvedProfile = execution ? {
    ...profile,
    model: execution.requested_model,
    backend: execution.backend,
    provider: execution.provider_protocol,
    thinking: execution.reasoning_effort,
    fallback: [],
  } : profile;
  return freezeIdentity({
    resolvedProfile,
    modelExecution: config.modelExecution,
    roleToolSurface: roleSurface,
    bundleManifest: bundleIdentity(options, config),
  });
}

function assertClaudeProfile(profile: PreparedRun['profile']): void {
  if (profile.backend !== 'claude') {
    throw new Error(`Profile '${profile.name}' must use backend 'claude'`);
  }
  if (profile.claudeBackend !== 'print') {
    throw new Error(`Profile '${profile.name}' must use Claude print mode`);
  }
  if (profile.fallback.length > 0) throw new IdentityProfileFallbackError();
}

function resolveProfile(name: string): PreparedRun['profile'] {
  try {
    return resolveProfileConfig(name);
  } catch (error) {
    if (!(error as Error).message.includes(`Unknown profile: ${name}`)) throw error;
    const valid = listProfiles().map(profile => profile.name);
    throw new Error(
      `Invalid --profile: '${name}'. Valid values: ${valid.join(', ')}. `
      + 'Choose a name from CORTEX_HOME/config/profiles.json.',
      { cause: error },
    );
  }
}

function assertMcpFiles(config: ResolvedAgentRunConfig): void {
  for (const file of config.role.mcpConfigPaths) {
    try {
      if (fs.statSync(file).isFile()) continue;
    } catch {}
    throw new Error(`MCP config is not a file: ${file}`);
  }
}

function probeClaudeVersion(profile: PreparedRun['profile'], cwd: string): string {
  const result = spawnSync('claude', ['--version'], {
    cwd,
    env: { ...process.env, ...profile.extraEnv },
    encoding: 'utf8',
    timeout: 5_000,
  });
  const version = result.stdout?.trim() || result.stderr?.trim();
  if (result.error || result.status !== 0 || !version) {
    throw new Error(`Failed to probe Claude CLI version: ${result.error?.message ?? result.status}`);
  }
  return version;
}

// C3/C6: with a policy in hand the CLI version and the identity route host are frozen values, so
// re-probing the CLI or reading the host profile's route would be the runtime re-resolution §2.7
// forbids. §1.7 keeps the identity host distinct from the per-trial proxy authority the child is
// actually routed at, which is why the proxy URL is not read back here.
function observedRunConfig(
  config: ResolvedAgentRunConfig,
  profile: PreparedRun['profile'],
  cwd: string,
  policy: LoadedAgentRunConfig['policy'],
): ResolvedAgentRunConfig {
  const execution = policy
    ? {
      configuredRouteBaseHost: policy.model_execution.configured_route_base_host,
      claudeCliVersion: policy.model_execution.claude_cli_version,
      cliName: policy.model_execution.cli_name,
      cliVersion: policy.model_execution.cli_version,
    }
    : {
      configuredRouteBaseHost: resolvedRouteHost(profile),
      claudeCliVersion: probeClaudeVersion(profile, cwd),
    };
  return { ...config, modelExecution: { ...config.modelExecution, ...execution } };
}

function assertFreshTrajectory(options: AgentRunCliOptions, rootRunId: string): void {
  const lifecycle = resolveLifecyclePaths({
    trajectoryRoot: options.trajectoryRoot,
    rootRunId,
    threadId: null,
  });
  const existing = [options.eventsFile, lifecycle.started, lifecycle.terminal]
    .find(file => fs.existsSync(file));
  if (existing) throw new TrajectoryWriteFailedError(`Trajectory output already exists: ${existing}`);
}

function agentConfig(profile: PreparedRun['profile']): AgentConfig {
  return {
    model: profile.model,
    backend: profile.backend,
    mode: profile.mode,
    provider: profile.provider,
    extraEnv: profile.extraEnv,
    extraOption: profile.extraOption,
    claudeBackend: profile.claudeBackend,
    thinking: profile.thinking,
  };
}

function baseRunOptions(
  options: AgentRunCliOptions,
  profile: PreparedRun['profile'],
  config: ResolvedAgentRunConfig,
  key: string,
): RunAgentOptions {
  return {
    sessionKey: key,
    channel: key,
    profileName: profile.name,
    cwd: options.cwd,
    awaitBackground: true,
    backgroundWaitPolicy: 'completion-only',
    mcpComposition: config.role.mcpComposition,
    mcpConfigPaths: config.role.mcpConfigPaths,
    disableHooks: config.role.disableHooks,
    streamDeltas: false,
    captureTranscriptLogs: false,
    loadCortexRules: false,
    recordCost: false,
    systemPrompt: config.role.systemPrompt,
    pluginDirs: config.role.pluginDirs,
    tools: config.role.tools.join(','),
  };
}

function assertBenchmarkInvocation(
  loaded: LoadedAgentRunConfig,
  options: AgentRunCliOptions,
  rootRunId: string,
): void {
  if (!loaded.policy) return;
  if (loaded.policy.root_run_id !== rootRunId) {
    throw new Error(
      `Benchmark root_run_id mismatch: expected '${rootRunId}', `
      + `received '${loaded.policy.root_run_id}'`,
    );
  }
  const profileName = loaded.policy.asset_inventory
    .find(asset => asset.kind === 'profile')!.logical_name;
  if (profileName !== options.profile) {
    throw new Error(
      `Benchmark profile_name mismatch: expected '${options.profile}', received '${profileName}'`,
    );
  }
}

function resolveRunInputs(
  options: AgentRunCliOptions,
  profile: PreparedRun['profile'],
  rootRunId: string,
): LoadedAgentRunConfig {
  const loaded = loadAgentRunConfigWithPolicy({
    runConfigFile: options.runConfigFile,
    agentSlot: options.agentSlot,
  });
  assertBenchmarkInvocation(loaded, options, rootRunId);
  if (!loaded.policy) {
    assertClaudeProfile(profile);
    validateResolvedExecution(profile, loaded.config);
  }
  assertMcpFiles(loaded.config);
  return { ...loaded, config: observedRunConfig(loaded.config, profile, options.cwd, loaded.policy) };
}

// No CLI flag names the trial root, and adding a required one would break the shipped harness
// invocation. The harness places the trajectory inside the per-trial agent directory, so the trial
// root is a sibling of the trajectory root rather than the trajectory root itself.
function trialAdapterSpec(
  options: AgentRunCliOptions,
  policy: NonNullable<LoadedAgentRunConfig['policy']>,
  config: ResolvedAgentRunConfig,
): TrialAdapterSpec {
  const trialRoot = path.join(path.dirname(path.resolve(options.trajectoryRoot)), 'trial-home');
  return {
    policy,
    slot: options.agentSlot,
    config,
    paths: preparePinnedTrialPaths(trialRoot),
    supervisor: {
      binary: options.supervisorBinary,
      graceMs: options.graceMs,
      deadlineMs: options.deadlineMs,
    },
    cwd: options.cwd,
  };
}

// R4: the surface the process is actually spawned with must be the surface phase B hashed. A
// divergence means the run would be attributed to a role it is not running.
function assertPolicyRoleSurface(run: {
  policy?: LoadedAgentRunConfig['policy'];
  options: AgentRunCliOptions;
  identity: FrozenIdentity;
}): void {
  if (!run.policy) return;
  const expected = run.policy.identity.role_tool_surface_hash[run.options.agentSlot];
  if (expected !== run.identity.roleToolSurfaceHash) {
    throw new Error(
      `Role surface hash mismatch for slot '${run.options.agentSlot}': `
      + `policy ${expected}, spawned ${run.identity.roleToolSurfaceHash}`,
    );
  }
}

function prepareRun(options: AgentRunCliOptions, rootRunId: string): PreparedRun {
  assertFreshTrajectory(options, rootRunId);
  const prompt = readPrompt(options.promptFile);
  const profile = resolveProfile(options.profile);
  const loaded = resolveRunInputs(options, profile, rootRunId);
  const config = loaded.config;
  const spec = loaded.policy ? trialAdapterSpec(options, loaded.policy, config) : null;
  const trial = spec ? createTrialAdapter(spec) : null;
  const baseOptions = spec
    ? trialRunOptions(spec)
    : baseRunOptions(options, profile, config, `agent-run:${rootRunId}`);
  const spawnConfig = trial?.spawnConfig
    ?? buildAgentSpawnConfig(baseOptions, agentConfig(profile), undefined);
  spawnConfig.preserveUnreportedAccounting = true;
  // S7: the benchmark surface carries the directive and the guard; the legacy path carries neither.
  const roleSurface = trial?.roleSurface ?? roleSurfaceFromSpawnConfig(spawnConfig);
  const run: PreparedRun = {
    options, rootRunId, profile, config, policy: loaded.policy, spawnConfig, baseOptions,
    trial,
    backend: trial?.backend ?? profile.backend,
    modelPrompt: prompt.modelVisible,
    identity: freezeRunIdentity(options, profile, config, roleSurface, loaded.policy),
    hashes: promptHashes(prompt, roleSurface),
    startedAt: new Date().toISOString(),
  };
  assertPolicyRoleSurface(run);
  return run;
}

const protectedWriters = new WeakSet<object>();

function protectDiagnosticWriter(writer: AgentRunIo['stdout']): void {
  if (!writer.on || protectedWriters.has(writer)) return;
  protectedWriters.add(writer);
  writer.on('error', () => {});
}

function writeJsonLine(io: AgentRunIo, value: Readonly<Record<string, unknown>>): void {
  protectDiagnosticWriter(io.stdout);
  try {
    io.stdout.write(`${JSON.stringify(value)}\n`);
  } catch (error) {
    try { io.stderr.write(`agent-run stdout failed: ${(error as Error).message}\n`); }
    catch {}
  }
}

function reportedModel(event: NormalizedEvent): string | null {
  return event.type === 'assistant_text' ? event.model ?? null : null;
}

function collectStats(stats: RunStats, event: NormalizedEvent): void {
  if (event.type !== 'cost_record') return;
  if (event.tokens_in !== null) {
    stats.sawInput = true;
    stats.input += event.tokens_in;
  }
  if (event.tokens_out !== null) {
    stats.sawOutput = true;
    stats.output += event.tokens_out;
  }
}

function runProvider(run: PreparedRun): string | null {
  return run.policy?.model_execution.provider_protocol ?? run.profile.provider;
}

function runRequestedModel(run: PreparedRun): string {
  return run.policy?.model_execution.requested_model ?? run.profile.model;
}

function trajectorySink(
  run: PreparedRun,
  journal: Journal,
  stats: RunStats,
  io: AgentRunIo,
): RunObserver {
  return {
    onEvent(event): void {
      const input: JournalEventInput = {
        threadId: null,
        step: null,
        agentSlot: run.options.agentSlot,
        backend: run.backend,
        provider: runProvider(run),
        requestedModel: runRequestedModel(run),
        reportedModel: reportedModel(event),
        event,
      };
      const record = journal.writeEvent(input);
      collectStats(stats, event);
      writeJsonLine(io, record);
    },
    onClose: () => journal.close(),
  };
}

function supervisedSpawner(
  run: PreparedRun,
  capture: (session: SupervisorSession) => void,
  cancelled: () => boolean,
): AgentProcessSpawner {
  return (command, args, options) => {
    const session = attachSupervisor({
      binary: run.options.supervisorBinary,
      args: [command, ...args],
      graceMs: run.options.graceMs,
      deadlineMs: run.options.deadlineMs,
      cwd: options.cwd?.toString(),
      env: options.env,
      stdio: 'pipe',
    });
    capture(session);
    if (cancelled()) session.cancel('cancel');
    return {
      process: session.process as ChildProcessWithoutNullStreams,
      supervision: session as AgentProcessSupervision,
    };
  };
}

function installSignals(cancel: () => void): () => void {
  const handler = () => cancel();
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => {
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
  };
}

async function settleSupervisor(session: SupervisorSession | null): Promise<{
  quiescent: boolean;
  childExit: ExecutionOutcome['childExit'];
  supervisorExit: ExecutionOutcome['supervisorExit'];
  error: unknown;
}> {
  if (!session) {
    return { quiescent: false, childExit: null, supervisorExit: null, error: null };
  }
  try {
    const childExit = await session.exited;
    await session.quiescent;
    return { quiescent: true, childExit, supervisorExit: await session.closed, error: null };
  } catch (error) {
    return {
      quiescent: false,
      childExit: await session.exited.catch(() => null),
      supervisorExit: await session.closed.catch(() => null),
      error,
    };
  }
}

function oneShotOptions(
  run: PreparedRun,
  sink: RunObserver,
  spawner: AgentProcessSpawner,
): RunAgentOptions {
  run.spawnConfig.processSpawner = spawner;
  return {
    ...run.baseOptions,
    requiredSinks: [sink],
    processSpawner: spawner,
    preparedSpawnConfig: run.spawnConfig,
  };
}

async function settleHandle(handle: AgentHandle): Promise<{
  result: AgentResult | null;
  error: unknown;
}> {
  try {
    return { result: await handle.promise, error: null };
  } catch (error) {
    return { result: null, error };
  }
}

function errorReason(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

function executionError(runError: unknown, supervisorError: unknown): unknown {
  return errorReason(runError) === 'trajectory_write_failed'
    ? runError
    : supervisorError ?? runError;
}

async function settledOutcome(
  adapter: AgentAdapter,
  run: PreparedRun,
  handle: AgentHandle,
  supervision: SupervisorSession | null,
  cancelled: () => boolean,
): Promise<ExecutionOutcome> {
  const handleOutcome = await settleHandle(handle);
  // S5: the trial owns its adapter instance and closes it exactly once.
  if (run.trial) await run.trial.close();
  else await adapter.close(`agent-run:${run.rootRunId}`);
  const settled = await settleSupervisor(supervision);
  return {
    ...handleOutcome,
    error: executionError(handleOutcome.error, settled.error),
    childExit: settled.childExit,
    supervisorExit: settled.supervisorExit,
    quiescent: settled.quiescent,
    cancelled: cancelled(),
  };
}

async function executeTurn(
  run: PreparedRun, journal: Journal, io: AgentRunIo, stats: RunStats,
): Promise<ExecutionOutcome> {
  const adapter = run.trial?.adapter ?? new ClaudeAdapter();
  let supervision: SupervisorSession | null = null;
  let handle: AgentHandle | null = null;
  let cancelled = false;
  const requestCancel = () => {
    cancelled = true;
    if (handle) handle.kill();
    else supervision?.cancel('cancel');
  };
  const removeSignals = installSignals(requestCancel);
  const spawner = supervisedSpawner(run, value => { supervision = value; }, () => cancelled);
  try {
    const options = oneShotOptions(run, trajectorySink(run, journal, stats, io), spawner);
    const config = run.policy ? trialAgentConfig(run.policy, run.backend) : agentConfig(run.profile);
    handle = runWithAdapter(adapter, run.modelPrompt, options, config, undefined);
    if (cancelled) handle.kill();
    return await settledOutcome(adapter, run, handle, supervision, () => cancelled);
  } finally {
    removeSignals();
    await supervision?.dispose();
  }
}

function failedOutcome(
  reason: TerminalReason,
  exitReason: ExitReason,
  code?: number,
): ClassifiedOutcome {
  return { reason, state: 'failed', exitCode: exitCodeFor(exitReason, code) };
}

function classifySupervisor(outcome: ExecutionOutcome): ClassifiedOutcome | null {
  if (outcome.cancelled) {
    return { reason: 'cancelled', state: 'cancelled', exitCode: 130 };
  }
  const code = outcome.supervisorExit?.code;
  if (code === 124) return { reason: 'deadline', state: 'timeout', exitCode: 124 };
  if (code === 125) return failedOutcome('containment_failure', 'containment_failure');
  return null;
}

function classifyAgent(outcome: ExecutionOutcome): ClassifiedOutcome {
  const code = outcome.childExit?.code;
  if (outcome.result?.rateLimited) {
    return { reason: 'rate_limited', state: 'failed', exitCode: 1 };
  }
  if (!outcome.error && (code === null || code === undefined || code === 0)) {
    return { reason: 'ok', state: 'completed', exitCode: 0 };
  }
  return failedOutcome('child_failure', 'child_failure', code ?? undefined);
}

function classify(outcome: ExecutionOutcome): ClassifiedOutcome {
  const reason = errorReason(outcome.error);
  if (reason === 'trajectory_write_failed') return failedOutcome(reason, reason);
  if (!outcome.quiescent || reason === 'containment_failure') {
    return failedOutcome('containment_failure', 'containment_failure');
  }
  if (outcome.cancelled) return classifySupervisor(outcome)!;
  const childCode = outcome.childExit?.code;
  if (childCode !== null && childCode !== undefined && childCode !== 0) {
    return failedOutcome('child_failure', 'child_failure', childCode);
  }
  return classifySupervisor(outcome) ?? classifyAgent(outcome);
}

function terminalInput(
  run: PreparedRun,
  journal: Journal,
  stats: RunStats,
  outcome: ExecutionOutcome,
  classified: ClassifiedOutcome,
): TerminalManifestInput {
  return {
    trajectoryRoot: run.options.trajectoryRoot,
    rootRunId: run.rootRunId,
    threadId: null,
    state: classified.state,
    startedAt: run.startedAt,
    endedAt: new Date().toISOString(),
    journalPath: run.options.eventsFile,
    journalSha256: journal.sha256(),
    eventCount: journal.eventCount,
    supervisor: { quiescent: true, descendants: 0 },
    steps: outcome.result?.num_turns ?? null,
    costUsd: outcome.result?.costReported === false
      ? null
      : outcome.result?.total_cost_usd ?? null,
    tokens: {
      input: stats.sawInput ? stats.input : null,
      output: stats.sawOutput ? stats.output : null,
    },
    modelExecutionIdentityHash: run.identity.modelExecutionIdentityHash,
    roleToolSurfaceHash: run.identity.roleToolSurfaceHash,
    bundleManifestHash: run.identity.bundleManifestHash,
    terminalReason: classified.reason,
  };
}

function terminalManifest(
  run: PreparedRun,
  journal: Journal,
  stats: RunStats,
  outcome: ExecutionOutcome,
  classified: ClassifiedOutcome,
): Record<string, unknown> | null {
  if (!outcome.quiescent) return null;
  const input = terminalInput(run, journal, stats, outcome, classified);
  writeTerminalManifest(input);
  return buildTerminalManifest(input);
}

function openRunJournal(run: PreparedRun): Journal {
  return openJournal({
    path: run.options.eventsFile,
    header: {
      rootRunId: run.rootRunId,
      threadId: null,
      agentSlot: run.options.agentSlot,
      resolvedCwd: run.options.cwd,
      ...run.hashes,
      modelExecutionIdentityHash: run.identity.modelExecutionIdentityHash,
      roleToolSurfaceHash: run.identity.roleToolSurfaceHash,
      bundleManifestHash: run.identity.bundleManifestHash,
    },
  });
}

function writeStart(run: PreparedRun): void {
  writeStartedMarker({
    trajectoryRoot: run.options.trajectoryRoot,
    rootRunId: run.rootRunId,
    threadId: null,
    journalPath: run.options.eventsFile,
    now: () => new Date(run.startedAt),
  });
}

function writeTerminalOutput(
  io: AgentRunIo,
  rootRunId: string,
  manifest: Record<string, unknown> | null,
  classified: ClassifiedOutcome,
): void {
  writeJsonLine(io, {
    type: 'terminal',
    ok: classified.state === 'completed',
    root_run_id: rootRunId,
    state: classified.state,
    manifest,
    exit_code: classified.exitCode,
    terminal_reason: classified.reason,
  });
}

/**
 * The trial proxy's credential lease was armed from the host clock before this container existed,
 * so it is a provisional bound rather than the trial's own deadline. Hand the proxy the remaining
 * budget — a duration, derived from the frozen policy and the container's monotonic clock — so it
 * can shorten that bound to the trial the container actually compiled.
 *
 * An undelivered echo is deliberately not fatal. The lease then simply stays at its bound, which is
 * finite by construction, and the absence is recorded on the host and fails the trial's terminal
 * predicate there. Killing the run here would kill a live trial for a plumbing fault — the exact
 * failure mode the echo exists to remove.
 */
async function echoTrialLease(run: PreparedRun, io: AgentRunIo): Promise<void> {
  if (!run.policy) return;
  try {
    await publishLeaseEcho(run.policy, { monotonic_ns: () => process.hrtime.bigint() });
  } catch (error) {
    io.stderr.write(`lease echo unavailable: ${(error as Error)?.message ?? String(error)}\n`);
  }
}

function classifyStartupFailure(error: unknown): ClassifiedOutcome {
  const reason = errorReason(error);
  if (reason === 'trajectory_write_failed') return failedOutcome(reason, reason);
  if (reason === 'containment_failure') return failedOutcome(reason, reason);
  return { reason: 'protocol_violation', state: 'failed', exitCode: 1 };
}

export async function runOneShotAgent(
  options: AgentRunCliOptions,
  io: AgentRunIo,
): Promise<number> {
  const restoreLogging = setProcessLogPolicy({ consoleToStderr: true, files: false });
  const rootRunId = options.rootRunId ?? randomUUID();
  let run: PreparedRun | null = null;
  let journal: Journal | null = null;
  try {
    run = prepareRun(options, rootRunId);
    journal = openRunJournal(run);
    writeJsonLine(io, journal.header);
    writeStart(run);
    // Before any model process is admitted.
    await echoTrialLease(run, io);
    const stats: RunStats = { input: 0, output: 0, sawInput: false, sawOutput: false };
    const outcome = await executeTurn(run, journal, io, stats);
    const classified = classify(outcome);
    const manifest = terminalManifest(run, journal, stats, outcome, classified);
    writeTerminalOutput(io, rootRunId, manifest, classified);
    return classified.exitCode;
  } catch (error) {
    await journal?.close().catch(() => {});
    const classified = classifyStartupFailure(error);
    // §2.6 P-class invariant: a refused policy leaves its coded reason on stderr as JSON.
    if (error instanceof PolicyCompilationError) reportBenchmarkFailure(error, io.stderr);
    io.stderr.write(`${(error as Error)?.message ?? String(error)}\n`);
    writeTerminalOutput(io, rootRunId, null, classified);
    return classified.exitCode;
  } finally {
    restoreLogging();
  }
}
