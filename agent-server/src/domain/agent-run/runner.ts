// input:  parsed one-shot options, argv-closed config, Claude adapter
// output: completion-only supervised turn, journal, terminal manifest, exit status
// pos:    Agent-run lifecycle coordinator
// >>> If I am updated, update my header and folder CORTEX.md <<<

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
  AgentProcessSpawner, AgentProcessSupervision, AgentSpawnConfig, NormalizedEvent,
} from '../../agent-adapter/index.js';
import {
  buildAgentSpawnConfig, runWithAdapter,
  type AgentConfig, type RunAgentOptions, type RunObserver,
} from '../agents/facade.js';
import { listProfiles, resolveProfileConfig } from '../agents/profile-manager.js';
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
  loadAgentRunConfig, resolvedRouteHost, validateResolvedExecution,
  type ResolvedAgentRunConfig,
} from './run-config.js';
import { roleSurfaceFromSpawnConfig } from './role-surface.js';
import {
  SupervisorContainmentError, attachSupervisor, exitCodeFor,
  type ExitReason, type SupervisorSession,
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
  identity: FrozenIdentity;
  spawnConfig: AgentSpawnConfig;
  baseOptions: RunAgentOptions;
  hashes: ReturnType<typeof promptHashes>;
  startedAt: string;
}

interface RunStats {
  input: number;
  output: number;
  sawTokens: boolean;
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
): FrozenIdentity {
  return freezeIdentity({
    resolvedProfile: profile,
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

function executablePath(candidate: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = candidate.includes(path.sep)
    ? [path.resolve(candidate)]
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, candidate));
  for (const file of candidates) {
    try {
      const resolved = fs.realpathSync(file);
      fs.accessSync(resolved, fs.constants.X_OK);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {}
  }
  return null;
}

function resolveSupervisorBinary(candidate: string): string {
  const resolved = executablePath(candidate, process.env);
  if (resolved) return resolved;
  throw new SupervisorContainmentError('spawn_failed', {
    cause: new Error(`Supervisor binary is missing or not executable: ${candidate}`),
  });
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

function observedRunConfig(
  config: ResolvedAgentRunConfig,
  profile: PreparedRun['profile'],
  cwd: string,
): ResolvedAgentRunConfig {
  return {
    ...config,
    modelExecution: {
      ...config.modelExecution,
      configuredRouteBaseHost: resolvedRouteHost(profile),
      claudeCliVersion: probeClaudeVersion(profile, cwd),
    },
  };
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

function resolveRunConfig(
  options: AgentRunCliOptions,
  profile: PreparedRun['profile'],
): ResolvedAgentRunConfig {
  const configured = loadAgentRunConfig(options.runConfigFile);
  validateResolvedExecution(profile, configured);
  assertMcpFiles(configured);
  return observedRunConfig(configured, profile, options.cwd);
}

function prepareRun(rawOptions: AgentRunCliOptions, rootRunId: string): PreparedRun {
  assertFreshTrajectory(rawOptions, rootRunId);
  const options = {
    ...rawOptions,
    supervisorBinary: resolveSupervisorBinary(rawOptions.supervisorBinary),
  };
  const prompt = readPrompt(options.promptFile);
  const profile = resolveProfile(options.profile);
  assertClaudeProfile(profile);
  const config = resolveRunConfig(options, profile);
  const baseOptions = baseRunOptions(options, profile, config, `agent-run:${rootRunId}`);
  const spawnConfig = buildAgentSpawnConfig(baseOptions, agentConfig(profile), undefined);
  const roleSurface = roleSurfaceFromSpawnConfig(spawnConfig);
  return {
    options, rootRunId, profile, config, spawnConfig, baseOptions,
    modelPrompt: prompt.modelVisible,
    identity: freezeRunIdentity(options, profile, config, roleSurface),
    hashes: promptHashes(prompt, roleSurface),
    startedAt: new Date().toISOString(),
  };
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
  stats.sawTokens = true;
  stats.input += event.tokens_in;
  stats.output += event.tokens_out;
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
        backend: 'claude',
        provider: run.profile.provider,
        requestedModel: run.profile.model,
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
  adapter: ClaudeAdapter,
  run: PreparedRun,
  handle: AgentHandle,
  supervision: SupervisorSession | null,
  cancelled: () => boolean,
): Promise<ExecutionOutcome> {
  const handleOutcome = await settleHandle(handle);
  await adapter.close(`agent-run:${run.rootRunId}`);
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
  const adapter = new ClaudeAdapter();
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
    handle = runWithAdapter(adapter, run.modelPrompt, options, agentConfig(run.profile), undefined);
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
    costUsd: outcome.result?.total_cost_usd ?? null,
    tokens: {
      input: stats.sawTokens ? stats.input : null,
      output: stats.sawTokens ? stats.output : null,
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
    const stats: RunStats = { input: 0, output: 0, sawTokens: false };
    const outcome = await executeTurn(run, journal, io, stats);
    const classified = classify(outcome);
    const manifest = terminalManifest(run, journal, stats, outcome, classified);
    writeTerminalOutput(io, rootRunId, manifest, classified);
    return classified.exitCode;
  } catch (error) {
    await journal?.close().catch(() => {});
    const classified = classifyStartupFailure(error);
    io.stderr.write(`${(error as Error)?.message ?? String(error)}\n`);
    writeTerminalOutput(io, rootRunId, null, classified);
    return classified.exitCode;
  } finally {
    restoreLogging();
  }
}
