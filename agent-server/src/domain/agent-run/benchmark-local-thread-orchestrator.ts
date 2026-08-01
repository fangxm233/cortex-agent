// input:  frozen request, injected thread runtime, lifecycle primitives
// output: externally durable C9 terminal thread result
// pos:    Daemon-free benchmark thread lifecycle coordinator
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentProcessSpawner, AgentProcessSupervision,
} from '../../agent-adapter/types.js';
import { runningExecutions as daemonRunningExecutions } from '../../core/running-executions.js';
import type { AgentSlotId, ThreadRecord } from '../../core/types/thread-types.js';
import { resolveProfileConfig as daemonResolveProfile } from '../agents/profile-manager.js';
import { ctx as jobCtx } from '../scheduling/job-registry.js';
import {
  cancelThread as daemonCancelThread,
  createThread as daemonCreateThread,
  getTemplate as daemonGetTemplate,
  loadConfig as daemonLoadConfig,
  resolveTemplateAgents as daemonResolveTemplateAgents,
} from '../threads/index.js';
import {
  createLocalThreadRuntimeDeps,
  getLocalThreadRuntimeDeps,
  scopedLocalThreadService,
  withLocalThreadRuntimeDeps,
  type LocalThreadRuntimeDeps,
} from '../threads/local-runtime-deps.js';
import {
  BenchmarkRateLimitError, runThread, type ThreadRunResult,
} from '../threads/runner.js';
import type { PlatformAdapter } from '../../platform/adapter.js';
import type { OutputStream } from '../../platform/output-stream.js';
import type { PlatformCapabilities } from '../../platform/types.js';
import { executionRepo as daemonExecutionRepo } from '../../store/execution-repo.js';
import { sessionStore as daemonSessionStore } from '../../store/session-registry-repo.js';
import { threadStore as daemonThreadStore } from '../../store/thread-repo.js';
import { canonicalJsonSha256 } from './identity.js';
import {
  openJournal, TrajectoryWriteFailedError, type AgentSlot, type Journal,
} from './journal.js';
import {
  resolveLifecyclePaths, validateTrajectoryLifecycle, writeStartedMarker, writeTerminalManifest,
  type TerminalManifestInput, type TerminalReason, type TerminalState,
} from './manifest.js';
import { terminalManifestProblem } from './manifest-contract.js';
import { attachSupervisor, type SupervisorSession } from './supervisor.js';

interface BenchmarkThreadRequest {
  workspaceCwd: string;
  template: string;
  instruction: string;
  profileName: string;
  rootRunId: string;
  trajectoryRoot: string;
  limits: { maxSteps: number; maxCostUsd: number; deadlineEpochMs: number };
  signal: AbortSignal;
}

interface BenchmarkThreadResult {
  threadId: string;
  state: 'completed' | 'failed' | 'cancelled' | 'timeout';
  terminalReason: string | null;
  artifactPath: string | null;
  journalPath: string;
  manifestPath: string;
  steps: number;
  costUsd: number;
  durationMs: number;
  summary: string;
}

const runningExecutions = scopedLocalThreadService(
  daemonRunningExecutions,
  deps => deps.liveExecutions,
);
const executionRepo = scopedLocalThreadService(
  daemonExecutionRepo,
  deps => deps.executionStore,
);
const sessionStore = scopedLocalThreadService(daemonSessionStore, deps => deps.sessionStore);
const threadStore = scopedLocalThreadService(daemonThreadStore, deps => deps.threadStore);
const resolveProfileConfig: typeof daemonResolveProfile = (...args) => (
  (getLocalThreadRuntimeDeps()?.resolveProfile ?? daemonResolveProfile)(...args)
);
const getTemplate: typeof daemonGetTemplate = (...args) => (
  (getLocalThreadRuntimeDeps()?.getTemplate ?? daemonGetTemplate)(...args)
);
const loadConfig: typeof daemonLoadConfig = (...args) => (
  (getLocalThreadRuntimeDeps()?.loadTemplates ?? daemonLoadConfig)(...args)
);
const resolveTemplateAgents: typeof daemonResolveTemplateAgents = (...args) => (
  (getLocalThreadRuntimeDeps()?.resolveTemplateAgents ?? daemonResolveTemplateAgents)(...args)
);
const createThread: typeof daemonCreateThread = (...args) => (
  (getLocalThreadRuntimeDeps()?.createThread ?? daemonCreateThread)(...args)
);
const cancelThread: typeof daemonCancelThread = (...args) => (
  (getLocalThreadRuntimeDeps()?.cancelThread ?? daemonCancelThread)(...args)
);

type ResolvedProfile = ReturnType<typeof resolveProfileConfig>;
type ResolvedTemplate = NonNullable<ReturnType<typeof getTemplate>>;
type StopReason = 'cancel' | 'deadline' | 'step_limit' | 'cost_limit';

interface RunIdentity {
  canonicalInstructionSha256: string;
  modelVisiblePromptSha256: string;
  systemPromptSha256: string;
  toolManifestSha256: string;
  pluginManifestSha256: string;
  modelExecutionIdentityHash: string;
  roleToolSurfaceHash: string;
  bundleManifestHash: string;
}

interface PreparedThreadRun {
  request: BenchmarkThreadRequest;
  profile: ResolvedProfile;
  template: ResolvedTemplate;
  thread: ThreadRecord;
  journal: Journal;
  lifecycle: { started: string; terminal: string };
  identity: RunIdentity;
  startedAt: string;
}

interface RunControl {
  admissionOpen: boolean;
  admitted: number;
  reason: StopReason | null;
  sessions: SupervisorSession[];
  threadId: string;
  request: BenchmarkThreadRequest;
  timer: NodeJS.Timeout | null;
  abortHandler: () => void;
}

interface RunOutcome {
  result: ThreadRunResult | null;
  error: unknown;
  quiescent: boolean;
  durabilityError: unknown;
}

interface ClassifiedRun {
  state: TerminalState;
  reason: TerminalReason;
}

const BENCHMARK_SLOTS = new Set<AgentSlotId>(['benchmark-coder', 'benchmark-reviewer']);
const SUMMARY_LIMIT = 2000;
const MAX_TIMER_MS = 2_147_483_647;

class BenchmarkAdmissionError extends Error {
  constructor(readonly detail: 'max_steps' | 'max_cost' | 'deadline') {
    super(`Benchmark thread admission stopped: ${detail}`);
    this.name = 'BenchmarkAdmissionError';
  }
}

const NOOP_CAPABILITIES: PlatformCapabilities = {
  threads: false,
  messageEdit: false,
  modals: false,
  reactions: false,
  fileUpload: false,
  richFormatting: false,
  maxMessageLength: Infinity,
  maxThreadDepth: 0,
};

const NOOP_STREAM: OutputStream = {
  emitText: () => {},
  openMutable: () => ({ update: () => {} }),
  postInteractive: async () => null,
  flush: async () => {},
  getRefs: () => [],
  getParentRef: () => null,
};

function noopRef() {
  return { conduit: '', messageId: '' };
}

function createNoopAdapter(): PlatformAdapter {
  return {
    name: 'benchmark-local-noop', capabilities: NOOP_CAPABILITIES,
    start: async () => {}, stop: async () => {},
    onMessage: () => {}, onMessageEdit: () => {}, onAction: () => {}, onModalSubmit: () => {},
    postMessage: async () => noopRef(), updateMessage: async () => {}, deleteMessage: async () => {},
    postInteractive: async () => noopRef(), openModal: async () => {},
    markQueued: async () => {}, unmarkQueued: async () => {},
    uploadFile: async () => {},
    downloadFile: async () => ({ localPath: '', mimetype: '', name: '' }),
    getPermalink: async () => null,
    openOutputStream: () => NOOP_STREAM,
    bindProjectConduit: async () => {}, unbindProjectConduit: async () => {},
    getProjectConduits: async () => ({}), resolveInboundProject: async () => null,
    ownsConduit: () => false,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isDirectory(directory: string): boolean {
  try { return fs.statSync(directory).isDirectory(); }
  catch { return false; }
}

function validateLimits(request: BenchmarkThreadRequest): void {
  const { maxSteps, maxCostUsd, deadlineEpochMs } = request.limits;
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new Error('Benchmark maxSteps must be a positive integer');
  }
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new Error('Benchmark maxCostUsd must be non-negative');
  }
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= 0) {
    throw new Error('Benchmark deadlineEpochMs must be an absolute positive integer');
  }
}

function validateRequest(request: BenchmarkThreadRequest): void {
  if (!path.isAbsolute(request.workspaceCwd) || !isDirectory(request.workspaceCwd)) {
    throw new Error('Benchmark workspaceCwd must be an existing absolute directory');
  }
  if (!path.isAbsolute(request.trajectoryRoot)) {
    throw new Error('Benchmark trajectoryRoot must be absolute');
  }
  if (!request.template || !request.profileName || !request.rootRunId) {
    throw new Error('Benchmark template, profileName, and rootRunId are required');
  }
  validateLimits(request);
}

function initializeRuntime(): void {
  jobCtx.bus = getLocalThreadRuntimeDeps()?.eventBus ?? null;
  executionRepo.load();
  threadStore.load();
  loadConfig();
}

function resolveProfile(name: string): ResolvedProfile {
  const profile = resolveProfileConfig(name);
  if (profile.backend !== 'claude' || profile.claudeBackend !== 'print') {
    throw new Error('Benchmark profile must use Claude print mode');
  }
  if (profile.fallback.length > 0) {
    throw new Error('Benchmark profile must not define fallbacks');
  }
  return profile;
}

function resolveTemplate(name: string): ResolvedTemplate {
  const template = getTemplate(name);
  if (!template) throw new Error(`Unknown benchmark template: ${name}`);
  const agents = resolveTemplateAgents(template);
  if (agents.length === 0 || agents.some(agent => !BENCHMARK_SLOTS.has(agent.slotId))) {
    throw new Error('Benchmark template contains a non-benchmark agent slot');
  }
  if (!BENCHMARK_SLOTS.has(template.entryAgent)) {
    throw new Error('Benchmark template entry agent is not a benchmark slot');
  }
  return template;
}

function roleAgent(template: ResolvedTemplate) {
  return resolveTemplateAgents(template).find(agent => agent.slotId === template.entryAgent)!;
}

function identityInput(
  request: BenchmarkThreadRequest,
  profile: ResolvedProfile,
  template: ResolvedTemplate,
) {
  const agent = roleAgent(template);
  return {
    agent,
    instruction: request.instruction,
    limits: request.limits,
    paths: { workspaceCwd: request.workspaceCwd, trajectoryRoot: request.trajectoryRoot },
    profile,
    template,
  };
}

function freezeRunIdentity(
  request: BenchmarkThreadRequest,
  profile: ResolvedProfile,
  template: ResolvedTemplate,
): RunIdentity {
  const frozen = identityInput(request, profile, template);
  const agent = frozen.agent;
  const modelExecutionIdentityHash = canonicalJsonSha256(profile);
  const roleToolSurfaceHash = canonicalJsonSha256({
    agent, template, mcpComposition: 'none', hookPolicy: {},
  });
  return {
    canonicalInstructionSha256: sha256(request.instruction),
    modelVisiblePromptSha256: sha256(request.instruction),
    systemPromptSha256: sha256(agent.systemPrompt ?? ''),
    toolManifestSha256: canonicalJsonSha256((agent.tools ?? '').split(',').filter(Boolean)),
    pluginManifestSha256: canonicalJsonSha256(agent.pluginDirs ?? []),
    modelExecutionIdentityHash,
    roleToolSurfaceHash,
    bundleManifestHash: canonicalJsonSha256({
      ...frozen, modelExecutionIdentityHash, roleToolSurfaceHash,
    }),
  };
}

function createBenchmarkRecord(request: BenchmarkThreadRequest): ThreadRecord {
  return createThread(`benchmark:${request.rootRunId}`, {
    templateName: request.template,
    userMessage: request.instruction,
    userMessageTs: String(Date.now()),
    projectId: 'benchmark',
    metadata: { trigger: 'benchmark-local' },
  });
}

function openThreadJournal(
  request: BenchmarkThreadRequest,
  template: ResolvedTemplate,
  thread: ThreadRecord,
  identity: RunIdentity,
): Journal {
  const journalPath = path.join(request.trajectoryRoot, `thread-${thread.id}.journal.ndjson`);
  return openJournal({
    path: journalPath,
    header: {
      rootRunId: request.rootRunId, threadId: thread.id,
      agentSlot: template.entryAgent as AgentSlot,
      resolvedCwd: request.workspaceCwd, ...identity,
    },
  });
}

function writeRunStarted(
  request: BenchmarkThreadRequest,
  thread: ThreadRecord,
  journal: Journal,
  startedAt: string,
): void {
  writeStartedMarker({
    trajectoryRoot: request.trajectoryRoot, rootRunId: request.rootRunId,
    threadId: thread.id, journalPath: journal.path, now: () => new Date(startedAt),
  });
}

async function createRunArtifacts(
  request: BenchmarkThreadRequest,
  profile: ResolvedProfile,
  template: ResolvedTemplate,
  thread: ThreadRecord,
): Promise<PreparedThreadRun> {
  fs.mkdirSync(request.trajectoryRoot, { recursive: true });
  const lifecycle = resolveLifecyclePaths({
    trajectoryRoot: request.trajectoryRoot, rootRunId: request.rootRunId, threadId: thread.id,
  });
  const identity = freezeRunIdentity(request, profile, template);
  const journal = openThreadJournal(request, template, thread, identity);
  const startedAt = new Date().toISOString();
  try { writeRunStarted(request, thread, journal, startedAt); }
  catch (error) {
    await journal.close().catch(() => {});
    throw error;
  }
  return { request, profile, template, thread, journal, lifecycle, identity, startedAt };
}

async function prepareRun(request: BenchmarkThreadRequest): Promise<PreparedThreadRun> {
  validateRequest(request);
  initializeRuntime();
  const profile = resolveProfile(request.profileName);
  const template = resolveTemplate(request.template);
  const thread = createBenchmarkRecord(request);
  return createRunArtifacts(request, profile, template, thread);
}

function supervisorCancelReason(reason: StopReason | null): 'cancel' | 'deadline' {
  return reason === 'deadline' ? 'deadline' : 'cancel';
}

function cancelSessions(control: RunControl): void {
  const reason = supervisorCancelReason(control.reason);
  for (const session of control.sessions) session.cancel(reason);
}

function closeAdmission(control: RunControl, reason: StopReason): void {
  if (control.reason !== null) return;
  control.admissionOpen = false;
  control.reason = reason;
  void cancelThread(control.threadId).catch(() => {});
  runningExecutions.killByThreadId(control.threadId);
  cancelSessions(control);
}

function deadlineDelay(deadlineEpochMs: number): number {
  return Math.min(Math.max(0, deadlineEpochMs - Date.now()), MAX_TIMER_MS);
}

function installControl(prepared: PreparedThreadRun): RunControl {
  const control = {
    admissionOpen: true, admitted: 0, reason: null, sessions: [],
    threadId: prepared.thread.id, request: prepared.request,
    timer: null, abortHandler: () => {},
  } as RunControl;
  control.abortHandler = () => closeAdmission(control, 'cancel');
  prepared.request.signal.addEventListener('abort', control.abortHandler, { once: true });
  const delay = deadlineDelay(prepared.request.limits.deadlineEpochMs);
  control.timer = setTimeout(() => closeAdmission(control, 'deadline'), delay);
  control.timer.unref();
  if (prepared.request.signal.aborted) closeAdmission(control, 'cancel');
  return control;
}

function cleanupControl(control: RunControl): void {
  control.request.signal.removeEventListener('abort', control.abortHandler);
  if (control.timer) clearTimeout(control.timer);
}

function resourceAdmissionProblem(control: RunControl): BenchmarkAdmissionError | null {
  if (control.admitted >= control.request.limits.maxSteps) {
    return new BenchmarkAdmissionError('max_steps');
  }
  const cost = threadStore.get(control.threadId)?.totalCostUsd ?? 0;
  return cost > control.request.limits.maxCostUsd
    ? new BenchmarkAdmissionError('max_cost') : null;
}

function admissionProblem(control: RunControl): BenchmarkAdmissionError | null {
  if (control.reason === 'deadline') return new BenchmarkAdmissionError('deadline');
  if (!control.admissionOpen) return new BenchmarkAdmissionError('max_steps');
  return resourceAdmissionProblem(control);
}

function remainingDeadline(control: RunControl): number {
  return Math.max(0, control.request.limits.deadlineEpochMs - Date.now());
}

function stopForAdmissionProblem(control: RunControl, problem: BenchmarkAdmissionError): void {
  const reasons: Record<BenchmarkAdmissionError['detail'], StopReason> = {
    max_steps: 'step_limit', max_cost: 'cost_limit', deadline: 'deadline',
  };
  closeAdmission(control, reasons[problem.detail]);
}

function createSpawner(control: RunControl): AgentProcessSpawner {
  return (command, args, options) => {
    const problem = admissionProblem(control);
    if (problem) {
      stopForAdmissionProblem(control, problem);
      throw problem;
    }
    const session = attachSupervisor({
      binary: process.env.CORTEX_SUPERVISOR_BINARY ?? 'cortex-supervisor',
      args: [command, ...args],
      deadlineMs: remainingDeadline(control),
      cwd: options.cwd?.toString(), env: options.env, stdio: 'pipe',
    });
    control.admitted += 1;
    control.sessions.push(session);
    return {
      process: session.process as ChildProcessWithoutNullStreams,
      supervision: session as AgentProcessSupervision,
    };
  };
}

function threadRunOptions(prepared: PreparedThreadRun, spawner: AgentProcessSpawner) {
  const channel = prepared.thread.channel;
  return {
    adapter: createNoopAdapter(), channel,
    destination: { type: 'interactive-reply' as const, conduit: channel, sessionId: '' },
    threadAnchorId: null, statusMsg: null, startTime: Date.now(), onProgress: null,
    benchmark: {
      workspaceCwd: prepared.request.workspaceCwd,
      resolvedProfileName: prepared.request.profileName,
      disableHooks: true as const,
      disableControlPlane: true as const,
      failFastOnRateLimit: true as const,
      spawner,
      limits: {
        maxSteps: prepared.request.limits.maxSteps,
        maxCostUsd: prepared.request.limits.maxCostUsd,
        deadlineMs: prepared.request.limits.deadlineEpochMs,
      },
    },
  };
}

async function runLocalThread(
  prepared: PreparedThreadRun,
  control: RunControl,
): Promise<{ result: ThreadRunResult | null; error: unknown }> {
  try {
    const result = await runThread(
      prepared.thread.id,
      threadRunOptions(prepared, createSpawner(control)),
    );
    return { result, error: null };
  } catch (error) {
    return { result: null, error };
  }
}

function asAgentSlot(value: string): AgentSlot {
  if (!BENCHMARK_SLOTS.has(value)) throw new Error(`Invalid benchmark journal agent slot: ${value}`);
  return value as AgentSlot;
}

function writeStepEvents(prepared: PreparedThreadRun, thread: ThreadRecord): unknown {
  try {
    for (const step of thread.steps) {
      prepared.journal.writeEvent({
        threadId: thread.id, step: step.stepIndex,
        agentSlot: asAgentSlot(step.agentSlotId), backend: 'claude',
        provider: prepared.profile.provider, requestedModel: prepared.profile.model,
        reportedModel: null,
        event: { type: 'assistant_text', text: step.output ?? '', model: null },
      });
    }
    return null;
  } catch (error) {
    return error;
  }
}

async function settleOneSupervisor(session: SupervisorSession): Promise<boolean> {
  try {
    await session.quiescent;
    await session.closed;
    return true;
  } catch {
    return false;
  }
}

async function settleSupervisors(control: RunControl): Promise<boolean> {
  if (control.sessions.length === 0) return true;
  const settled = await Promise.all(control.sessions.map(settleOneSupervisor));
  return settled.every(Boolean);
}

async function flushRepositories(): Promise<unknown> {
  try {
    await Promise.all([threadStore.flush(), sessionStore.flush(), executionRepo.flush()]);
    return null;
  } catch (error) {
    return new TrajectoryWriteFailedError('Benchmark repository flush failed', { cause: error });
  }
}

async function closeJournal(journal: Journal): Promise<unknown> {
  try {
    await journal.close();
    return null;
  } catch (error) {
    return error;
  }
}

function firstFailure(...failures: unknown[]): unknown {
  return failures.find(failure => failure !== null && failure !== undefined) ?? null;
}

function enforceFinalCost(control: RunControl, thread: ThreadRecord): void {
  const exceeds = thread.totalCostUsd > control.request.limits.maxCostUsd;
  if (control.reason === null && exceeds) closeAdmission(control, 'cost_limit');
}

async function executeRun(prepared: PreparedThreadRun, control: RunControl): Promise<RunOutcome> {
  const execution = await runLocalThread(prepared, control);
  const thread = threadStore.get(prepared.thread.id) ?? prepared.thread;
  enforceFinalCost(control, thread);
  const eventError = writeStepEvents(prepared, thread);
  if (eventError) cancelSessions(control);
  const quiescent = await settleSupervisors(control);
  const repositoryError = await flushRepositories();
  const journalError = quiescent ? await closeJournal(prepared.journal) : null;
  return {
    ...execution, quiescent,
    durabilityError: firstFailure(eventError, repositoryError, journalError),
  };
}

function errorReason(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { reason?: unknown }).reason;
  return typeof value === 'string' ? value : null;
}

function classifyFailure(error: unknown): ClassifiedRun {
  if (error instanceof BenchmarkRateLimitError) return { state: 'failed', reason: 'rate_limited' };
  if (errorReason(error) === 'trajectory_write_failed') {
    return { state: 'failed', reason: 'trajectory_write_failed' };
  }
  return { state: 'failed', reason: 'child_failure' };
}

function safetyClassification(outcome: RunOutcome): ClassifiedRun | null {
  if (!outcome.quiescent) return { state: 'failed', reason: 'containment_failure' };
  if (outcome.durabilityError) return { state: 'failed', reason: 'trajectory_write_failed' };
  return null;
}

function controlClassification(reason: StopReason): ClassifiedRun {
  const values: Record<StopReason, ClassifiedRun> = {
    cancel: { state: 'cancelled', reason: 'cancelled' },
    deadline: { state: 'timeout', reason: 'deadline_exceeded' },
    step_limit: { state: 'failed', reason: 'step_limit_exceeded' },
    cost_limit: { state: 'failed', reason: 'cost_limit_exceeded' },
  };
  return values[reason];
}

function executionClassification(prepared: PreparedThreadRun, outcome: RunOutcome): ClassifiedRun {
  if (outcome.error) return classifyFailure(outcome.error);
  const thread = threadStore.get(prepared.thread.id);
  if (thread?.status !== 'completed') return { state: 'failed', reason: 'child_failure' };
  return { state: 'completed', reason: 'ok' };
}

function classifyRun(
  prepared: PreparedThreadRun,
  control: RunControl,
  outcome: RunOutcome,
): ClassifiedRun {
  const safety = safetyClassification(outcome);
  if (safety) return safety;
  if (control.reason) return controlClassification(control.reason);
  return executionClassification(prepared, outcome);
}

function terminalInput(
  prepared: PreparedThreadRun,
  classified: ClassifiedRun,
  thread: ThreadRecord,
): TerminalManifestInput {
  return {
    trajectoryRoot: prepared.request.trajectoryRoot,
    canonicalTrajectoryRoot: true,
    rootRunId: prepared.request.rootRunId,
    threadId: thread.id,
    state: classified.state,
    startedAt: prepared.startedAt,
    endedAt: new Date().toISOString(),
    journalPath: prepared.journal.path,
    journalSha256: prepared.journal.sha256(),
    eventCount: prepared.journal.eventCount,
    supervisor: { quiescent: true, descendants: 0 },
    steps: thread.steps.length,
    costUsd: thread.totalCostUsd,
    tokens: { input: null, output: null },
    modelExecutionIdentityHash: prepared.identity.modelExecutionIdentityHash,
    roleToolSurfaceHash: prepared.identity.roleToolSurfaceHash,
    bundleManifestHash: prepared.identity.bundleManifestHash,
    terminalReason: classified.reason,
  };
}

function validCommittedManifest(
  prepared: PreparedThreadRun,
  file: string,
  classified: ClassifiedRun,
): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const lifecycle = validateTrajectoryLifecycle({
      trajectoryRoot: prepared.request.trajectoryRoot,
      canonicalTrajectoryRoot: true,
      rootRunId: prepared.request.rootRunId,
      threadId: prepared.thread.id,
    });
    return lifecycle.ok && terminalManifestProblem(record) === null
      && record.state === classified.state
      && record.terminal_reason === classified.reason;
  } catch {
    return false;
  }
}

function commitFailure(error: unknown): ClassifiedRun {
  const reason = errorReason(error) === 'trajectory_write_failed'
    ? 'trajectory_write_failed' : 'protocol_violation';
  return { state: 'failed', reason };
}

function commitTerminal(
  prepared: PreparedThreadRun,
  classified: ClassifiedRun,
  thread: ThreadRecord,
): { classified: ClassifiedRun; manifestPath: string } {
  if (classified.reason === 'containment_failure') {
    return {
      classified: { state: 'failed', reason: 'protocol_violation' },
      manifestPath: prepared.lifecycle.terminal,
    };
  }
  try {
    const manifestPath = writeTerminalManifest(terminalInput(prepared, classified, thread));
    if (validCommittedManifest(prepared, manifestPath, classified)) {
      return { classified, manifestPath };
    }
    return {
      classified: { state: 'failed', reason: 'protocol_violation' },
      manifestPath: prepared.lifecycle.terminal,
    };
  } catch (error) {
    return { classified: commitFailure(error), manifestPath: prepared.lifecycle.terminal };
  }
}

function truncatedSummary(characters: string[]): string {
  const total = characters.length;
  for (let kept = SUMMARY_LIMIT; kept >= 0; kept -= 1) {
    const suffix = `… [truncated, ${kept} of ${total} chars]`;
    if (kept + Array.from(suffix).length <= SUMMARY_LIMIT) {
      return `${characters.slice(0, kept).join('')}${suffix}`;
    }
  }
  return '';
}

function truncateSummary(thread: ThreadRecord): string {
  const text = (thread.steps.at(-1)?.output ?? '').replace(/\r\n?/g, '\n').trim();
  const characters = Array.from(text);
  return characters.length > SUMMARY_LIMIT ? truncatedSummary(characters) : text;
}

function buildResult(
  prepared: PreparedThreadRun,
  committed: ReturnType<typeof commitTerminal>,
  thread: ThreadRecord,
): BenchmarkThreadResult {
  return {
    threadId: thread.id,
    state: committed.classified.state,
    terminalReason: committed.classified.state === 'completed' ? null : committed.classified.reason,
    artifactPath: thread.artifactPath || null,
    journalPath: prepared.journal.path,
    manifestPath: committed.manifestPath,
    steps: thread.steps.length,
    costUsd: thread.totalCostUsd,
    durationMs: Math.max(0, Date.now() - new Date(prepared.startedAt).getTime()),
    summary: truncateSummary(thread),
  };
}

async function disposeSupervisors(control: RunControl): Promise<void> {
  await Promise.allSettled(control.sessions.map(session => session.dispose()));
}

async function runBenchmarkThreadScoped(
  request: BenchmarkThreadRequest,
): Promise<BenchmarkThreadResult> {
  const prepared = await prepareRun(request);
  const control = installControl(prepared);
  try {
    const outcome = await executeRun(prepared, control);
    const thread = threadStore.get(prepared.thread.id) ?? prepared.thread;
    const classified = classifyRun(prepared, control, outcome);
    const committed = commitTerminal(prepared, classified, thread);
    return buildResult(prepared, committed, thread);
  } finally {
    cleanupControl(control);
    await disposeSupervisors(control);
  }
}

export async function runBenchmarkThread(
  request: BenchmarkThreadRequest,
  overrides: Partial<LocalThreadRuntimeDeps> = {},
): Promise<BenchmarkThreadResult> {
  const deps = createLocalThreadRuntimeDeps(overrides);
  return withLocalThreadRuntimeDeps(deps, () => runBenchmarkThreadScoped(request));
}
