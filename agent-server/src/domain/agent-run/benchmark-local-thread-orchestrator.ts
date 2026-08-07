// input:  frozen request, injected thread runtime, lifecycle primitives
// output: durable C9 result or supervisor_unavailable failure
// pos:    Daemon-free benchmark thread lifecycle coordinator
// >>> If I am updated, update my header and folder CORTEX.md <<<

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentProcessSpawner, AgentProcessSupervision, Backend,
} from '../../agent-adapter/types.js';
import type {
  AgentSlotConfig, AgentSlotId, BenchmarkThreadEvent, ThreadRecord,
} from '../../core/types/thread-types.js';
import { resolveProfileConfig as daemonResolveProfile } from '../agents/profile-manager.js';
import type { ResolvedTrialPolicy } from '../benchmark/resolved-policy.js';
import {
  variantProposal, type ProposalIntent, type ProposalStopReason,
} from '../benchmark/variant-proposal.js';
import type { TrialThreadAdapterInput } from '../benchmark/trial-thread-adapter.js';
import {
  createWorkspaceLease, createWorkspaceStepBoundary, readActiveLeaseState,
  resolveWorkspacePlacement, withActiveWorkspaceLease,
  type CoderReviewVariant, type TrialSnapshotPaths, type WorkspaceLease,
  type WorkspacePlacement, type WorkspaceStepBoundary,
} from '../benchmark/workspace-lease.js';
import {
  createThread as daemonCreateThread,
  getTemplate as daemonGetTemplate,
  loadConfig as daemonLoadConfig,
  resolveTemplateAgents as daemonResolveTemplateAgents,
  FILE_REF_PREFIX,
} from '../threads/index.js';
import { createLocalThreadRuntimeDeps } from '../threads/local-runtime-defaults.js';
import {
  getLocalThreadRuntimeDeps,
  scopedLocalThreadService,
  withLocalThreadRuntimeDeps,
  type LocalThreadRuntimeDeps,
} from '../threads/local-runtime-deps.js';
import {
  BenchmarkRateLimitError, runThread as daemonRunThread, type ThreadRunResult,
} from '../threads/runner.js';
import type { PlatformAdapter } from '../../platform/adapter.js';
import type { OutputStream } from '../../platform/output-stream.js';
import type { PlatformCapabilities } from '../../platform/types.js';
import { executionRepo as daemonExecutionRepo } from '../../store/execution-repo.js';
import { sessionStore as daemonSessionStore } from '../../store/session-registry-repo.js';
import { threadStore as daemonThreadStore } from '../../store/thread-repo.js';
import {
  benchmarkInstructionHashes, BenchmarkIdentityProtocolError,
  freezeBenchmarkThreadIdentities, type BenchmarkRoleIdentity,
} from './benchmark-thread-identity.js';
import {
  openJournal, TrajectoryWriteFailedError, type AgentSlot, type Journal,
} from './journal.js';
import {
  resolveLifecyclePaths, validateTrajectoryLifecycle, writeStartedMarker, writeTerminalManifest,
  type TerminalManifestInput, type TerminalReason, type TerminalState,
} from './manifest.js';
import { terminalManifestProblem } from './manifest-contract.js';
import { preparePinnedTrialPaths } from './pinned-node-process.js';
import { loadAgentRunConfigWithPolicy } from './run-config.js';
import {
  attachSupervisor, resolveSupervisorBinary, SupervisorContainmentError,
  type SupervisorSession,
} from './supervisor.js';

interface BenchmarkThreadRequest {
  workspaceCwd: string;
  template: string;
  instruction: string;
  handoff?: string;
  profileName: string;
  rootRunId: string;
  trajectoryRoot: string;
  /** Absolute container path of the arm-resolution document the parent's `agent-run` was given.
   *  The production route always carries it — the `/2` thread-policy document makes it structurally
   *  required at the producer — and it is the single input the whole trial-adapter route is derived
   *  from. It stays optional here for the same reason `trialRoot` does: the requirement belongs at
   *  the producer, and enforcing it here would refuse the shipped policy-supplied route.
   *  Design section 16 (16.3.2) PW1 / PW1-PLACE. */
  runConfigPath?: string;
  /** Absolute trial root. Required for a variant that places a role in a disposable snapshot. */
  trialRoot?: string;
  /** Fixes each role's workspace placement. Absent → every step runs in the shared workspace. */
  coderReviewVariant?: CoderReviewVariant;
  /** The frozen trial policy this thread runs under. Absent → the shipped single-backend path. */
  trialPolicy?: ResolvedTrialPolicy;
  limits: { maxSteps: number; maxCostUsd: number; deadlineEpochMs: number };
  signal: AbortSignal;
}

export interface BenchmarkThreadResult {
  threadId: string;
  state: 'completed' | 'failed' | 'cancelled' | 'timeout';
  terminalReason: string | null;
  artifactPath: string | null;
  journalPath: string;
  manifestPath: string;
  /** True iff a terminal manifest was written and validated successfully. */
  manifestCommitted: boolean;
  steps: number;
  costUsd: number;
  durationMs: number;
  summary: string;
  /** What this pipeline concluded, decided and never applied. Null for a run that declares no
   *  coder-review variant and therefore has no verdict-speaking role. */
  proposal: ProposalIntent | null;
}

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

type ResolvedProfile = ReturnType<typeof resolveProfileConfig>;
type ResolvedTemplate = NonNullable<ReturnType<typeof getTemplate>>;
type StopReason = 'cancel' | 'deadline' | 'step_limit' | 'cost_limit';

interface PreparedThreadRun {
  request: BenchmarkThreadRequest;
  profile: ResolvedProfile;
  template: ResolvedTemplate;
  thread: ThreadRecord;
  journal: Journal;
  lifecycle: { started: string; terminal: string };
  identity: BenchmarkRoleIdentity;
  roleIdentities: Map<string, BenchmarkRoleIdentity>;
  modelProtocolProblem: string | null;
  roleIdentityProblem: string | null;
  parentIdentityProblem: string | null;
  startedAt: string;
  /** Each step's last assistant message, keyed by step index, as the journal recorded it. A step
   *  that emitted none is absent — which is a different fact from one that emitted nothing to say. */
  terminalAssistantText: Map<number, string>;
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
  deps: LocalThreadRuntimeDeps;
  cancellation: Promise<unknown> | null;
  lease: WorkspaceLease;
}

interface RunOutcome {
  result: ThreadRunResult | null;
  error: unknown;
  quiescent: boolean;
  containmentReason: 'containment_failed' | 'missing_quiescent' | null;
  durabilityError: unknown;
}

type NonQuiescentReason = 'containment_failed' | 'missing_quiescent';
type ManifestClassifiedRun = { state: TerminalState; reason: TerminalReason };
type ClassifiedRun = ManifestClassifiedRun | { state: 'failed'; reason: NonQuiescentReason };

const BENCHMARK_SLOTS = new Set<AgentSlotId>([
  'benchmark-coder', 'benchmark-reviewer', 'benchmark-fixer',
]);
const SUMMARY_LIMIT = 2000;
const MAX_TIMER_MS = 2_147_483_647;
const SUPERVISOR_GRACE_MS = 1_000;
const QUIESCENCE_MARGIN_MS = 5_000;

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

/** The compiled arm is the single authority on which variant a trial runs, exactly as it is on the
 *  backend. A request that carries no compiled policy is the shipped path and keeps its own field;
 *  a request that contradicts the arm is refused rather than silently overridden. */
function expectedVariant(request: BenchmarkThreadRequest): CoderReviewVariant | undefined {
  const policy = request.trialPolicy;
  const armVariant = policy?.arm.orchestration?.coder_review_variant;
  if (armVariant === undefined) return request.coderReviewVariant;
  if (request.coderReviewVariant !== undefined && request.coderReviewVariant !== armVariant) {
    throw new Error(
      `Benchmark request coder-review variant '${request.coderReviewVariant}' `
      + `disagrees with arm '${policy!.arm.name}' variant '${armVariant}'`,
    );
  }
  return armVariant;
}

/** The one placement decision of the run: a function of (variant, slot) and of nothing else.
 *  A run that declares no variant has a single workspace — the shared writable root. */
function stepPlacement(request: BenchmarkThreadRequest): (slot: AgentSlotId) => WorkspacePlacement {
  const variant = expectedVariant(request);
  if (!variant) return () => 'shared-writable';
  return slot => resolveWorkspacePlacement(variant, slot);
}

/** The pinned trial paths put the trial temp directory at `<trial root>/tmp`. */
function trialSnapshotPaths(request: BenchmarkThreadRequest): TrialSnapshotPaths | null {
  if (!request.trialRoot) return null;
  const root = path.resolve(request.trialRoot);
  return { root, tempDir: path.join(root, 'tmp') };
}

function validateWorkspacePlacement(request: BenchmarkThreadRequest): void {
  if (!expectedVariant(request) || request.trialRoot) return;
  const placement = stepPlacement(request);
  const snapshotRoles = ['parent', 'benchmark-coder', 'benchmark-reviewer', 'benchmark-fixer']
    .filter((slot) => {
      try { return placement(slot) === 'disposable-snapshot'; }
      catch { return false; }
    });
  if (snapshotRoles.length > 0) {
    throw new Error(
      `Benchmark trialRoot is required: ${snapshotRoles.join(', ')} runs in a disposable snapshot`,
    );
  }
}

function validateRequest(request: BenchmarkThreadRequest): void {
  if (!path.isAbsolute(request.workspaceCwd) || !isDirectory(request.workspaceCwd)) {
    throw new Error('Benchmark workspaceCwd must be an existing absolute directory');
  }
  if (!path.isAbsolute(request.trajectoryRoot)) {
    throw new Error('Benchmark trajectoryRoot must be absolute');
  }
  if (request.trialRoot !== undefined && !path.isAbsolute(request.trialRoot)) {
    throw new Error('Benchmark trialRoot must be absolute');
  }
  validateWorkspacePlacement(request);
  if (!request.template || !request.profileName || !request.rootRunId) {
    throw new Error('Benchmark template, profileName, and rootRunId are required');
  }
  validateLimits(request);
}

function initializeRuntime(): void {
  executionRepo.load();
  threadStore.load();
  loadConfig();
}

/** The compiled arm is the single authority on which backend a trial runs. A request that carries
 *  no compiled policy is the shipped one-backend path and keeps its behaviour. */
function expectedBackend(request: BenchmarkThreadRequest): Backend {
  const policy = request.trialPolicy;
  if (policy === undefined) return 'claude';
  const backend = policy.arm.backend;
  if (!backend) {
    throw new Error(`Benchmark arm '${policy.arm.name}' declares no backend`);
  }
  return backend;
}

function resolveProfile(name: string, backend: Backend): ResolvedProfile {
  const profile = resolveProfileConfig(name);
  if (profile.backend !== backend) {
    throw new Error(`Benchmark profile must use backend ${backend}`);
  }
  // Meaningless outside Claude, and mandatory inside it: TUI mode has no trial surface.
  if (backend === 'claude' && profile.claudeBackend !== 'print') {
    throw new Error('Benchmark profile must use Claude print mode');
  }
  if (profile.fallback.length > 0) {
    throw new Error('Benchmark profile must not define fallbacks');
  }
  return profile;
}

/** `resolveFileRef` is fail-soft: an unreadable prompt file makes the resolved value the raw
 *  `file:<name>.md` string, so a benchmark step would run with that literal as its entire system
 *  prompt while phase B hashed the bundle's real bytes. Its fail-soft behaviour is shared with
 *  every non-benchmark agent and is left alone; a benchmark run refuses here instead. */
function assertResolvedPrompts(agents: AgentSlotConfig[]): void {
  for (const agent of agents) {
    for (const field of ['directive', 'systemPrompt'] as const) {
      if (agent[field]?.startsWith(FILE_REF_PREFIX)) {
        throw new Error(
          `Benchmark agent ${agent.slotId} ${field} did not resolve: ${agent[field]}`,
        );
      }
    }
  }
}

function resolveTemplate(name: string): ResolvedTemplate {
  const template = getTemplate(name);
  if (!template) throw new Error(`Unknown benchmark template: ${name}`);
  const agents = resolveTemplateAgents(template);
  if (agents.length === 0 || agents.some(agent => !BENCHMARK_SLOTS.has(agent.slotId))) {
    throw new Error('Benchmark template contains a non-benchmark agent slot');
  }
  assertResolvedPrompts(agents);
  if (!BENCHMARK_SLOTS.has(template.entryAgent)) {
    throw new Error('Benchmark template entry agent is not a benchmark slot');
  }
  return template;
}

function benchmarkUserMessage(request: BenchmarkThreadRequest): string {
  if (request.handoff === undefined) return request.instruction;
  return `${request.instruction}\n\nParent handoff (supplementary):\n${request.handoff}`;
}

function createBenchmarkRecord(request: BenchmarkThreadRequest): ThreadRecord {
  return createThread(`benchmark:${request.rootRunId}`, {
    templateName: request.template,
    userMessage: benchmarkUserMessage(request),
    userMessageTs: String(Date.now()),
    projectId: 'benchmark',
    metadata: { trigger: 'benchmark-local' },
  });
}

function openThreadJournal(
  request: BenchmarkThreadRequest,
  template: ResolvedTemplate,
  thread: ThreadRecord,
  identity: BenchmarkRoleIdentity,
): Journal {
  const journalPath = path.join(request.trajectoryRoot, `thread-${thread.id}.journal.ndjson`);
  return openJournal({
    path: journalPath,
    header: {
      rootRunId: request.rootRunId, threadId: thread.id,
      agentSlot: template.entryAgent as AgentSlot,
      resolvedCwd: request.workspaceCwd,
      ...benchmarkInstructionHashes(request.instruction, benchmarkUserMessage(request)),
      ...identity,
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

/** The thread artifact carries the trial's own evidence and is scanned by the transition engine:
 *  it must resolve inside the trial root. Asserted here, before anything spawns; the launch that
 *  makes it true is the trial's own. */
function assertArtifactInsideTrial(request: BenchmarkThreadRequest, thread: ThreadRecord): void {
  if (!request.trialRoot) return;
  const artifact = path.resolve(thread.artifactPath);
  const root = path.resolve(request.trialRoot);
  if (artifact !== root && !artifact.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Benchmark thread artifact must resolve inside the trial root: ${artifact}`);
  }
}

async function createRunArtifacts(
  request: BenchmarkThreadRequest,
  profile: ResolvedProfile,
  template: ResolvedTemplate,
  backend: Backend,
): Promise<PreparedThreadRun> {
  fs.mkdirSync(request.trajectoryRoot, { recursive: true });
  const identities = freezeBenchmarkThreadIdentities(
    request, profile, template, backend, request.trialPolicy,
  );
  const identity = identities.entry;
  const thread = createBenchmarkRecord(request);
  assertArtifactInsideTrial(request, thread);
  const lifecycle = resolveLifecyclePaths({
    trajectoryRoot: request.trajectoryRoot, rootRunId: request.rootRunId, threadId: thread.id,
  });
  const journal = openThreadJournal(request, template, thread, identity);
  const startedAt = new Date().toISOString();
  try { writeRunStarted(request, thread, journal, startedAt); }
  catch (error) {
    await journal.close().catch(() => {});
    throw error;
  }
  return {
    request, profile, template, thread, journal, lifecycle, identity,
    roleIdentities: identities.roles, modelProtocolProblem: identities.modelProtocolProblem,
    roleIdentityProblem: identities.roleIdentityProblem,
    parentIdentityProblem: identities.parentIdentityProblem,
    startedAt, terminalAssistantText: new Map(),
  };
}

async function prepareRun(request: BenchmarkThreadRequest): Promise<PreparedThreadRun> {
  validateRequest(request);
  initializeRuntime();
  const backend = expectedBackend(request);
  const profile = resolveProfile(request.profileName, backend);
  const template = resolveTemplate(request.template);
  return createRunArtifacts(request, profile, template, backend);
}

function supervisorCancelReason(reason: StopReason | null): 'cancel' | 'deadline' {
  return reason === 'deadline' ? 'deadline' : 'cancel';
}

function cancelSessions(control: RunControl): void {
  const reason = supervisorCancelReason(control.reason);
  for (const session of control.sessions) session.cancel(reason);
}

function cancelThreadState(control: RunControl): Promise<unknown> {
  try {
    return withLocalThreadRuntimeDeps(
      control.deps,
      () => control.deps.cancelThread(control.threadId),
    ).then(() => null, error => error);
  } catch (error) {
    return Promise.resolve(error);
  }
}

function closeAdmission(control: RunControl, reason: StopReason): void {
  if (control.reason !== null) return;
  control.admissionOpen = false;
  control.reason = reason;
  control.cancellation = cancelThreadState(control);
  control.deps.liveExecutions.killByThreadId(control.threadId);
  cancelSessions(control);
}

function deadlineDelay(deadlineEpochMs: number): number {
  return Math.min(Math.max(0, deadlineEpochMs - Date.now()), MAX_TIMER_MS);
}

function installControl(prepared: PreparedThreadRun): RunControl {
  const deps = getLocalThreadRuntimeDeps();
  if (!deps) throw new Error('Local thread runtime dependencies are not installed');
  const control = {
    admissionOpen: true, admitted: 0, reason: null, sessions: [],
    threadId: prepared.thread.id, request: prepared.request,
    timer: null, abortHandler: () => {}, deps, cancellation: null,
    lease: createWorkspaceLease({
      sharedRoot: prepared.request.workspaceCwd,
      threadId: prepared.thread.id,
      trialPaths: trialSnapshotPaths(prepared.request),
      admission: () => ({ admitted: control.admitted, sessions: control.sessions.length }),
    }),
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

function createSpawner(control: RunControl, supervisorBinary: string): AgentProcessSpawner {
  return (command, args, options) => {
    const problem = admissionProblem(control);
    if (problem) {
      stopForAdmissionProblem(control, problem);
      throw problem;
    }
    // After admission so a step-limit or deadline keeps its own stop reason, and before the
    // supervisor attaches so no model process exists when the single-writer invariant is broken.
    control.lease.assertAdmissible(options.cwd?.toString() ?? '');
    const session = attachSupervisor({
      binary: supervisorBinary,
      args: [command, ...args],
      graceMs: SUPERVISOR_GRACE_MS, deadlineMs: remainingDeadline(control),
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

function threadRunOptions(
  prepared: PreparedThreadRun,
  spawner: AgentProcessSpawner,
  boundary: WorkspaceStepBoundary,
) {
  const channel = prepared.thread.channel;
  return {
    adapter: createNoopAdapter(), channel,
    destination: { type: 'interactive-reply' as const, conduit: channel, sessionId: '' },
    threadAnchorId: null, statusMsg: null, startTime: Date.now(), onProgress: null,
    benchmark: {
      workspaceCwd: prepared.request.workspaceCwd,
      resolveStepWorkspace: boundary.resolveStepWorkspace,
      settleStepWorkspace: boundary.settleStepWorkspace,
      resolvedProfileName: prepared.request.profileName,
      expectedBackend: expectedBackend(prepared.request),
      expectedModel: prepared.profile.model,
      disableHooks: true as const,
      disableControlPlane: true as const,
      failFastOnRateLimit: true as const,
      spawner,
      requiredEventSink: (input: BenchmarkThreadEvent) => writeNormalizedEvent(prepared, input),
      limits: {
        maxSteps: prepared.request.limits.maxSteps,
        maxCostUsd: prepared.request.limits.maxCostUsd,
        deadlineMs: prepared.request.limits.deadlineEpochMs,
      },
    },
  };
}

/** The parent stops writing, then the thread takes the workspace. The precondition is asserted at
 *  the instant of the call, never waited for: this entry path builds the spawner and enters the
 *  thread with nothing admitted, and a run that has admitted anything fails closed instead. */
function takeThreadWorkspace(lease: WorkspaceLease): void {
  lease.beginDrain();
  try {
    lease.completeDrain();
  } catch (error) {
    lease.abortDrain(error instanceof Error ? error.message : String(error));
  }
}

async function runLocalThread(
  prepared: PreparedThreadRun,
  control: RunControl,
  supervisorBinary: string,
): Promise<{ result: ThreadRunResult | null; error: unknown }> {
  // Any identity gate refuses, and all of them refuse here — before the workspace is taken and
  // before any spawner exists, so a divergent identity can never reach a process.
  const problem = prepared.modelProtocolProblem
    ?? prepared.roleIdentityProblem
    ?? prepared.parentIdentityProblem;
  if (problem) {
    return { result: null, error: new BenchmarkIdentityProtocolError(problem) };
  }
  try {
    takeThreadWorkspace(control.lease);
    const boundary = createWorkspaceStepBoundary({
      lease: control.lease,
      placement: stepPlacement(prepared.request),
      artifactPath: prepared.thread.artifactPath,
    });
    const result = await control.deps.runThread(
      prepared.thread.id,
      threadRunOptions(prepared, createSpawner(control, supervisorBinary), boundary),
    );
    return { result, error: null };
  } catch (error) {
    return { result: null, error };
  } finally {
    control.lease.release();
  }
}

function asAgentSlot(value: string): AgentSlot {
  if (!BENCHMARK_SLOTS.has(value)) throw new Error(`Invalid benchmark journal agent slot: ${value}`);
  return value as AgentSlot;
}

function reportedModel(event: BenchmarkThreadEvent['event']): string | null {
  return event.type === 'assistant_text' ? event.model ?? null : null;
}

function writeNormalizedEvent(prepared: PreparedThreadRun, input: BenchmarkThreadEvent): void {
  const identity = prepared.roleIdentities.get(input.agentSlotId);
  if (!identity) throw new Error(`Missing benchmark role identity: ${input.agentSlotId}`);
  // The verdict is read from the stream the role actually spoke, so it is captured here rather
  // than recovered later from the artifact file or from a summary one backend never populates.
  if (input.event.type === 'assistant_text') {
    prepared.terminalAssistantText.set(input.step, input.event.text);
  }
  prepared.journal.writeEvent({
    threadId: prepared.thread.id, step: input.step,
    agentSlot: asAgentSlot(input.agentSlotId), backend: prepared.profile.backend,
    provider: prepared.profile.provider, requestedModel: prepared.profile.model,
    reportedModel: reportedModel(input.event), event: input.event, identity,
  });
}

type ContainmentReason = RunOutcome['containmentReason'];

function containmentFailure(error: unknown): Exclude<ContainmentReason, null> {
  if (!(error instanceof SupervisorContainmentError)) return 'missing_quiescent';
  const missing = error.detail === 'missing_quiescent'
    || error.detail === 'deadline_backstop_descendants_may_survive';
  return missing ? 'missing_quiescent' : 'containment_failed';
}

function quiescenceBudget(control: RunControl): number {
  const configured = SUPERVISOR_GRACE_MS + QUIESCENCE_MARGIN_MS;
  return Math.min(configured, remainingDeadline(control));
}

async function settleOneSupervisor(
  session: SupervisorSession,
  waitMs: number,
  control: RunControl,
): Promise<ContainmentReason> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<'missing_quiescent'>(resolve => {
    timer = setTimeout(() => resolve('missing_quiescent'), waitMs);
  });
  try {
    const result = await Promise.race([session.quiescent.then(() => null), timeout]);
    if (result) closeAdmission(control, 'cancel');
    return result;
  } catch (error) {
    closeAdmission(control, 'cancel');
    return containmentFailure(error);
  } finally {
    clearTimeout(timer!);
  }
}

async function settleSupervisors(control: RunControl): Promise<{
  quiescent: boolean;
  containmentReason: ContainmentReason;
}> {
  if (control.sessions.length === 0) return { quiescent: true, containmentReason: null };
  const waitMs = quiescenceBudget(control);
  const reasons = await Promise.all(
    control.sessions.map(session => settleOneSupervisor(session, waitMs, control)),
  );
  const containmentReason = reasons.includes('containment_failed')
    ? 'containment_failed' : reasons.find(Boolean) ?? null;
  return { quiescent: containmentReason === null, containmentReason };
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

async function executeRun(
  prepared: PreparedThreadRun,
  control: RunControl,
  supervisorBinary: string,
): Promise<RunOutcome> {
  const execution = await runLocalThread(prepared, control, supervisorBinary);
  const thread = threadStore.get(prepared.thread.id) ?? prepared.thread;
  enforceFinalCost(control, thread);
  const containment = await settleSupervisors(control);
  const cancellationBeforeFlush = control.cancellation;
  const cancellationError = cancellationBeforeFlush ? await cancellationBeforeFlush : null;
  const repositoryError = await flushRepositories();
  const journalError = await closeJournal(prepared.journal);
  const cancellationAfterFlush = control.cancellation;
  const lateCancellation = cancellationAfterFlush !== cancellationBeforeFlush;
  const lateCancellationError = lateCancellation ? await cancellationAfterFlush : null;
  const lateRepositoryError = lateCancellation ? await flushRepositories() : null;
  return {
    ...execution, ...containment,
    durabilityError: firstFailure(
      cancellationError, repositoryError, journalError,
      lateCancellationError, lateRepositoryError,
    ),
  };
}

function errorReason(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { reason?: unknown }).reason;
  return typeof value === 'string' ? value : null;
}

function classifyFailure(error: unknown): ClassifiedRun {
  if (error instanceof BenchmarkRateLimitError) return { state: 'failed', reason: 'rate_limited' };
  if (errorReason(error) === 'protocol_violation') {
    return { state: 'failed', reason: 'protocol_violation' };
  }
  if (errorReason(error) === 'trajectory_write_failed') {
    return { state: 'failed', reason: 'trajectory_write_failed' };
  }
  return { state: 'failed', reason: 'child_failure' };
}

function safetyClassification(outcome: RunOutcome): ClassifiedRun | null {
  if (outcome.containmentReason) return { state: 'failed', reason: outcome.containmentReason };
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
  classified: ManifestClassifiedRun,
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
  classified: ManifestClassifiedRun,
): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const lifecycle = validateTrajectoryLifecycle({
      trajectoryRoot: prepared.request.trajectoryRoot,
      canonicalTrajectoryRoot: true,
      rootRunId: prepared.request.rootRunId,
      threadId: prepared.thread.id,
      roleIdentities: prepared.roleIdentities,
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

interface TerminalCommit {
  classified: ClassifiedRun;
  manifestPath: string;
  manifestCommitted: boolean;
}

function uncommittedTerminal(
  prepared: PreparedThreadRun,
  classified: ClassifiedRun,
): TerminalCommit {
  return { classified, manifestPath: prepared.lifecycle.terminal, manifestCommitted: false };
}

function commitTerminal(
  prepared: PreparedThreadRun,
  classified: ClassifiedRun,
  thread: ThreadRecord,
): TerminalCommit {
  const noManifest = classified.reason === 'containment_failed'
    || classified.reason === 'missing_quiescent';
  if (noManifest) return uncommittedTerminal(prepared, classified);
  const terminalClassification = classified as ManifestClassifiedRun;
  try {
    const manifestPath = writeTerminalManifest(
      terminalInput(prepared, terminalClassification, thread),
      { roleIdentities: prepared.roleIdentities },
    );
    if (validCommittedManifest(prepared, manifestPath, terminalClassification)) {
      return { classified, manifestPath, manifestCommitted: true };
    }
    return uncommittedTerminal(prepared, { state: 'failed', reason: 'protocol_violation' });
  } catch (error) {
    return uncommittedTerminal(prepared, commitFailure(error));
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

/** The step loop's own account of why it stopped. Absent → this run's admission boundary closed
 *  it, or it left for a reason nobody recorded; either way it is not an approval to propose on. */
function proposalStopReason(control: RunControl, outcome: RunOutcome): ProposalStopReason {
  return outcome.result?.stopReason ?? (control.reason ? 'admission_limit' : 'unavailable');
}

/** Decided here and applied nowhere: no broker call, no ledger write and no bus event. A run with
 *  no coder-review variant has no verdict-speaking role, and so has nothing to propose. */
function proposeOutcome(
  prepared: PreparedThreadRun,
  committed: TerminalCommit,
  thread: ThreadRecord,
  control: RunControl,
  outcome: RunOutcome,
): ProposalIntent | null {
  const variant = expectedVariant(prepared.request);
  if (!variant) return null;
  const finalStep = thread.steps.at(-1) ?? null;
  return variantProposal({
    variant,
    terminalState: committed.classified.state,
    finalStep: finalStep && {
      agentSlotId: finalStep.agentSlotId, stage: finalStep.stage, index: finalStep.stepIndex,
    },
    finalAssistantText: finalStep
      ? prepared.terminalAssistantText.get(finalStep.stepIndex) ?? null
      : null,
    stopReason: proposalStopReason(control, outcome),
  });
}

function buildResult(
  prepared: PreparedThreadRun,
  committed: TerminalCommit,
  thread: ThreadRecord,
  proposal: ProposalIntent | null,
): BenchmarkThreadResult {
  return {
    threadId: thread.id,
    state: committed.classified.state,
    terminalReason: committed.classified.state === 'completed' ? null : committed.classified.reason,
    artifactPath: thread.artifactPath || null,
    journalPath: prepared.journal.path,
    manifestPath: committed.manifestPath,
    manifestCommitted: committed.manifestCommitted,
    steps: thread.steps.length,
    costUsd: thread.totalCostUsd,
    durationMs: Math.max(0, Date.now() - new Date(prepared.startedAt).getTime()),
    summary: truncateSummary(thread),
    proposal,
  };
}

async function disposeSupervisor(session: SupervisorSession, waitMs: number): Promise<void> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); });
  const disposal = session.dispose().catch(() => {});
  try { await Promise.race([disposal, timeout]); }
  finally { clearTimeout(timer!); }
}

async function disposeSupervisors(control: RunControl): Promise<void> {
  const waitMs = quiescenceBudget(control);
  await Promise.all(control.sessions.map(session => disposeSupervisor(session, waitMs)));
}

async function runBenchmarkThreadScoped(
  request: BenchmarkThreadRequest,
): Promise<BenchmarkThreadResult> {
  const supervisorBinary = resolveSupervisorBinary();
  const prepared = await prepareRun(request);
  const control = installControl(prepared);
  try {
    // The lease is published for the whole run so each step's spawn config can read the state it
    // was armed under, rather than one captured before the lease existed (16.1 LS3).
    return await withActiveWorkspaceLease(control.lease, async () => {
      const outcome = await executeRun(prepared, control, supervisorBinary);
      const thread = threadStore.get(prepared.thread.id) ?? prepared.thread;
      const classified = classifyRun(prepared, control, outcome);
      const committed = commitTerminal(prepared, classified, thread);
      const proposal = proposeOutcome(prepared, committed, thread, control, outcome);
      return buildResult(prepared, committed, thread, proposal);
    });
  } finally {
    cleanupControl(control);
    await disposeSupervisors(control);
  }
}

/**
 * Everything the per-step trial adapter needs, derived from the two paths the request carries and
 * from nothing else: the compiled policy and the resolved run config from ONE call of the shipped
 * loader over the arm-resolution document, the pinned trial paths from the trial root, and the
 * supervisor from the shipped resolver. The policy is RE-COMPILED here, in the process that will
 * run the thread, rather than transported — which is what makes the parent role-hash equality a
 * comparison of two independent compiles instead of a tautology. A request that carried a
 * pre-built `ResolvedAgentRunConfig`, `PinnedTrialPaths` or supervisor descriptor would let a
 * caller supply what production must derive. Design section 16 (16.3.2) PW1 and PW2.
 */
export function trialThreadAdapterInput(
  runConfigPath: string,
  trialRoot: string,
): TrialThreadAdapterInput {
  const loaded = loadAgentRunConfigWithPolicy({
    runConfigFile: runConfigPath, agentSlot: 'parent',
  });
  if (!loaded.policy) {
    throw new Error(`Benchmark run config compiled no trial policy: ${runConfigPath}`);
  }
  return {
    policy: loaded.policy,
    config: loaded.config,
    paths: preparePinnedTrialPaths(trialRoot),
    supervisor: { binary: resolveSupervisorBinary(), graceMs: SUPERVISOR_GRACE_MS },
    leaseState: readActiveLeaseState,
  };
}

/** The lifecycle hook runner reaches an agent through the unscoped module import, so an override
 *  that supplies one puts a second, unscoped model process on the thread path — outside the trial
 *  adapter, the pinned environment and the admission boundary. The benchmark path keeps the no-op.
 *  Keyed on the key's presence, not its value: an override carrying the key with an undefined value
 *  is spread over the no-op default, and the step path then falls back to the daemon runner. */
function refuseLifecycleHookOverride(overrides: Partial<LocalThreadRuntimeDeps>): void {
  if ('emitLifecycleHooks' in overrides) {
    throw new Error('A benchmark thread may not supply a lifecycle hook runner');
  }
}

export async function runBenchmarkThread(
  request: BenchmarkThreadRequest,
  overrides: Partial<LocalThreadRuntimeDeps> = {},
): Promise<BenchmarkThreadResult> {
  refuseLifecycleHookOverride(overrides);
  const deps = createLocalThreadRuntimeDeps(daemonRunThread, overrides);
  return withLocalThreadRuntimeDeps(deps, () => runBenchmarkThreadScoped(request));
}
