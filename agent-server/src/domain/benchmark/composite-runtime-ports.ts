// input:  the ports a trial coordinator constructs once, from the frozen policy
// output: CompositeRuntimePorts — the frozen 23-port bundle, and its bound-port check
// pos:    §7.2. The interface every later Gate-5, 6, 7 and 10 module compiles against
// >>> If I am updated, update my header and folder CORTEX.md <<<
//
// The bundle widens `LocalThreadRuntimeDeps` in place (§7.1 I1): `createLocalThreadRuntimeDeps` is
// already the single construction point and already takes a `Partial<>` override map, so the
// coordinator builds this once at start (§4.2 N-1) rather than assembling ports per call. P7 and
// P8 are inherited fields, not new ones — §7.2's "already present on LocalThreadRuntimeDeps".
//
// Six ports are DECLARATION-ONLY for Gate 5 (manager ruling G5-D2, see DECLARATION_ONLY_PORTS):
// this module declares them and wires them to the shipped implementations where those exist, and
// creates none of them. The ports P2-P6, P9, P12, P13 name behaviour that shipped code today
// reaches through a module singleton import; each is extracted behind its interface by its own
// Gate-5 child, which compiles against the declaration here rather than evolving its own.
//
// Import discipline: none of the extraction targets may be imported here, not even for a type.
// `domain/tasks/mutator.ts` reaches the X4 host stores and X9's `commitAndPush`, and a
// dependency-cruiser reachability rule cannot exempt type-only edges (§18 G5-R2), so a `import
// type { MutationResult }` from it would turn the live X4 and X9 rules red. Those shapes are
// therefore declared structurally below; the shipped types are used only where the module that
// declares them reaches no prohibited target.

import type { Task } from '../../core/task-parser.js';
import type {
  RunThreadOptions, ThreadRecord, ThreadTemplate,
} from '../../core/types/thread-types.js';
import type { EventBus } from '../../events/index.js';
import type { IdentityJsonValue } from '../agent-run/identity.js';
import type {
  Journal, JournalEventInput, JournalHeaderInput,
} from '../agent-run/journal.js';
import type { SupervisorSession } from '../agent-run/supervisor.js';
import type {
  LocalThreadRuntimeDeps, ThreadRunOutcome,
} from '../threads/local-runtime-deps.js';
import type {
  CompositeManifest, CompositeManifestContext, CompositeManifestViolation,
} from './composite-manifest.js';
import type { BenchmarkBrokerCapability } from './capabilities.js';
import type { ProposalRow, SealedOutcome } from './proposal-seal.js';
import { PolicyCompilationError, type ResolvedTrialPolicy } from './resolved-policy.js';
import type { SettingsSnapshot } from './settings-snapshot.js';
import type { DeterministicClock } from './trial-clock.js';
import type { LeaseState, WorkspaceLease } from './workspace-lease.js';

/** The broker's own refusal shape. Every mutator method returns it rather than throwing — the
 *  shipped convention at `mutator.ts:128,143,158`. `code` is a §8.7 code; §18 G5-N4's interim rule
 *  binds a rejection with no allocated code (R6/R9/R10) to omit it rather than reuse another. */
export interface BrokerResult {
  success: boolean;
  message?: string;
  code?: number;
}

// --- P2 -----------------------------------------------------------------------------------------

export interface TrialTaskFilter {
  project?: string;
  status?: string;
  parent?: string;
}

export interface TrialTaskRepository {
  /** Never throws for a miss: `null`, matching `mutator.ts:128`. */
  getById(taskId: string): Task | null;
  list(filter: TrialTaskFilter): Task[];
  getActionable(): Task[];
  refresh(): void;
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  flush(): Promise<void>;
}

// --- P3 -----------------------------------------------------------------------------------------

export interface TaskMutationRequest {
  project: string;
  taskId?: string;
  fields: Readonly<Record<string, unknown>>;
}

/** §8.6: sealing is the coordinator's, so this port has **no** `complete` and no `block`. The
 *  shipped `TaskMutator.complete`/`block` publish `task.completed`/`task.blocked` on the bus and
 *  emit an ambient hook event in the same call — they *are* today's seal-free callback trigger,
 *  and they are replaced rather than lifted. */
export interface CapabilityAwareTaskMutator {
  claim(capability: BenchmarkBrokerCapability, taskId: string): BrokerResult;
  unclaim(capability: BenchmarkBrokerCapability, taskId: string): BrokerResult;
  add(capability: BenchmarkBrokerCapability, request: TaskMutationRequest): BrokerResult;
  decompose(capability: BenchmarkBrokerCapability, request: TaskMutationRequest): BrokerResult;
  edit(capability: BenchmarkBrokerCapability, request: TaskMutationRequest): BrokerResult;
  proposeComplete(
    capability: BenchmarkBrokerCapability, taskId: string, note: string,
  ): ProposalRow;
  proposeBlock(
    capability: BenchmarkBrokerCapability, taskId: string, reason: string,
  ): ProposalRow;
}

// --- P4 -----------------------------------------------------------------------------------------

export interface TrialTaskLock {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface TrialTaskLocks {
  acquire(project: string, owner: string): { acquired: boolean; lock?: TrialTaskLock };
  release(project: string, owner: string): { released: boolean };
  /** `null` when held by this owner; otherwise the holder's name. */
  assertHeld(project: string, owner: string): string | null;
  isLocked(project: string): { locked: boolean; owner?: string };
}

// --- P5 -----------------------------------------------------------------------------------------

export interface TaskArtifactProjection {
  nodeDir(project: string, taskId: string): string;
  artifactPath(project: string, taskId: string): string;
  /** Must never truncate an existing artifact: rotation and rehydration depend on it. */
  ensure(project: string, taskId: string): string;
  read(capability: BenchmarkBrokerCapability): string;
  write(capability: BenchmarkBrokerCapability, content: string): void;
}

// --- P6 -----------------------------------------------------------------------------------------

export type AcceptanceVerdict = 'accepted' | 'rejected' | 'pending' | 'superseded';

export interface AcceptanceLedgerEntry {
  childId: string;
  kind: string;
  verdict: AcceptanceVerdict;
  note?: string | null;
  reworkRound: number;
  replacementId?: string | null;
}

export interface AcceptanceLedgerView {
  project: string;
  taskId: string;
  entries: readonly AcceptanceLedgerEntry[];
}

/** Fails closed (D-11): a read or parse error is `ledger_unreadable` (§8.7 code 42), never the
 *  shipped degradation to an empty ledger — §9.4 M-4's terminal predicate asserts ledger emptiness,
 *  so an unreadable ledger would read as "nothing pending" and admit the grader. */
export interface TrialAcceptanceLedger {
  read(project: string, taskId: string): AcceptanceLedgerView;
  /** `false` for an already-accepted child; re-opens a `rejected` entry to `pending` preserving
   *  its `rework_round` (§9.4 M-3). */
  recordDelivered(
    capability: BenchmarkBrokerCapability, childId: string, kind: string,
  ): boolean;
  recordVerdict(
    capability: BenchmarkBrokerCapability, childId: string,
    verdict: AcceptanceVerdict, note: string,
  ): void;
  recordSuperseded(
    capability: BenchmarkBrokerCapability, childId: string, replacementId: string,
  ): void;
  pending(project: string, taskId: string): AcceptanceLedgerEntry[];
}

// --- P9 -----------------------------------------------------------------------------------------

export interface DispatchSelection {
  task: Task;
  prompt: string;
  template: ThreadTemplate;
  /** The `randomUUID()` generation mint of `dispatcher.ts:420`, retained verbatim — it is the
   *  fence §8 builds on. */
  dispatchGeneration: string;
}

export interface AwaitableTaskDispatcher {
  selectAndClaim(input: { trial: string }): DispatchSelection | null;
  /** NEW relative to the shipped entry, which is poll-driven by the scheduler: a trial has no
   *  scheduler. No dispatchable task and no live attempt is a deadlock, surfaced as
   *  `terminal_predicate_unmet` (§9.7 code 41) rather than an idle wait to the deadline. */
  awaitNextDispatchable(signal: AbortSignal): Promise<DispatchSelection | null>;
  buildDispatchPrompt(task: Task): string;
}

// --- P10, P11 -----------------------------------------------------------------------------------

export interface ThreadRunnerPort {
  runThread(threadId: string, opts: RunThreadOptions): Promise<ThreadRunOutcome>;
  createThread(
    channel: string, opts: Parameters<LocalThreadRuntimeDeps['createThread']>[1],
  ): ThreadRecord;
  cancelThread(threadId: string): Promise<boolean>;
  consumeWaitControl(threadId: string, control: string): Promise<boolean>;
}

export interface ResumeRunnerPort {
  /** Throws `resume_state_invalid` when the thread is not `waiting`. The shipped rate-limit resume
   *  path has no in-trial counterpart: a rate-limited trial fails, it does not park. */
  resumeWaiting(threadId: string, opts: RunThreadOptions): Promise<ThreadRunOutcome>;
  resumeForQuestion(threadId: string): void;
}

// --- P12 ----------------------------------------------------------------------------------------

export type DeliveryKind = 'completed' | 'blocked' | 'superseded';

export interface TaskTreeCoordinatorPort {
  onSealedOutcome(sealed: SealedOutcome): Promise<void>;
  /** Delivery to a terminal or absent parent is an orphan: typed `attempt_unaccounted`
   *  (§9.7 code 39), not the shipped degradation to a project-report post. */
  deliver(parentThreadId: string, child: Task, kind: DeliveryKind): Promise<boolean>;
  recordVerdict(
    capability: BenchmarkBrokerCapability, childId: string, verdict: AcceptanceVerdict,
  ): void;
  reconcile(threadId: string): Promise<void>;
  maybeRotateManager(threadId: string): Promise<boolean>;
  resumeWhenQuiet(parentThreadId: string): Promise<void>;
}

// --- P13, P14 -----------------------------------------------------------------------------------

export interface QuestionRecord {
  questionId: string;
  askerThreadId: string;
  managerThreadId: string | null;
  question: string;
  answer: string | null;
  answeredAt: string | null;
}

/** The human-escalation branch of the shipped mailbox is deleted, not ported: the chain ends at
 *  the direct parent. No live manager with Q&A enabled is `qa_no_target`. */
export interface ManagerQaMailbox {
  ask(capability: BenchmarkBrokerCapability, question: string): { questionId: string };
  deliverToManager(managerThreadId: string, question: QuestionRecord): Promise<void>;
  answer(
    capability: BenchmarkBrokerCapability, questionId: string, answer: string,
  ): BrokerResult;
  /** One-shot consume: an unknown or already-consumed id is `answer_stale` (§5.4 E3). */
  poll(questionId: string): { found: boolean; answered: boolean; answer: string | null };
  openQuestions(trial: string): QuestionRecord[];
}

export interface NeedsParentAnswer {
  questionId: string;
  attemptId: string;
  question: string;
}

/** DECLARATION-ONLY for Gate 5 (G5-D2). Gate 7 creates
 *  `agent-server/src/domain/benchmark/parent-question-bridge.ts`, which does not exist at this
 *  commit; nothing here constructs one. */
export interface ParentQuestionBridge {
  record(capability: BenchmarkBrokerCapability, question: string): QuestionRecord;
  resolveOuterCall(questionId: string): NeedsParentAnswer;
  /** An acceptance-predicate miss is `rejected` without touching the tree (§5.3, D-7). */
  accept(answer: string): BrokerResult;
  invalidate(attemptId: string): void;
  /** `count > max_parent_questions` is a D6 cancellation. */
  count(trial: string): number;
}

// --- P15 ----------------------------------------------------------------------------------------

export interface ControlActor {
  trial: string;
  capability: BenchmarkBrokerCapability;
}

/** In-process channel replacing the two shipped webhook proxies verbatim in function. An
 *  unauthenticated or wrong-trial request is `sidecar_unauthenticated` (§4.7 code 27). */
export interface LocalControlEndpoint {
  authenticate(request: Readonly<Record<string, unknown>>): ControlActor;
  call(action: string, payload: Readonly<Record<string, unknown>>): Promise<BrokerResult>;
}

// --- P16 ----------------------------------------------------------------------------------------

/** A real, trial-scoped bus, wired to the shipped `EventBus` (`events/event-bus.ts:22`, its
 *  `Subscription` at `:11-13`) whose `publish` / `subscribe` / `close` are §7.2 P16's own method
 *  set. This is the widening §7.2 asks for: the bundle's `eventBus` is `EventBus | null`, and the
 *  shipped daemon-free default is `null`, i.e. a daemon-free thread publishes nothing — fatal in
 *  manager mode, where `task.completed`/`task.blocked` are what wake a suspended manager. A
 *  composite bundle must bind a real instance; leaving it null raises `runtime_port_unbound`
 *  (§7.4 code 31). A publish after the §4.5 F3 flush is dropped and recorded as
 *  `finalization_incomplete` (§4.7 code 26). */
export type TrialEventBus = EventBus;

// --- P19, P20 -----------------------------------------------------------------------------------

export interface PolicyGuardDecisionInput {
  role: string;
  tool: string;
  leaseState: LeaseState;
}

/** DECLARATION-ONLY for Gate 5 (G5-D2). Compiled by the shipped `policy-compiler.ts` into the
 *  Claude `--settings` hooks object, so `compile` returns the shipped compiled-guard shape.
 *  Unevaluable is **deny** (§6.8 G3); absent on a compiled role is `policy_guard_absent`
 *  (§6.8 G1, code 30). */
export interface BenchmarkPolicyGuard {
  decide(input: PolicyGuardDecisionInput): 'allow' | 'deny';
  compile(role: string): IdentityJsonValue;
}

export interface SupervisorAdmission {
  process: SupervisorSession['process'];
  supervision: SupervisorSession;
}

export interface QuiescenceEvidence {
  quiescent: boolean;
  sessions: number;
  detail: string | null;
}

/** DECLARATION-ONLY for Gate 5 (G5-D2). Extracted from the orchestrator's `createSpawner` choke
 *  point plus the shipped `attachSupervisor` 4-record protocol; the NEW part is that the registry
 *  is coordinator-owned and spans the whole attempt DAG rather than one thread's `RunControl`. */
export interface ProcessSupervisorRegistry {
  admit(
    command: string, args: readonly string[], options: Readonly<Record<string, unknown>>,
  ): SupervisorAdmission;
  sessions(): SupervisorSession[];
  cancelAll(reason: 'cancel' | 'deadline'): void;
  settle(budgetMs: number): Promise<QuiescenceEvidence>;
  count(): number;
}

// --- P21, P22 -----------------------------------------------------------------------------------

/** DECLARATION-ONLY for Gate 5 (G5-D2), wired to the shipped `journal.ts`. Any write, fsync or
 *  close failure throws `TrajectoryWriteFailedError` with reason `trajectory_write_failed`. */
export interface TrajectorySink {
  open(header: JournalHeaderInput): Journal;
  writeEvent(input: JournalEventInput): ReturnType<Journal['writeEvent']>;
  sha256(): string;
  close(): Promise<void>;
  readonly eventCount: number;
}

/** DECLARATION-ONLY for Gate 5 (G5-D2), wired to the shipped `composite-manifest.ts` and
 *  `manifest.ts`. `publishComposite` is the NEW part (D-12): the composite manifest is a separate
 *  document that indexes per-attempt terminal manifests, not an extension of the frozen
 *  `cortex-bench-manifest/1`. An output already present is `output_path_exists`. */
export interface CompositeManifestWriter {
  writeStarted(attempt: Readonly<Record<string, unknown>>): string;
  writeTerminal(attempt: Readonly<Record<string, unknown>>): string;
  publishComposite(dag: CompositeManifest): { path: string; sha256: string };
  validate(root: CompositeManifestContext): {
    ok: boolean; problems: readonly CompositeManifestViolation[];
  };
}

// --- the bundle ---------------------------------------------------------------------------------

export interface CompositeRuntimePorts extends LocalThreadRuntimeDeps {
  // --- policy ---
  readonly policy: ResolvedTrialPolicy;

  // --- authoritative task state ---
  readonly taskRepository: TrialTaskRepository;
  readonly taskMutator: CapabilityAwareTaskMutator;
  readonly taskLocks: TrialTaskLocks;
  readonly taskArtifacts: TaskArtifactProjection;
  readonly acceptanceLedger: TrialAcceptanceLedger;

  // --- execution state (P7) and frozen resolution (P8) are inherited fields of the bundle ---

  // --- scheduling and execution ---
  readonly dispatcher: AwaitableTaskDispatcher;
  readonly threadRunner: ThreadRunnerPort;
  readonly resumeRunner: ResumeRunnerPort;
  readonly treeCoordinator: TaskTreeCoordinatorPort;

  // --- questions ---
  readonly managerQa: ManagerQaMailbox;
  readonly parentQuestions: ParentQuestionBridge;

  // --- control, time, events ---
  readonly control: LocalControlEndpoint;
  readonly eventBus: TrialEventBus;
  readonly clock: DeterministicClock;

  // --- containment and workspace ---
  readonly lease: WorkspaceLease;
  readonly policyGuard: BenchmarkPolicyGuard;
  readonly supervisors: ProcessSupervisorRegistry;

  // --- trajectory ---
  readonly trajectory: TrajectorySink;
  readonly compositeManifest: CompositeManifestWriter;

  // --- configuration ---
  readonly settings: SettingsSnapshot;

  /** §7.1 I3: a composite bundle is always fail-closed. */
  readonly portScope: 'fail-closed';
}

export type CompositePortId =
  | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P11' | 'P12'
  | 'P13' | 'P14' | 'P15' | 'P16' | 'P17' | 'P18' | 'P19' | 'P20' | 'P21' | 'P22' | 'P23';

/** §7.2's port table as data: which field(s) of the bundle carry each of the 23 ports. P7 and P8
 *  are the inherited groups, which is why they carry five and four fields. */
export const COMPOSITE_RUNTIME_PORT_FIELDS: Readonly<
  Record<CompositePortId, readonly (keyof CompositeRuntimePorts)[]>
> = Object.freeze({
  P1: Object.freeze(['policy'] as const),
  P2: Object.freeze(['taskRepository'] as const),
  P3: Object.freeze(['taskMutator'] as const),
  P4: Object.freeze(['taskLocks'] as const),
  P5: Object.freeze(['taskArtifacts'] as const),
  P6: Object.freeze(['acceptanceLedger'] as const),
  P7: Object.freeze([
    'threadStore', 'sessionStore', 'executionStore', 'liveExecutions', 'executionLedger',
  ] as const),
  P8: Object.freeze([
    'resolveProfile', 'loadTemplates', 'getTemplate', 'resolveTemplateAgents',
  ] as const),
  P9: Object.freeze(['dispatcher'] as const),
  P10: Object.freeze(['threadRunner'] as const),
  P11: Object.freeze(['resumeRunner'] as const),
  P12: Object.freeze(['treeCoordinator'] as const),
  P13: Object.freeze(['managerQa'] as const),
  P14: Object.freeze(['parentQuestions'] as const),
  P15: Object.freeze(['control'] as const),
  P16: Object.freeze(['eventBus'] as const),
  P17: Object.freeze(['clock'] as const),
  P18: Object.freeze(['lease'] as const),
  P19: Object.freeze(['policyGuard'] as const),
  P20: Object.freeze(['supervisors'] as const),
  P21: Object.freeze(['trajectory'] as const),
  P22: Object.freeze(['compositeManifest'] as const),
  P23: Object.freeze(['settings'] as const),
});

/** Manager ruling G5-D2, exhaustive: Gate 5 declares these six and wires them to the shipped
 *  implementations where those exist, and creates none of them. §10's Gate-5 row does not name
 *  their modules. */
export const DECLARATION_ONLY_PORTS: readonly CompositePortId[] =
  Object.freeze(['P14', 'P18', 'P19', 'P20', 'P21', 'P22'] as const);

function unbound(port: CompositePortId, field: string): PolicyCompilationError {
  return new PolicyCompilationError(
    'runtime_port_unbound', `${port}:${field}`, { port, field },
  );
}

/** §7.4 code 31. Raised when a composite code path required a port the coordinator did not
 *  construct — the shipped `eventBus: null` default is the canonical case. */
export function requireCompositePort<K extends keyof CompositeRuntimePorts>(
  ports: CompositeRuntimePorts,
  field: K,
): NonNullable<CompositeRuntimePorts[K]> {
  const value = ports[field];
  if (value === null || value === undefined) {
    throw unbound(portIdOf(field), String(field));
  }
  return value as NonNullable<CompositeRuntimePorts[K]>;
}

/** Checked once at coordinator start (§4.2 N-1), so an unbound port fails before any process is
 *  admitted rather than at the first read deep inside a trial. */
export function assertCompositePortsBound(ports: CompositeRuntimePorts): void {
  for (const port of Object.keys(COMPOSITE_RUNTIME_PORT_FIELDS) as CompositePortId[]) {
    for (const field of COMPOSITE_RUNTIME_PORT_FIELDS[port]) {
      const value = ports[field];
      if (value === null || value === undefined) throw unbound(port, String(field));
    }
  }
}

function portIdOf(field: keyof CompositeRuntimePorts): CompositePortId {
  for (const port of Object.keys(COMPOSITE_RUNTIME_PORT_FIELDS) as CompositePortId[]) {
    if (COMPOSITE_RUNTIME_PORT_FIELDS[port].includes(field)) return port;
  }
  throw new TypeError(`Not a §7.2 port field: ${String(field)}`);
}

// --- P2/P4/P5 wiring (Gate 5) ----------------------------------------------------------------
// The three ports whose extraction this gate lands are implemented in `trial-task-ports.ts`;
// the coordinator builds each once at start (§4.2 N-1) through these factories, so the frozen
// interface module is also the single reachable construction surface for its own ports. The
// implementation module imports no §7.3 X4/X9/X10 target and no module that reaches one — the
// port shapes are declared there structurally and pinned to the declarations here by the port
// test — and the isolation-rules test pins the rule counts.
export {
  createTaskArtifactProjection,
  createTrialTaskLockTable,
  createTrialTaskLocks,
  createTrialTaskRepository,
} from './trial-task-ports.js';
export type { TrialArtifactProjectionOptions, TrialTaskRepositoryDelegate } from './trial-task-ports.js';
