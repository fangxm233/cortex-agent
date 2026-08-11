// input:  parsed options, resolved policy, state/process admission
// output: supervised turn, journal, terminal and composite truth
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
  trialAgentConfig, type TrialAdapter,
} from '../benchmark/trial-adapter-factory.js';
import { publishLeaseEcho } from '../benchmark/lease-echo.js';
import {
  PolicyCompilationError, reportBenchmarkFailure, type ResolvedTrialPolicy,
} from '../benchmark/resolved-policy.js';
import {
  assignAttemptOrdinals, mintAttemptId, type AttemptEdge, type AttemptRecord,
} from '../benchmark/attempt-record.js';
import {
  CompositeManifestError, buildCompositeManifest, publishComposite, validateCompositeManifest,
  type CompositeManifest, type OrchestrationModeName,
} from '../benchmark/composite-manifest.js';
import {
  assertTerminalPredicate, evaluateTerminalChecks, TerminalPredicateError,
  type AttemptJournal, type PublishedAtifFacts,
} from '../benchmark/terminal-predicate.js';
import { mergeTrajectory, TrajectoryMergeError } from './trajectory-merge.js';
import type { ThreadLink } from './atif.js';
import {
  PROXY_EXPORT_SCHEMA_VERSION, journalCostFromNumber, reconcileAccounting,
  type AccountingRecord, type JournalTotals, type ProxyExport, type Tagged,
} from '../benchmark/accounting-reconciliation.js';
import {
  createStandaloneAgentRunComposition, isStandaloneArmResolution, StandaloneAdmissionError,
  type StandaloneAgentRunComposition,
} from './standalone-composition.js';
import {
  createBenchmarkOutputAdapter, type BenchmarkOutputAdapter,
} from './benchmark-output-adapter.js';
import {
  canonicalJsonSha256, freezeIdentity, IdentityProfileFallbackError,
  type BundleManifestInput, type FrozenIdentity, type RoleToolSurfaceInput,
} from './identity.js';
import {
  TrajectoryWriteFailedError, type Journal, type JournalEventInput,
} from './journal.js';
import {
  resolveLifecyclePaths,
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
  /** Present exactly on the benchmark path; owns all fresh trial-local dependencies. */
  composition: StandaloneAgentRunComposition | null;
  /** Present exactly on the benchmark path; owns the adapter instance and its close (S5). */
  trial: TrialAdapter | null;
  output: BenchmarkOutputAdapter;
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
  /** The backend's own model self-report, retained for AttemptRecord field 18. Stays `null` when
   * the backend reported none — it is NEVER defaulted to `requested_model` (§9.6 A5). */
  reportedModel: string | null;
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
  preloaded?: LoadedAgentRunConfig,
): LoadedAgentRunConfig {
  const loaded = preloaded ?? loadAgentRunConfigWithPolicy({
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

function standaloneComposition(
  options: AgentRunCliOptions,
  rootRunId: string,
): StandaloneAgentRunComposition | null {
  if (!isStandaloneArmResolution(options.runConfigFile)) return null;
  const trialRoot = path.join(path.dirname(path.resolve(options.trajectoryRoot)), 'trial-home');
  return createStandaloneAgentRunComposition({
    runConfigFile: options.runConfigFile,
    agentSlot: options.agentSlot,
    profileName: options.profile,
    rootRunId,
    cwd: options.cwd,
    trajectoryRoot: options.trajectoryRoot,
    trialRoot,
    supervisor: {
      binary: options.supervisorBinary,
      graceMs: options.graceMs,
      deadlineMs: options.deadlineMs,
    },
    requireFresh: true,
  });
}

function preparedSpawn(
  options: AgentRunCliOptions,
  rootRunId: string,
  profile: PreparedRun['profile'],
  config: ResolvedAgentRunConfig,
  composition: StandaloneAgentRunComposition | null,
) {
  const trial = composition?.parentTrial ?? null;
  const baseOptions = composition?.parentRunOptions
    ?? baseRunOptions(options, profile, config, `agent-run:${rootRunId}`);
  const spawnConfig = trial?.spawnConfig
    ?? buildAgentSpawnConfig(baseOptions, agentConfig(profile), undefined);
  spawnConfig.preserveUnreportedAccounting = true;
  const roleSurface = trial?.roleSurface ?? roleSurfaceFromSpawnConfig(spawnConfig);
  return { trial, baseOptions, spawnConfig, roleSurface };
}

function prepareRun(options: AgentRunCliOptions, rootRunId: string): PreparedRun {
  assertFreshTrajectory(options, rootRunId);
  const prompt = readPrompt(options.promptFile);
  const composition = standaloneComposition(options, rootRunId);
  const profile = composition?.profile ?? resolveProfile(options.profile);
  const preloaded = composition
    ? { policy: composition.policy, config: composition.config } : undefined;
  const loaded = resolveRunInputs(options, profile, rootRunId, preloaded);
  const config = loaded.config;
  const spawn = preparedSpawn(options, rootRunId, profile, config, composition);
  const run: PreparedRun = {
    options, rootRunId, profile, config, policy: loaded.policy, composition,
    ...spawn,
    output: composition?.output ?? createBenchmarkOutputAdapter(options.trajectoryRoot),
    backend: spawn.trial?.backend ?? profile.backend,
    modelPrompt: prompt.modelVisible,
    identity: freezeRunIdentity(options, profile, config, spawn.roleSurface, loaded.policy),
    hashes: promptHashes(prompt, spawn.roleSurface),
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
      stats.reportedModel = input.reportedModel ?? stats.reportedModel;
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
  journal: Journal,
  sink: RunObserver,
  spawner: AgentProcessSpawner,
): RunAgentOptions {
  const admitted: AgentProcessSpawner = run.trial
    ? (command, args, options) => {
        run.trial!.admit({ cwd: options.cwd?.toString() ?? '', env: options.env ?? {} });
        if (run.composition) {
          journal.writeStateAdmission(run.composition.admission.evidence);
        }
        return spawner(command, args, options);
      }
    : spawner;
  run.spawnConfig.processSpawner = admitted;
  return {
    ...run.baseOptions,
    requiredSinks: [sink],
    processSpawner: admitted,
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
    const options = oneShotOptions(run, journal, trajectorySink(run, journal, stats, io), spawner);
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
  if (run.composition && !run.composition.admission.isInitialVerified()) {
    throw new StandaloneAdmissionError('Standalone state admission was not verified');
  }
  const input = terminalInput(run, journal, stats, outcome, classified);
  run.output.writeTerminal(
    input,
    run.composition ? { stateAdmission: run.composition.admission.evidence } : undefined,
  );
  return buildTerminalManifest(input);
}

function openRunJournal(run: PreparedRun): Journal {
  return run.output.openJournal({
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
  run.output.writeStarted({
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

const COMPOSITE_MANIFEST_FILE = 'composite-manifest.json';

/**
 * The composite manifest's operands — trial, arm and frozen identity — exist only on the benchmark
 * path. This is an explicit typed condition rather than a truthiness check, because a skip that
 * cannot be told apart from a refusal is the silent drop §9.6 A5 exists to forbid.
 */
type CompositeApplicability =
  | { readonly applicable: false }
  | { readonly applicable: true; readonly policy: ResolvedTrialPolicy };

function compositeApplicability(
  run: PreparedRun, terminal: Record<string, unknown> | null,
): CompositeApplicability {
  // A non-benchmark `agent-run` has no trial_id, arm or identity to build a manifest from, so the
  // manifest is correctly NOT APPLICABLE rather than missing.
  if (!run.policy) return { applicable: false };
  // G4-PB4: `terminalManifest` returns null the moment the run is not quiescent (`:715`), and
  // §9.5's corollary 2 rules that a containment failure publishes no terminal manifest, "so F7/F8
  // cannot run and the grader is never admitted". Cancellation and timeout are durable inner
  // outcomes, but they are not successful grader admissions and therefore publish no composite.
  if (terminal === null || terminal.state !== 'completed') return { applicable: false };
  return { applicable: true, policy: run.policy };
}

const ATIF_TRAJECTORY_FILE = 'trajectory.json';
/** Inside the trajectory root so the commit is a same-filesystem `link`, and NOT a `.started.json`,
 *  so neither `observedLifecycleStems` nor the merge's own scan (`trajectory-merge.ts:182`) can
 *  mistake it for a lifecycle pair. */
const STAGED_ATIF_FILE = 'trajectory.json.staging';

function observedLifecycleStems(trajectoryRoot: string): string[] {
  return fs.readdirSync(trajectoryRoot)
    .filter(name => name.endsWith('.started.json'))
    .map(name => name.slice(0, -'.started.json'.length));
}

/**
 * `lifecycleStem` (`manifest.ts:269-273`) and `mintAttemptId` (`attempt-record.ts:259-265`) are the
 * SAME expression, so the observed stems already ARE the attempt-id set §9.2 invariant 4's
 * biconditional quantifies over. `thread-` is the only other prefix either function can emit.
 */
function threadIdFromStem(stem: string): string | null {
  return stem.startsWith('thread-') ? stem.slice('thread-'.length) : null;
}

interface AttemptJournalScan {
  readonly agentSlot: string;
  readonly events: readonly NormalizedEvent[];
  readonly reportedModel: string | null;
}

/**
 * One pass over an attempt's journal, which is the only file carrying its ENTRY role. The journal
 * path is taken from the attempt's own terminal manifest, whose linkage F6 already validated
 * against these bytes — never re-derived from the stem.
 */
function scanAttemptJournal(trajectoryRoot: string, journalPath: string): AttemptJournalScan {
  const text = fs.readFileSync(path.join(trajectoryRoot, journalPath), 'utf8');
  const lines = text.split('\n').filter(line => line.length > 0);
  if (lines.length === 0) {
    throw new CompositeManifestError('composite_manifest_invalid', `empty journal ${journalPath}`);
  }
  const header = JSON.parse(lines[0]) as Record<string, unknown>;
  const records = lines.slice(1)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(record => record.type === 'event');
  const reported = records
    .map(record => record.reported_model)
    .filter((value): value is string => typeof value === 'string');
  return {
    agentSlot: header.agent_slot as string,
    events: records.map(record => record.event as NormalizedEvent),
    // Never defaulted to `requested_model`: that is synthesized data labelled native (§9.6 A5).
    reportedModel: reported.at(-1) ?? null,
  };
}

/**
 * §9.1 field 12 is non-nullable for a thread attempt (the G4-N14 biconditional refuses a thread
 * attempt that lost it), and G4-CM10 rules that an underivable non-nullable field is
 * `composite_manifest_invalid` rather than a placeholder.
 *
 * Its §9.1 source `ThreadRecord.templateName` is unreachable from here: the orchestrator runs under
 * the PINNED trial `CORTEX_HOME`, so its `threads.json` is not the one this process is bound to.
 * The authority parent and thread DO share is the frozen policy, and for `coder-review` its
 * child-template whitelist is a singleton derived from the arm's declared variant while §9.4 C2
 * admits exactly one thread — so the singleton IS the admitted thread's template. Any other
 * cardinality is underivable, and underivable is a refusal, not a guess.
 */
function threadAttemptTemplate(policy: ResolvedTrialPolicy): string {
  const whitelist = policy.child_template_whitelist;
  if (whitelist.length !== 1) {
    throw new CompositeManifestError(
      'composite_manifest_invalid',
      `thread attempt template underivable: ${whitelist.length} whitelisted child templates`,
    );
  }
  return whitelist[0];
}

/**
 * A child thread's attempt record, built from the evidence F6 published: its terminal manifest, its
 * journal and the frozen policy. Nothing here is minted.
 */
function threadAttemptRecord(
  run: PreparedRun,
  policy: ResolvedTrialPolicy,
  stem: string,
  threadId: string,
): { record: Omit<AttemptRecord, 'attempt_ordinal'>; journal: AttemptJournalScan } {
  const terminalRelative = `${stem}.terminal.json`;
  const terminalBytes = fs.readFileSync(path.join(run.options.trajectoryRoot, terminalRelative));
  const terminal = JSON.parse(terminalBytes.toString('utf8')) as Record<string, unknown>;
  const journal = scanAttemptJournal(run.options.trajectoryRoot, terminal.journal_path as string);
  const tokens = (terminal.tokens ?? {}) as Record<string, number | null | undefined>;
  return {
    journal,
    record: {
      trial_id: policy.trial_id,
      root_run_id: run.rootRunId,
      // G4-CM11: a taskless mode RE-USES `trial_id`; §1.3 rule 7 forces `max_tasks = 0` for every
      // mode but `manager`, so a thread of a `coder-review` trial carries the same re-used id.
      task_id: policy.trial_id,
      parent_task_id: null,
      dispatch_generation: null,
      attempt_id: stem,
      thread_id: threadId,
      // G4-N16: no benchmark writer produces `metadata.parentThreadId`.
      parent_thread_id: null,
      // Every lifecycle pair under this root is a DIRECT child of the parent process, so the thread
      // IS its own root thread — the depth-1 case in which G4-N15's `?? t.id` is correct.
      root_thread_id: threadId,
      task_ancestry: [policy.trial_id],
      template: threadAttemptTemplate(policy),
      // G4-AI8: verbatim the journal header's `agent_slot`, the fragment's ENTRY role.
      role: journal.agentSlot as AttemptRecord['role'],
      stage: null,
      backend: policy.model_execution.backend,
      provider: runProvider(run),
      requested_model: runRequestedModel(run),
      reported_model: journal.reportedModel,
      model_execution_identity_hash: terminal.model_execution_identity_hash as string,
      role_tool_surface_hash: terminal.role_tool_surface_hash as string,
      bundle_manifest_hash: terminal.bundle_manifest_hash as string,
      terminal_state: terminal.state as AttemptRecord['terminal_state'],
      terminal_reason: terminal.terminal_reason as AttemptRecord['terminal_reason'],
      // §9.4 C8: a standalone pipeline thread has no ledger, so no verdict has been recorded.
      disposition: 'none',
      superseded_by: null,
      artifact_path: null,
      artifact_sha256: null,
      journal_path: terminal.journal_path as string,
      journal_sha256: terminal.journal_sha256 as string,
      event_count: terminal.event_count as number,
      terminal_manifest_path: terminalRelative,
      terminal_manifest_sha256: createHash('sha256').update(terminalBytes).digest('hex'),
      edges: [],
      started_at: terminal.started_at as string,
      ended_at: terminal.ended_at as string,
      steps: (terminal.steps ?? null) as number | null,
      cost_usd: (terminal.cost_usd ?? null) as number | null,
      tokens: {
        input: tokens.input ?? null,
        output: tokens.output ?? null,
        cache_read: tokens.cache_read ?? null,
        cache_creation: tokens.cache_creation ?? null,
      },
      provider_requests: null,
    },
  };
}

interface AttemptGraph {
  readonly nodes: readonly AttemptRecord[];
  readonly edges: readonly AttemptEdge[];
  readonly journals: readonly AttemptJournal[];
  /** §9.3 M1's link map, or `null` when it is not derivable — never a partial one. */
  readonly subagentLinks: readonly ThreadLink[] | null;
}

/**
 * Both live names of the ONE tool that starts a pipeline thread, restated from
 * `trajectory-merge.ts:283-285` because that module is frozen at this pin and exports no predicate.
 *
 * A restated pair can drift, and here the drift is FAIL-CLOSED rather than silent: the merge
 * indexes the parent's calls with its own copy and `explicitLinksInCallOrder`
 * (`trajectory-merge.ts:364-384`) refuses `Explicit link map is incomplete` unless the supplied map
 * covers EVERY call it found. A copy that missed an alias therefore produces a hard merge refusal,
 * not a mis-pairing.
 */
const THREAD_RUN_TOOL_NAMES = new Set([
  'thread_run', 'mcp__cortex-benchmark-thread__thread_run',
]);

function isThreadRunCall(
  event: NormalizedEvent,
): event is Extract<NormalizedEvent, { type: 'tool_use' }> {
  return event.type === 'tool_use' && THREAD_RUN_TOOL_NAMES.has(event.name);
}

function edgeAttemptId(endpoint: AttemptEdge['to']): string | null {
  return endpoint.ref === 'attempt' ? endpoint.id : null;
}

/**
 * §9.3 M1 / G4-PB8: the parent→child link map comes FROM THE DAG, not from the model-visible tool
 * text `collectThreadLinks` parses. Supplying it is what makes the published tree's
 * `subagent_link_source` read `explicit`, which is §9.4 C7's third conjunct.
 *
 * Derivation, per attempt: its own `thread_run` calls in CALL ORDER, zipped against the attempts it
 * spawned in ATTEMPT-ORDINAL order — so the k-th call is paired with the k-th thread to start. The
 * ordinal is the only ordering here that means anything, and it is TOTAL: G4-AI5 orders by
 * `started_at` and `assignAttemptOrdinals` breaks a tie on `attempt_id`
 * (`attempt-record.ts:314-319`). `edges` is built by walking `observedLifecycleStems`, a bare
 * unsorted `readdirSync`, so zipping edges in their own order would make the published map depend
 * on directory order and mis-pair IN SILENCE once one attempt spawns two threads — `nodeLinks`
 * (`trajectory-merge.ts:562-575`) checks that a link names a child of its caller, which is
 * MEMBERSHIP, not identity.
 *
 * Nothing here reads a tool result. The zip is well-defined only when the two lists have the same
 * length and every child names a thread and carries an ordinal; otherwise the WHOLE map is `null`,
 * never a partial one — `explicitLinksInCallOrder` requires a link for every call a fragment made,
 * so a partial map is a hard merge refusal, and guessing which call started which thread is what
 * M1 forbids. A trial whose counts disagree (a `thread_run` the §5.4 E2 limit refused) keeps a
 * derivable trajectory and simply fails C7's link-source conjunct, which is the honest outcome.
 */
export function deriveSubagentLinks(
  nodes: readonly AttemptRecord[],
  edges: readonly AttemptEdge[],
  journals: readonly AttemptJournal[],
): ThreadLink[] | null {
  const threadIdOf = new Map(nodes.map(node => [node.attempt_id, node.thread_id]));
  const ordinalOf = new Map(nodes.map(node => [node.attempt_id, node.attempt_ordinal]));
  const links: ThreadLink[] = [];
  for (const journal of journals) {
    const calls = journal.events.filter(isThreadRunCall);
    const children = edges
      .filter(edge => edge.kind === 'spawn'
        && edge.from.ref === 'attempt' && edge.from.id === journal.attempt_id)
      .map(edge => edgeAttemptId(edge.to));
    if (calls.length !== children.length) return null;
    if (children.some(id => id === null || ordinalOf.get(id) === undefined)) return null;
    const ordered = [...children as string[]]
      .sort((left, right) => ordinalOf.get(left)! - ordinalOf.get(right)!)
      .map(attemptId => threadIdOf.get(attemptId));
    if (ordered.some(threadId => typeof threadId !== 'string')) return null;
    calls.forEach((call, index) => {
      links.push({ callId: call.toolUseId, threadId: ordered[index] as string });
    });
  }
  return links;
}

/**
 * §9.2's node and edge sets, DERIVED from the lifecycle pairs F6 published rather than from a
 * hard-coded shape. A `direct` trial has exactly one pair and therefore exactly one node and zero
 * edges (§9.4 D2) — the same code path, not a special case.
 *
 * The edge is `spawn` (§9.2 ordinal 1, attempt → attempt): the parent process admitted the thread.
 * `decompose`/`dispatch` are the manager mode's task-mediated pair and no task exists here.
 */
function attemptGraph(
  run: PreparedRun,
  policy: ResolvedTrialPolicy,
  parent: Omit<AttemptRecord, 'attempt_ordinal'>,
  parentJournal: AttemptJournalScan,
): AttemptGraph {
  const built = observedLifecycleStems(run.options.trajectoryRoot)
    .filter(stem => stem !== parent.attempt_id)
    .map(stem => {
      const threadId = threadIdFromStem(stem);
      if (threadId === null) {
        throw new CompositeManifestError(
          'composite_manifest_invalid', `lifecycle stem ${stem} names no attempt`,
        );
      }
      return threadAttemptRecord(run, policy, stem, threadId);
    });
  const unordered = [{ record: parent, journal: parentJournal }, ...built]
    .sort((left, right) => (
      left.record.attempt_id < right.record.attempt_id ? -1
        : left.record.attempt_id > right.record.attempt_id ? 1 : 0
    ));
  // G4-AI4/AI5: 1-based, scoped to `task_id`, ordered by `started_at` — derived, never assumed.
  const ordinals = assignAttemptOrdinals(unordered.map(entry => ({
    attempt_id: entry.record.attempt_id,
    task_id: entry.record.task_id,
    started_at: entry.record.started_at,
  })));
  const nodes = unordered.map(entry => ({
    ...entry.record,
    attempt_ordinal: ordinals.get(entry.record.attempt_id)!,
  }));
  const edges = built.map((entry): AttemptEdge => ({
    kind: 'spawn',
    from: { ref: 'attempt', id: parent.attempt_id },
    to: { ref: 'attempt', id: entry.record.attempt_id },
  }));
  const journals = unordered.map(entry => ({
    attempt_id: entry.record.attempt_id,
    events: entry.journal.events,
  }));
  return { nodes, edges, journals, subagentLinks: deriveSubagentLinks(nodes, edges, journals) };
}

/** Nesting depth of `subagent_trajectories` in the PUBLISHED ATIF; 0 when the root has none. */
function atifSubagentLevels(trajectory: Record<string, unknown>): number {
  const children = trajectory.subagent_trajectories;
  if (!Array.isArray(children) || children.length === 0) return 0;
  return 1 + Math.max(...children.map(
    child => atifSubagentLevels(child as Record<string, unknown>),
  ));
}

function atifPaths(run: PreparedRun): { staged: string; published: string } {
  return {
    staged: path.join(run.options.trajectoryRoot, STAGED_ATIF_FILE),
    published: path.join(run.options.trajectoryRoot, ATIF_TRAJECTORY_FILE),
  };
}

/**
 * F8's ATIF half, IN-PROCESS (G4-PB5: spawning a Node child here would create a descendant AFTER F2
 * proved quiescence and falsify the very evidence §9.4 G2 publishes). Before this the merge had no
 * production writer at all — its only executor was a CLI nothing dispatches (§17 17.4.2).
 *
 * Merged to a STAGING path, never straight to `trajectory.json`. §9.5 F8 (`design:2815`) publishes
 * the composite manifest and the merged ATIF **atomically**, and F8 publishes a PAIR: the checklist
 * that decides whether the trial is gradable at all reads this tree (§9.4 C7), so the tree must
 * exist before the decision — and the decision can still refuse. Merging straight to the final path
 * would leave a complete, collectable interchange document behind for a trial that published no
 * manifest, and, because the merge's own `output_path_exists` is a HARD failure
 * (`trajectory-merge.ts:648-653`), would turn any second attempt in the same artifacts root into
 * that refusal instead of its real outcome. Staging keeps both halves all-or-nothing.
 *
 * A merge REFUSAL is recorded, not thrown, and the distinction is load-bearing. §9.5's instrument
 * for "this trial is not gradable" is the §9.4 checklist, NOT the exit code, which §5.2 gives to
 * the terminal classification. Throwing here would relabel a `completed` run whose backend simply
 * reported no cost as `protocol_violation`, destroying the terminal truth F6 published. The refusal
 * instead leaves its typed reason on stderr and returns `null`, which is decisive for C7 and for
 * §9.6 A2's totals.
 */
function stageAtifTrajectory(
  run: PreparedRun,
  dag: CompositeManifest,
  links: readonly ThreadLink[] | null,
  state: unknown,
  io: AgentRunIo,
): PublishedAtifFacts | null {
  if (state !== 'completed') return null;
  const outputPath = atifPaths(run).staged;
  try {
    mergeTrajectory({
      trajectoryRoot: run.options.trajectoryRoot,
      outputPath,
      attemptDag: dag,
      // §9.3 M1: the in-trial link map is the DAG's, so `collectThreadLinks` is not consulted.
      ...(links && links.length > 0 ? { subagentLinks: [...links] } : {}),
    });
  } catch (error) {
    if (!(error instanceof TrajectoryMergeError)) throw error;
    io.stderr.write(`${JSON.stringify({ reason: error.reason, detail: error.message })}\n`);
    return null;
  }
  const merged = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
  const extra = (merged.extra ?? {}) as Record<string, unknown>;
  return {
    subagentLevels: atifSubagentLevels(merged),
    linkSource: String(extra.subagent_link_source),
    finalMetrics: merged.final_metrics as PublishedAtifFacts['finalMetrics'],
  };
}

/**
 * The staged tree becomes the published one only once nothing can still refuse the trial.
 *
 * `link` and not `rename`: staging moved the merge's own `assertOutputPrecondition` onto the
 * staging path, so this commit is the ONLY thing still guarding the final one, and §9.3 M9
 * (`design:2723`) keeps the shipped publication verbatim — a pre-existing output is
 * `output_path_exists`. `rename(2)` replaces its destination in silence; `link(2)` raises EEXIST.
 * Reported through the SHIPPED reason `publishComposite` already raises for its own half
 * (`composite-manifest.ts:706,722`) — no new vocabulary.
 *
 * `owned` gains the FINAL path the instant the link lands, before anything that can still throw.
 * A flag the CALLER sets after this function returns would be false whenever the cleanup below
 * failed, and the discard would then sweep the staging name while the PUBLISHED tree survived a
 * refused trial — the exact orphan this staging exists to remove, reintroduced by the bookkeeping
 * rather than by the publication.
 */
function commitStagedAtif(run: PreparedRun, owned: string[]): void {
  const paths = atifPaths(run);
  try {
    fs.linkSync(paths.staged, paths.published);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    throw new CompositeManifestError('output_path_exists', paths.published);
  }
  owned.push(paths.published);
  fs.rmSync(paths.staged, { force: true });
}

/**
 * Sweeps every path F8 took responsibility for, and NOTHING else. `owned` is the whole record:
 * the staging name unconditionally, because no other writer in the system produces it (G4-PB6
 * keeps exactly one production writer), and `trajectory.json` only once the link that published it
 * returned — which is why a trial refused BEFORE the commit leaves a pre-existing `trajectory.json`
 * untouched instead of destroying an artifact this run did not create.
 *
 * A removal that fails for anything other than `ENOENT` (which `force` already suppresses) leaves
 * the orphan this whole staging dance exists to prevent, so it is REPORTED rather than swallowed —
 * an unreported orphan is strictly worse than a reported one, because the next run in this
 * artifacts root will fail `output_path_exists` with no record of why. Reported the way the lease
 * echo reports its own non-fatal plumbing fault: a plain diagnostic line, deliberately NOT a typed
 * `reason` record, because no §8.7 code covers it and inventing one is forbidden.
 */
function discardAtif(owned: readonly string[], io: AgentRunIo): void {
  for (const target of owned) {
    try {
      fs.rmSync(target, { force: true });
    } catch (error) {
      io.stderr.write(
        `atif discard failed: ${target}: ${(error as Error)?.message ?? String(error)}\n`,
      );
    }
  }
}

/** The parent process's own attempt — one fragment, one journal, one lifecycle pair (§17 17.3.1). */
function parentAttemptRecord(
  run: PreparedRun,
  policy: ResolvedTrialPolicy,
  terminal: Record<string, unknown>,
  stats: RunStats,
): Omit<AttemptRecord, 'attempt_ordinal'> {
  const attemptId = mintAttemptId(run.rootRunId, null);
  const terminalRelative = `${attemptId}.terminal.json`;
  const tokens = (terminal.tokens ?? {}) as Record<string, number | null | undefined>;
  return {
    trial_id: policy.trial_id,
    root_run_id: run.rootRunId,
    // G4-CM11: a taskless mode RE-USES `trial_id` as `task_id` — an existing authoritative
    // identifier rather than a mint, which is the distinction that makes it legal under §9.6 A5.
    task_id: policy.trial_id,
    parent_task_id: null,
    dispatch_generation: null,
    attempt_id: attemptId,
    thread_id: null,
    parent_thread_id: null,
    root_thread_id: null,
    task_ancestry: [policy.trial_id],
    template: null,
    // G4-AI8: verbatim the journal header's `agentSlot` (written from this same value at `:727`).
    role: run.options.agentSlot,
    stage: null,
    backend: policy.model_execution.backend,
    provider: runProvider(run),
    requested_model: runRequestedModel(run),
    // Never defaulted to `requested_model`: that is synthesized data labelled native (§9.6 A5).
    reported_model: stats.reportedModel,
    model_execution_identity_hash: run.identity.modelExecutionIdentityHash,
    role_tool_surface_hash: run.identity.roleToolSurfaceHash,
    bundle_manifest_hash: run.identity.bundleManifestHash,
    terminal_state: terminal.state as AttemptRecord['terminal_state'],
    terminal_reason: terminal.terminal_reason as AttemptRecord['terminal_reason'],
    disposition: 'none',
    superseded_by: null,
    artifact_path: null,
    artifact_sha256: null,
    journal_path: terminal.journal_path as string,
    journal_sha256: terminal.journal_sha256 as string,
    event_count: terminal.event_count as number,
    terminal_manifest_path: terminalRelative,
    // (17.1.4) field 32 is NEW: hashed over the PUBLISHED bytes, after the rename that publishes
    // them — never over the pre-publication buffer.
    terminal_manifest_sha256: createHash('sha256')
      .update(fs.readFileSync(path.join(run.options.trajectoryRoot, terminalRelative)))
      .digest('hex'),
    edges: [],
    started_at: terminal.started_at as string,
    ended_at: terminal.ended_at as string,
    steps: (terminal.steps ?? null) as number | null,
    cost_usd: (terminal.cost_usd ?? null) as number | null,
    // All four members always present (G4-CM2).
    tokens: {
      input: tokens.input ?? null,
      output: tokens.output ?? null,
      cache_read: tokens.cache_read ?? null,
      cache_creation: tokens.cache_creation ?? null,
    },
    // G4-N4: no shipped mechanism produces a per-attempt request count. Writing 0 is forbidden.
    provider_requests: null,
  };
}

function taggedCount(value: number | null): Tagged<number> {
  return value === null
    ? { status: 'unavailable', reason: 'journal_underivable' }
    : { status: 'available', value };
}

/**
 * Gate 8 delivers the value; Gate 4 delivers the carrier. Both operands are recorded at their
 * honest availability and nothing is defaulted to zero (§9.6 A5, R-A5-1):
 *
 * - the PROXY is A1-authoritative and runs on the HOST, so from inside the container its counters
 *   are unreadable — every proxy figure is `counter_unreadable`, never 0;
 * - `journal.requests` is PERMANENTLY unavailable (G4-RQ1): Cortex has no request counter, and the
 *   two sides count different events, so a conversion between them would be a guess.
 *
 * The record this returns is placed VERBATIM and no arithmetic is performed on it (G4-CM23).
 */
/**
 * §9.6 A2 (`design:2840`) names ONE producer for the journal side: the totals are "summed
 * recursively over the DAG using the SHIPPED ACCUMULATOR, which refuses to guess", and the row is
 * marked `shipped`, not NEW. That accumulator is the merge's `addPlanMetrics`
 * (`trajectory-merge.ts:853`) and its answer is the merged tree's `final_metrics`. Re-summing the
 * terminal manifests here would put a SECOND derivation of the same quantity in the same process,
 * never compared against the first, and then label it `source: 'trajectory_merge'` — a claim about
 * provenance the merge did not make.
 *
 * A2 also fixes the MAPPING, because it names the accumulator's four operands: `prompt_tokens`,
 * `tokens_out`, `cached_tokens`, `cost_usd`. They land on §9.2's `tokens.input`, `tokens.output`,
 * `tokens.cached` and `cost_usd` respectively.
 *
 * When the accumulator REFUSED there is no journal side at all: every figure is `unavailable`,
 * never zero (§9.6 A5) and never a substitute sum. That is the accumulator's own semantics rather
 * than a weakening — `assertMetricsDerivable` refuses the whole aggregate the moment any one
 * operand is missing, so a per-field fallback would report figures it had just been told nobody
 * could derive.
 */
function journalTotalsFrom(atif: PublishedAtifFacts | null): Pick<
  JournalTotals, 'cost_usd' | 'steps' | 'tokens'
> {
  const metrics = atif?.finalMetrics ?? null;
  return {
    cost_usd: journalCostFromNumber(metrics?.total_cost_usd ?? null),
    steps: taggedCount(metrics?.total_steps ?? null),
    tokens: {
      input: taggedCount(metrics?.total_prompt_tokens ?? null),
      output: taggedCount(metrics?.total_completion_tokens ?? null),
      cached: taggedCount(metrics?.total_cached_tokens ?? null),
    },
  };
}

function attemptAccounting(
  policy: ResolvedTrialPolicy,
  nodes: readonly AttemptRecord[],
  parentAttemptId: string,
  atif: PublishedAtifFacts | null,
): AccountingRecord {
  const unreadable = { status: 'unavailable', reason: 'counter_unreadable' } as const;
  const proxy: ProxyExport = {
    schema_version: PROXY_EXPORT_SCHEMA_VERSION,
    trial_id: policy.trial_id,
    adapter_id: parentAttemptId,
    requests: unreadable,
    cost_usd: unreadable,
    input_tokens: unreadable,
    output_tokens: unreadable,
    audit_log: unreadable,
    lease_echo: unreadable,
    source: 'proxy_export',
  };
  const journal: JournalTotals = {
    requests: { status: 'unavailable', reason: 'journal_underivable' },
    ...journalTotalsFrom(atif),
    source: 'trajectory_merge',
    // A4's named set: the roles the attempt DAG DID account for, so an excess can be reported
    // against it rather than absorbed.
    roles: [...new Set(nodes.map(node => node.role))],
  };
  return reconcileAccounting(proxy, journal);
}

/**
 * F7 and F8's composite-manifest half, at §17 G4-PB2's call site: AFTER F6's terminal manifest and
 * BEFORE `writeTerminalOutput`, because that line carries `ok` and `state` (`:753-761`) and §4.5
 * rules that §5.2's `completed` status is written against F8 — a terminal line emitted before F8
 * would report a status F8 had not yet earned.
 *
 * G4-PB5: `mergeTrajectory` is never spawned as a CLI here. F8 runs after F2 has proven
 * quiescence, and creating a Node descendant at this point would falsify the very evidence §9.4 G2
 * publishes. Nothing in this path spawns a process.
 *
 * Fails CLOSED: a benchmark run that cannot publish its manifest is not gradable, and the refusal
 * rides the shipped codes 39/40 with its JSON reason on stderr — the class-R invariant.
 */
function publishCompositeManifest(
  run: PreparedRun,
  terminal: Record<string, unknown> | null,
  stats: RunStats,
  io: AgentRunIo,
): void {
  const applicability = compositeApplicability(run, terminal);
  if (!applicability.applicable) return;
  const { policy } = applicability;
  // Seeded with the staging name because F8 owns that name whether or not this run created a file
  // under it; `trajectory.json` joins the list only when the commit publishes it.
  const owned: string[] = [atifPaths(run).staged];
  try {
    const mode = policy.arm.orchestration?.mode;
    if (!mode) {
      throw new CompositeManifestError(
        'composite_manifest_invalid', 'the arm declares no orchestration mode',
      );
    }
    const parent = parentAttemptRecord(run, policy, terminal!, stats);
    const parentJournal = scanAttemptJournal(run.options.trajectoryRoot, parent.journal_path);
    const graph = attemptGraph(run, policy, parent, parentJournal);
    const shape = {
      trial_id: policy.trial_id,
      root_run_id: run.rootRunId,
      arm_name: policy.arm.name,
      arm_canonical_sha256: policy.arm_canonical_sha256,
      // Copied from the frozen policy, never recomputed: §1.4 is the only authority on identity.
      identity: policy.identity,
      nodes: graph.nodes,
      edges: graph.edges,
      roots: { parent_attempt_id: parent.attempt_id, root_task_id: null },
      mode: mode as OrchestrationModeName,
    };
    // Built twice from the same pure inputs, published once. The first build exists only to give
    // the merge G4-CM12's canonical node order — re-deriving an order inside the merge would make
    // the published tree depend on the merge instead of on the document it walks — and §9.4 C7
    // cannot be evaluated until the tree that build produces has been merged.
    //
    // Its `accounting` is a value the merge never reads: `AttemptDag`
    // (`trajectory-merge.ts:71-78`) declares only `nodes`, `edges`, `roots` and `identity`. It
    // cannot be the real one, because §9.6 A2's journal side IS the merge's own output and
    // therefore cannot exist before the merge runs.
    const atif = stageAtifTrajectory(
      run,
      buildCompositeManifest({
        ...shape, accounting: attemptAccounting(policy, graph.nodes, parent.attempt_id, null),
      }),
      graph.subagentLinks,
      terminal!.state,
      io,
    );
    const manifest = buildCompositeManifest({
      ...shape,
      accounting: attemptAccounting(policy, graph.nodes, parent.attempt_id, atif),
      evaluatedChecks: evaluateTerminalChecks({
        mode: shape.mode,
        terminalState: terminal!.state,
        nodes: graph.nodes,
        edges: graph.edges,
        attempts: graph.journals,
        atif,
      }),
    });
    const violations = validateCompositeManifest(manifest, {
      limits: {
        max_task_depth: policy.limits.max_task_depth,
        max_tasks: policy.limits.max_tasks,
      },
      lifecycleStems: observedLifecycleStems(run.options.trajectoryRoot),
    });
    if (violations.length > 0) {
      throw new CompositeManifestError(
        'composite_manifest_invalid',
        violations.map(violation => violation.code).join(','),
        violations,
      );
    }
    // §9.5's grader-admission rule: an EVALUATED §9.4 row that failed rides the shipped code 41.
    assertTerminalPredicate(manifest.predicate);
    // Nothing can refuse the trial past this line, so the PAIR is published: the tree first, then
    // the manifest, which is the document §9.5's admission rule keys on and therefore goes last.
    if (atif !== null) commitStagedAtif(run, owned);
    publishComposite(manifest, path.join(run.options.trajectoryRoot, COMPOSITE_MANIFEST_FILE));
  } catch (error) {
    // §9.5 F8: the publication is all-or-nothing. A refused trial leaves NO tree behind — neither
    // the staged half nor, if the manifest write itself failed, the committed one. An orphaned
    // `trajectory.json` is a collectable interchange document for a trial that was never admitted,
    // and it turns the merge's `output_path_exists` into the reason a re-run reports.
    discardAtif(owned, io);
    if (error instanceof CompositeManifestError || error instanceof TerminalPredicateError) {
      io.stderr.write(`${JSON.stringify(error.record())}\n`);
    }
    throw error;
  }
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
    const stats: RunStats = {
      input: 0, output: 0, sawInput: false, sawOutput: false, reportedModel: null,
    };
    const outcome = await executeTurn(run, journal, io, stats);
    const classified = classify(outcome);
    const manifest = terminalManifest(run, journal, stats, outcome, classified);
    // F7 + F8 (§9.5): build the attempt DAG, then publish the composite manifest atomically.
    publishCompositeManifest(run, manifest, stats, io);
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
    try { await run?.trial?.close(); }
    finally { restoreLogging(); }
  }
}
