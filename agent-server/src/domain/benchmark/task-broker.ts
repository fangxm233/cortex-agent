// input:  broker action, arguments, ambient capability
// output: authorised effect or typed refusal, no tree touch
// pos:    §8.3 matrix, §8.4 rejections, §8.5 split
// >>> If I am updated, update my header and folder CORTEX.md <<<
//
// THE FENCE, not a convention. §8.3's matrix is exhaustive and says so — "an action absent from
// this table does not exist" (`design:2409-2410`) — so the table below is the whole surface: no
// `task.complete`, no `task.block` and no `task.uncomplete`, because sealing is the coordinator's
// act (§8.6). Each row carries its GUARD list, not merely its membership.
//
// Import discipline: this module does not import `composite-runtime-ports.ts` or `proposal-seal.ts`
// because a reachability rule cannot exempt type-only edges (§18 G5-R2) and both reach
// `@platform/index.js` through `core/types/thread-types.ts:476`. The port shapes it consumes are
// declared STRUCTURALLY below; `task-broker.test.ts` pins them with a compile-time assignability
// check in the test tree, which is not a `src` edge.
//
// What is NOT here: the proposal → seal machine (Gate 4's `proposal-seal.ts`, reached through the
// P3 port, never re-implemented), `CapabilityAwareTaskMutator` itself, §8.6's seal and
// publication sites (Gate 6's), and the MCP registration surface and P15 transport (wave 3/Gate 6).
// §8.5 is therefore proven against this module's own call surface, stated rather than papered over.

import { realpathSync } from 'node:fs';
import * as path from 'node:path';

import type { Task } from '../../core/task-parser.js';
import {
  BENCHMARK_BROKER_ACTIONS,
  type ActorCapability, type BenchmarkBrokerCapability,
} from './capabilities.js';
import { requireAmbientCapability, type ActorCapabilityRegistry } from './actor-capability-scope.js';
import {
  assertBrokerArguments, BrokerArgumentsError,
} from './task-broker-arguments.js';
import type { ResolvedTrialPolicy } from './resolved-policy.js';

export { BrokerArgumentsError };

// ── §18 (18.5) G5-W7/W8 the typed refusal ───────────────────────────────────

/**
 * §18 G5-W8's closed R1…R12 → code map (`design:9103-9116`). Nothing here is minted.
 *
 * R6, R9 and R10 carry NO `code` key (§18 G5-N4's interim rule: omit `code` rather than reuse a
 * code for a different condition, which §2.6 names as a defect). R6 does NOT borrow compile-time
 * code 20: 20 is Class P, and a runtime broker refusal is Class R. The registry stays 1–44.
 */
export type BrokerRejectionId =
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11' | 'R12';

export type BrokerRejectionReason =
  | 'stale_generation' | 'cross_branch_mutation' | 'parent_completion_by_child'
  | 'proposal_target_not_self' | 'out_of_trial_path' | 'template_not_whitelisted'
  | 'profile_not_whitelisted' | 'capability_denied' | 'budget_exceeded' | 'lock_not_held'
  | 'ledger_unreadable' | 'token_invalid';
/** Typed failures returned by a broker action in addition to §8.4's closed R1–R12 table. */
export type BrokerRefusalReason =
  | BrokerRejectionReason | 'proposal_invalidated' | 'answer_stale';
export interface BrokerRejectionSpec {
  readonly reason: BrokerRejectionReason;
  /** ABSENT — not `undefined` — for R6, R9 and R10 (§18 G5-N4). */
  readonly code?: number;
}
export const BROKER_REJECTIONS: Readonly<Record<BrokerRejectionId, BrokerRejectionSpec>>
  = Object.freeze({
  R1: Object.freeze({ reason: 'stale_generation', code: 34 }),
  R2: Object.freeze({ reason: 'cross_branch_mutation', code: 35 }),
  R3: Object.freeze({ reason: 'parent_completion_by_child', code: 35 }),
  R4: Object.freeze({ reason: 'proposal_target_not_self', code: 35 }),
  R5: Object.freeze({ reason: 'out_of_trial_path', code: 36 }),
  R6: Object.freeze({ reason: 'template_not_whitelisted' }),
  R7: Object.freeze({ reason: 'profile_not_whitelisted', code: 23 }),
  R8: Object.freeze({ reason: 'capability_denied', code: 33 }),
  R9: Object.freeze({ reason: 'budget_exceeded' }),
  R10: Object.freeze({ reason: 'lock_not_held' }),
  R11: Object.freeze({ reason: 'ledger_unreadable', code: 42 }),
  R12: Object.freeze({ reason: 'token_invalid', code: 27 }),
});

/**
 * §18 G5-W7's frame, minus `seq` (leg 2's framing, not Gate 5's). Deliberately NO message field —
 * §2.6's P-iii/R-iii require a machine-readable reason. `status` is §5.2's `rejected`:
 * NON-terminal for the tree.
 */
export interface BrokerRefusal {
  readonly ok: false;
  readonly status: 'rejected';
  readonly action: BenchmarkBrokerCapability;
  readonly reason: BrokerRefusalReason;
  readonly code?: number;
}

export interface BrokerSuccess {
  readonly ok: true;
  readonly status: 'completed';
  readonly action: BenchmarkBrokerCapability;
  readonly result: Readonly<Record<string, unknown>>;
}
export type BrokerCallResult = BrokerSuccess | BrokerRefusal;
/** §19.12.2 — the structural `BrokerResult` of the frozen §7.2 P3 port, declared here because the
 *  interface module cannot be imported (its closure is a platform reach, §18 G5-R2). */
export interface BrokerResult {
  success: boolean;
  message?: string;
  code?: number;
}

function refusalFor(
  action: BenchmarkBrokerCapability, reason: BrokerRefusalReason, code?: number,
): BrokerRefusal {
  const refusal = {
    ok: false as const,
    status: 'rejected' as const,
    action,
    reason,
  };
  return Object.freeze(code === undefined ? refusal : { ...refusal, code });
}
function refuse(action: BenchmarkBrokerCapability, id: BrokerRejectionId): BrokerRefusal {
  const rejection = BROKER_REJECTIONS[id];
  // The `code` KEY is absent, not undefined, for R6/R9/R10 — an omitted code and a null code are
  // different claims, and G5-N4's interim rule is the former.
  return refusalFor(action, rejection.reason, rejection.code);
}
function succeed(action: BenchmarkBrokerCapability, result: Readonly<Record<string, unknown>>): BrokerSuccess {
  return Object.freeze({ ok: true as const, status: 'completed' as const, action, result });
}
/** P3's frozen error modes are 33 capability miss and 34 generation miss; an ordinary no-code
 *  lifecycle failure is surfaced as `BrokerArgumentsError`, never translated and never success. */
const LIFECYCLE_CODE_REJECTIONS: Readonly<Record<number, BrokerRejectionId>> = Object.freeze({
  33: 'R8',
  34: 'R1',
});

function noCodeFailure(action: BenchmarkBrokerCapability, result: { readonly message?: string }): BrokerArgumentsError {
  return new BrokerArgumentsError(
    action, `P3 returned an ordinary no-code failure: ${result.message ?? 'unknown'}`,
  );
}
function throwUnsupportedCode(code: number): never {
  throw new TypeError(`P3 returned an unsupported failure code: ${String(code)}`);
}
function mutationRefusal(action: BenchmarkBrokerCapability, result: { readonly success: boolean; readonly code?: number; readonly message?: string }): BrokerRefusal | null {
  if (result.success) return null;
  if (result.code === undefined) throw noCodeFailure(action, result);
  const rejection = LIFECYCLE_CODE_REJECTIONS[result.code];
  return rejection === undefined ? throwUnsupportedCode(result.code) : refuse(action, rejection);
}
// ── §18 (18.3) G5-W5 the ten entry points ───────────────────────────────────
/**
 * G5-W5's tool-name column, exhaustive: the action name with `.` replaced by `_`, except the two
 * `qa.*` actions whose names §6.7 already fixed to the shipped `ask_manager` / `answer_subtask`.
 */
export const BROKER_TOOL_NAMES: Readonly<Record<BenchmarkBrokerCapability, string>> = Object.freeze({
  'task.read': 'task_read',
  'task.create': 'task_create',
  'task.decompose': 'task_decompose',
  'task.claim': 'task_claim',
  'task.propose_complete': 'task_propose_complete',
  'task.propose_block': 'task_propose_block',
  'artifact.write': 'artifact_write',
  'dependency.declare': 'dependency_declare',
  'qa.ask': 'ask_manager',
  'qa.answer': 'answer_subtask',
});

/**
 * G5-W4.4's schema exclusion, as data. A model that supplies one of these is NAMING a capability
 * rather than using one; the broker refuses it as `BrokerArgumentsError`. `task_id` is NOT a
 * member: it is a legitimate TARGET argument, and what G5-W4.4 excludes is `task_id`-of-self.
 */
export const CAPABILITY_SHAPED_ARGUMENT_KEYS = Object.freeze([
  'token_id', 'trial_id', 'dispatch_generation', 'attempt_id', 'role', 'ancestry',
  'allowed_actions', 'issued_at_epoch_ms',
] as const);
/** §2.7 forbids runtime profile re-resolution; §8.4 R7 is the refusal when an actor names one. */
const PROFILE_SHAPED_ARGUMENT_KEYS: readonly string[] = ['profile', 'profile_name'];
export type BrokerGuardId =
  | 'read_scope' | 'in_branch' | 'in_branch_endpoints' | 'acyclic' | 'target_self'
  | 'generation_current' | 'ledger_readable' | 'lock_held' | 'template_whitelisted'
  | 'task_budget' | 'depth_budget' | 'trial_path' | 'qa_whitelisted' | 'claimable_target';
export interface BrokerActionSpec {
  readonly action: BenchmarkBrokerCapability;
  readonly tool: string;
  /** The `.strict()` key set. A key outside it is refused, never ignored. */
  readonly argumentKeys: readonly string[];
  /** §8.3's "Additional guards beyond capability membership" column, as data. */
  readonly guards: readonly BrokerGuardId[];
}

function row(action: BenchmarkBrokerCapability, argumentKeys: readonly string[], guards: readonly BrokerGuardId[]): BrokerActionSpec {
  return Object.freeze({
    action,
    tool: BROKER_TOOL_NAMES[action],
    argumentKeys: Object.freeze([...argumentKeys]),
    guards: Object.freeze([...guards]),
  });
}

/**
 * §8.3's matrix. Exactly ten rows; the absence of a field makes a whole rejection class
 * UNEXPRESSIBLE rather than policed: no `parent`, `keep_parent`, `generation`, proposal
 * `task_id`, or `path` (all fixed by §8.3/§8.4/§18 G5-W4.4).
 */
export const BROKER_ACTION_TABLE: Readonly<Record<BenchmarkBrokerCapability, BrokerActionSpec>> =
  Object.freeze({
    'task.read': row('task.read', ['task_id'], ['read_scope']),
    // §19.12.2 claim guards: requester currency first, then R3/R2 branch refusals, then the
    // strict actionable-unclaimed-descendant proof (BrokerArgumentsError before any mint).
    'task.create': row('task.create', ['text', 'why', 'done_when', 'template', 'priority', 'plan', 'depends_on'], ['lock_held', 'template_whitelisted', 'task_budget', 'depth_budget']),
    'task.decompose': row('task.decompose', ['subtasks'], ['lock_held', 'generation_current', 'template_whitelisted', 'task_budget', 'depth_budget']),
    'task.claim': row('task.claim', ['task_id'], ['generation_current', 'in_branch', 'claimable_target']),
    'task.propose_complete': row('task.propose_complete', ['note'], ['target_self', 'generation_current', 'ledger_readable']),
    'task.propose_block': row('task.propose_block', ['reason'], ['target_self', 'generation_current']),
    'artifact.write': row('artifact.write', ['content'], ['trial_path']),
    'dependency.declare': row('dependency.declare', ['task_id', 'depends_on'], ['in_branch_endpoints', 'acyclic']),
    'qa.ask': row('qa.ask', ['question'], ['qa_whitelisted']),
    'qa.answer': row('qa.answer', ['question_id', 'answer'], ['qa_whitelisted']),
  });
// ── §8.5 the model-visible projection ───────────────────────────────────────
/**
 * EXHAUSTIVE: the union of the two lists is exactly `keyof Task`, checked at compile time below
 * and again by test; a field added to `Task` lands in neither list and stops the build.
 */
export const MODEL_VISIBLE_TASK_FIELDS = Object.freeze([
  'id', 'text', 'why', 'done_when', 'priority', 'status', 'template', 'plan', 'project',
  'parent', 'depends_on', 'gpu', 'gpu_count', 'blocked_by', 'paused', 'approval_needed',
  'approved_at', 'not_before', 'completed_at', 'completed_note', 'pending_at',
] as const satisfies readonly (keyof Task)[]);

/**
 * §8.5's "claims / generations … not projected at all" plus the host-side provenance fields —
 * fencing data the model never sees, so a generation cannot be echoed back into a mutation
 * (G5-W4.5 makes that STRUCTURAL: no argument of any of the ten accepts one either).
 */
export const PROJECTION_WITHHELD_TASK_FIELDS = Object.freeze([
  'dispatch_generation', 'claimed_by', 'claimed_at',
  'origin_session_id', 'origin_channel', 'origin_thread_id',
] as const satisfies readonly (keyof Task)[]);

type ProjectionPartitionGap = Exclude<keyof Task, typeof MODEL_VISIBLE_TASK_FIELDS[number] | typeof PROJECTION_WITHHELD_TASK_FIELDS[number]>;
export type ProjectionIsExhaustive = ProjectionPartitionGap extends never ? true : never;
export type ModelVisibleTask = Pick<Task, typeof MODEL_VISIBLE_TASK_FIELDS[number]>;
/** The disposable projection of §8.5: regenerated from broker state, never parsed back. */
export function projectTaskForModel(task: Task): ModelVisibleTask {
  const projected: Partial<Record<keyof Task, unknown>> = {};
  for (const field of MODEL_VISIBLE_TASK_FIELDS) {
    projected[field] = field === 'depends_on'
      ? Object.freeze([...task.depends_on])
      : task[field];
  }
  return Object.freeze(projected) as ModelVisibleTask;
}
// ── the ports this module consumes, declared structurally (see the header) ──
export interface BrokerMutationRequest {
  project: string;
  taskId?: string;
  fields: Readonly<Record<string, unknown>>;
}

/** §19.12.1 — the by-value refusal member of the proposal union, declared structurally (the real
 *  type lives in `trial-task-mutator.ts`; importing it here would be a new reachability edge). */
export interface BrokerMutationRefusal {
  readonly success: false;
  readonly message: string;
  readonly code: 33 | 34;
}
/** The proposal port's corrected return: the exact `ProposalRow` or a by-value refusal; the row
 *  member is a structural stand-in the broker only discriminates and discards. */
export type BrokerProposalResult = { readonly state: string } | BrokerMutationRefusal;
/** The narrowed, structural view of the frozen §7.2 ports this broker calls (the frozen bundle
 *  must satisfy it, pinned by test). `claim` is REMOVED from this view (§19.12.1): the
 *  model-facing claim routes through the injected `claimTarget` callback, never P3.claim. */
export interface BrokerPorts {
  readonly taskRepository: {
    getById(taskId: string): Task | null;
    list(filter: { project?: string; status?: string; parent?: string }): Task[];
    getActionable(): Task[]; // §19.12.2 step 2 — the claim target must exist in this set
  };
  readonly taskMutator: {
    add(capability: ActorCapability, request: BrokerMutationRequest): { success: boolean; code?: number };
    decompose(capability: ActorCapability, request: BrokerMutationRequest): { success: boolean; code?: number };
    edit(capability: ActorCapability, request: BrokerMutationRequest): { success: boolean; code?: number };
    /** §19.12.1/§19.12.6 — routes into Gate 4's shipped `proposal-seal.ts` through P3, returning
     *  the exact `recordProposal` row or a by-value `MutationRefusal` (33|34); the broker narrows
     *  the union by the literal `success:false` member, and `ProposalSealError` (37/42) stays
     *  thrown, flowing through `typedPortFailure`. */
    proposeComplete(capability: ActorCapability, taskId: string, note: string): BrokerProposalResult;
    proposeBlock(capability: ActorCapability, taskId: string, reason: string): BrokerProposalResult;
  };
  readonly taskLocks: {
    assertHeld(project: string, owner: string): string | null;
  };
  readonly taskArtifacts: {
    artifactPath(project: string, taskId: string): string;
    write(capability: ActorCapability, content: string): void;
  };
  readonly acceptanceLedger: {
    pending(project: string, taskId: string): unknown[];
  };
  readonly managerQa: {
    ask(capability: ActorCapability, question: string): { questionId: string };
    answer(capability: ActorCapability, questionId: string, answer: string): { success: boolean };
  };
  readonly parentQuestions: {
    record(capability: ActorCapability, question: string): { questionId: string };
  };
}

export interface BrokerConstruction {
  readonly policy: ResolvedTrialPolicy;
  readonly ports: BrokerPorts;
  readonly capabilities: ActorCapabilityRegistry;
  /** The trial project as the ports and the proposal store see it. */
  readonly project: string;
  /** §7.2 P5's repointed root. R5 resolve-then-contains every path against it. */
  readonly trialArtifactRoot: string;
  /** §19.12.2 — the dispatcher-owned two-leg claim callback, separate from `BrokerPorts.taskMutator`
   *  so requester authority is never confused with target authority (constructed by
   *  `createDispatcherOwnedClaimTarget` in `trial-task-dispatcher.ts`). */
  readonly claimTarget: (requester: ActorCapability, targetId: string) => BrokerResult;
}

export interface BenchmarkTaskBroker {
  /** The whole model-facing surface. The capability is AMBIENT (§18 G5-W4) and is not a parameter:
   *  a caller can only USE a capability, never NAME one. */
  call(
    action: BenchmarkBrokerCapability, payload: Readonly<Record<string, unknown>>,
  ): Promise<BrokerCallResult>;
  /** §7.2 P3's coordinator-internal signature, where the target IS named and R4 therefore stays
   *  live. G5-W3: §8.3's "Broker method" column names coordinator-internal methods. */
  proposeComplete(capability: ActorCapability, taskId: string, note: string): Promise<BrokerCallResult>;
  proposeBlock(capability: ActorCapability, taskId: string, reason: string): Promise<BrokerCallResult>;
}

// ── the fence ───────────────────────────────────────────────────────────────

/** The construction state of one broker instance, built once by `createBenchmarkTaskBroker` and
 *  passed to every guard/handler below. */
interface BrokerContext {
  readonly policy: ResolvedTrialPolicy;
  readonly ports: BrokerPorts;
  readonly capabilities: ActorCapabilityRegistry;
  readonly project: string;
  readonly trialArtifactRoot: string;
  readonly claimTarget: (requester: ActorCapability, targetId: string) => BrokerResult;
  readonly templateWhitelist: Set<string>;
}
interface GuardContext {
  readonly capability: ActorCapability;
  readonly action: BenchmarkBrokerCapability;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Leg 1's explicitly named target (§7.2 P3's `proposeComplete(cap, taskId, note)`). `null` on
   *  the model-facing surface, whose schemas declare no `task_id` for the two proposals. */
  readonly target: string | null;
}

type Guard = (ctx: BrokerContext, context: GuardContext) => BrokerRejectionId | null;

// §8.4 R2/R3 in one decision, in order: ancestry is the UPWARD case R3 names; anything else
// that is neither self nor a descendant falls to R2.
function branchRejection(ctx: BrokerContext, capability: ActorCapability, targetId: string): BrokerRejectionId | null {
  if (targetId === capability.task_id) return null;
  if (capability.ancestry.includes(targetId)) return 'R3';
  return descendantsOf(ctx, capability.task_id).has(targetId) ? null : 'R2';
}
function descendantsOf(ctx: BrokerContext, taskId: string): Set<string> {
  const found = new Set<string>();
  const frontier = [taskId];
  while (frontier.length > 0) addChildren(ctx, found, frontier);
  return found;
}
function addChildren(ctx: BrokerContext, found: Set<string>, frontier: string[]): void {
  const id = frontier.pop()!;
  for (const child of ctx.ports.taskRepository.list({ parent: id })) {
    if (found.has(child.id)) continue;
    found.add(child.id);
    frontier.push(child.id);
  }
}
function guardReadScope(ctx: BrokerContext, { capability, payload }: GuardContext): BrokerRejectionId | null {
  const target = payload.task_id;
  if (typeof target !== 'string') return null;
  if (target === capability.task_id || capability.ancestry.includes(target)) return null;
  return descendantsOf(ctx, capability.task_id).has(target) ? null : 'R2';
}
function guardInBranch(ctx: BrokerContext, { capability, payload }: GuardContext): BrokerRejectionId | null {
  return branchRejection(ctx, capability, String(payload.task_id));
}
function guardInBranchEndpoints(ctx: BrokerContext, { capability, payload }: GuardContext): BrokerRejectionId | null {
  const endpoints = [String(payload.task_id), ...asStringArray(payload.depends_on)];
  for (const endpoint of endpoints) {
    const rejection = branchRejection(ctx, capability, endpoint);
    if (rejection !== null) return rejection;
  }
  return null;
}
function guardAcyclic(ctx: BrokerContext, { payload }: GuardContext): BrokerRejectionId | null {
  const from = String(payload.task_id);
  const edges = new Map<string, string[]>();
  for (const task of ctx.ports.taskRepository.list({})) edges.set(task.id, [...task.depends_on]);
  edges.set(from, [...(edges.get(from) ?? []), ...asStringArray(payload.depends_on)]);
  if (introducesCycle(edges, from)) {
    // No R1–R12 member exists for a cyclic declare, and none may be minted (§18 G5-N4) — this
    // is a mutation-validity refusal of the same class as a schema rejection.
    throw new BrokerArgumentsError(
      'dependency.declare', 'the resulting dependency graph would contain a cycle',
    );
  }
  return null;
}
function guardTargetSelf(ctx: BrokerContext, { capability, target }: GuardContext): BrokerRejectionId | null {
  if (target === null || target === capability.task_id) return null;
  return capability.ancestry.includes(target) ? 'R3' : 'R4';
}
function attemptIsCurrent(current: { readonly dispatch_generation: string; readonly attempt_id: string } | null, capability: ActorCapability): boolean {
  return current !== null && current.dispatch_generation === capability.dispatch_generation && current.attempt_id === capability.attempt_id;
}
function guardGenerationCurrent(ctx: BrokerContext, { capability }: GuardContext): BrokerRejectionId | null {
  const task = ctx.ports.taskRepository.getById(capability.task_id);
  if (task === null) return 'R2';
  if (task.dispatch_generation !== capability.dispatch_generation) return 'R1';
  // D-9: the same generation can carry more than one attempt, so the registry attempt must
  // match too — the generation match alone is not the fence §8.4 R1 asks for.
  const current = ctx.capabilities.currentAttempt(capability.task_id);
  return attemptIsCurrent(current, capability) ? null : 'R1';
}
function guardLedgerReadable(ctx: BrokerContext, { capability }: GuardContext): BrokerRejectionId | null {
  try {
    ctx.ports.acceptanceLedger.pending(ctx.project, capability.task_id);
    return null;
  } catch {
    // D-11 inverts the shipped fail-open at `acceptance-ledger.ts:38-48`.
    return 'R11';
  }
}
function guardLockHeld(ctx: BrokerContext, { capability }: GuardContext): BrokerRejectionId | null {
  // One project, one lock, held by the trial: every actor asserts the same owner.
  return ctx.ports.taskLocks.assertHeld(ctx.project, capability.trial_id) === null ? null : 'R10';
}
function guardTemplateWhitelisted(ctx: BrokerContext, { payload }: GuardContext): BrokerRejectionId | null {
  for (const template of requestedTemplates(payload)) {
    if (!ctx.templateWhitelist.has(template)) return 'R6';
  }
  return null;
}
function guardTaskBudget(ctx: BrokerContext, { action, payload }: GuardContext): BrokerRejectionId | null {
  const added = action === 'task.decompose' && Array.isArray(payload.subtasks)
    ? payload.subtasks.length : 1;
  return ctx.ports.taskRepository.list({}).length + added > ctx.policy.limits.max_tasks
    ? 'R9' : null;
}
// §8.3: `depth(cap) < max_task_depth`; a child would sit one level deeper than the ancestry.
function guardDepthBudget(ctx: BrokerContext, { capability }: GuardContext): BrokerRejectionId | null {
  return capability.ancestry.length >= ctx.policy.limits.max_task_depth ? 'R9' : null;
}
function guardTrialPath(ctx: BrokerContext, { capability }: GuardContext): BrokerRejectionId | null {
  const target = ctx.ports.taskArtifacts.artifactPath(ctx.project, capability.task_id);
  return containedIn(resolveRealPath(ctx.trialArtifactRoot), resolveRealPath(target)) ? null : 'R5';
}
// §2.4: Q&A disabled means the capabilities are ABSENT, not refused — the frozen policy is
// re-checked beside the token so a widened token is still refused.
function guardQaWhitelisted(ctx: BrokerContext, { capability, action }: GuardContext): BrokerRejectionId | null {
  return ctx.policy.capability_whitelist.includes(action) && capability.allowed_actions.has(action)
    ? null : 'R8';
}
function findActionable(ctx: BrokerContext, target: string): Task | undefined {
  return ctx.ports.taskRepository.getActionable().find(task => task.id === target);
}
function isUnclaimedRow(row: Task): boolean {
  return row.claimed_by === null && row.dispatch_generation === null;
}
// §19.12.2 step 2 — the claim target proof, AFTER the requester's generation_current and the
// R3/R2 branch refusals: a STRICT descendant (self refused), present in the shipped actionable
// set and unclaimed. These three failures are BrokerArgumentsError, made unexpressible rather
// than policed, and fire before any mint or port call.
function guardClaimableTarget(ctx: BrokerContext, { capability, payload }: GuardContext): BrokerRejectionId | null {
  const target = String(payload.task_id);
  if (target === capability.task_id) {
    throw new BrokerArgumentsError(
      'task.claim', 'claiming the capability\'s own task is not a strict descendant claim',
    );
  }
  const row = findActionable(ctx, target);
  if (row === undefined) {
    throw new BrokerArgumentsError('task.claim', `target ${target} is not an actionable trial task`);
  }
  if (!isUnclaimedRow(row)) {
    throw new BrokerArgumentsError('task.claim', `target ${target} is already claimed`);
  }
  return null;
}
const guards: Readonly<Record<BrokerGuardId, Guard>> = Object.freeze({
  read_scope: guardReadScope,
  in_branch: guardInBranch,
  in_branch_endpoints: guardInBranchEndpoints,
  acyclic: guardAcyclic,
  target_self: guardTargetSelf,
  generation_current: guardGenerationCurrent,
  ledger_readable: guardLedgerReadable,
  lock_held: guardLockHeld,
  template_whitelisted: guardTemplateWhitelisted,
  task_budget: guardTaskBudget,
  depth_budget: guardDepthBudget,
  trial_path: guardTrialPath,
  qa_whitelisted: guardQaWhitelisted,
  claimable_target: guardClaimableTarget,
});

// R12 (live token of this trial) plus the G5-W4.4 capability-shaped key scan — a guard order is
// a security property.
function authenticateCapability(ctx: BrokerContext, context: GuardContext): BrokerRefusal | null {
  const { capability, action, payload } = context;
  if (!ctx.capabilities.isRegistered(capability) || capability.trial_id !== ctx.policy.trial_id) {
    return refuse(action, 'R12');
  }
  // The scan descends into the one declared container of objects (`subtasks`), so a capability
  // field cannot be smuggled one level down.
  for (const key of capabilityShapedKeys(payload)) {
    throw new BrokerArgumentsError(action, `capability-shaped argument key: ${key}`);
  }
  return null;
}

// An action absent from §8.3's table does not exist (G5-W6.2); a non-member is a protocol error.
function actionSpecOf(context: GuardContext): BrokerActionSpec {
  const spec = Object.hasOwn(BROKER_ACTION_TABLE, context.action) ? BROKER_ACTION_TABLE[context.action] : undefined;
  if (spec === undefined) throw new BrokerArgumentsError(context.action, 'action is not a member of §8.3\'s table');
  return spec;
}

// R8 (action not in the allowed set) then R7 (§2.7 admits no runtime profile re-resolution).
function checkMembershipAndProfile(context: GuardContext): BrokerRefusal | null {
  const { capability, action, payload } = context;
  if (!capability.allowed_actions.has(action)) return refuse(action, 'R8');
  for (const key of PROFILE_SHAPED_ARGUMENT_KEYS) {
    if (Object.hasOwn(payload, key)) return refuse(action, 'R7');
  }
  return null;
}

// The schema is `.strict()` (G5-W4.4): an undeclared key is a schema rejection; then the row's
// guard list runs in fixed order.
function checkSchemaAndGuards(ctx: BrokerContext, context: GuardContext, spec: BrokerActionSpec): BrokerRefusal | null {
  for (const key of Object.keys(context.payload)) {
    if (!spec.argumentKeys.includes(key)) throw new BrokerArgumentsError(context.action, `undeclared argument key: ${key}`);
  }
  assertBrokerArguments(context.action, context.payload);
  for (const guard of spec.guards) {
    const rejection = guards[guard](ctx, context);
    if (rejection !== null) return refuse(context.action, rejection);
  }
  return null;
}
function authorize(ctx: BrokerContext, context: GuardContext): BrokerRefusal | null {
  const refused = authenticateCapability(ctx, context);
  if (refused) return refused;
  const spec = actionSpecOf(context);
  const denied = checkMembershipAndProfile(context);
  if (denied) return denied;
  return checkSchemaAndGuards(ctx, context, spec);
}

// --- §19.12.2 two-leg claim and the ten execution handlers ------------------

type Executor = (ctx: BrokerContext, capability: ActorCapability, payload: Readonly<Record<string, unknown>>) => BrokerCallResult;

/** Shared refusal→ack plumbing for the lifecycle-mutating actions. */
function mutationAck(ctx: BrokerContext, action: BenchmarkBrokerCapability, run: () => { success: boolean; code?: number; message?: string }, ok: Record<string, unknown>): BrokerCallResult {
  const rejected = mutationRefusal(action, run());
  return rejected ?? succeed(action, ok);
}
function proposalAck(action: BenchmarkBrokerCapability, result: BrokerProposalResult): BrokerCallResult {
  return proposalRefusal(action, result) ?? succeed(action, { proposal_recorded: true });
}
function executeRead(ctx: BrokerContext, capability: ActorCapability, payload: Readonly<Record<string, unknown>>): BrokerCallResult {
  const target = payload.task_id;
  const rows = typeof target === 'string'
    ? [ctx.ports.taskRepository.getById(target)].filter((task): task is Task => task !== null)
    : readableSet(ctx, capability);
  return succeed('task.read', { tasks: rows.map(projectTaskForModel) });
}
const executeCreate: Executor = (ctx, capability, payload) => mutationAck(
  ctx, 'task.create', () => ctx.ports.taskMutator.add(capability, {
    project: ctx.project, fields: { ...payload, parent: capability.task_id },
  }), { created: true });

// §8.3: `keepParent` is forced true in-trial; the destructive variant would replace the parent
// row and destroy the join node §9.4 M2 depends on.
const executeDecompose: Executor = (ctx, capability, payload) => mutationAck(
  ctx, 'task.decompose', () => ctx.ports.taskMutator.decompose(capability, {
    project: ctx.project, taskId: capability.task_id,
    fields: { subtasks: payload.subtasks, keepParent: true },
  }), { decomposed: true });

// §19.12.2: the model-facing claim calls the injected dispatcher-owned callback, never P3.claim
// directly — requester authority is never reused as target authority.
const executeClaim: Executor = (ctx, capability, payload) => mutationAck(
  ctx, 'task.claim', () => ctx.claimTarget(capability, String(payload.task_id)),
  { claimed: String(payload.task_id) });

const executeProposeComplete: Executor = (ctx, capability, payload) => proposalAck(
  'task.propose_complete', ctx.ports.taskMutator.proposeComplete(capability, capability.task_id, String(payload.note)));

const executeProposeBlock: Executor = (ctx, capability, payload) => proposalAck(
  'task.propose_block', ctx.ports.taskMutator.proposeBlock(capability, capability.task_id, String(payload.reason)));

const executeArtifactWrite: Executor = (ctx, capability, payload) => {
  ctx.ports.taskArtifacts.write(capability, String(payload.content));
  return succeed('artifact.write', { written: true });
};
const executeDeclare: Executor = (ctx, capability, payload) => mutationAck(
  ctx, 'dependency.declare', () => ctx.ports.taskMutator.edit(capability, {
    project: ctx.project, taskId: String(payload.task_id),
    fields: { addDependsOn: asStringArray(payload.depends_on) },
  }), { declared: true });

// §8.3 / §6.7: a root manager's target is the direct parent, never ask_manager.
const executeAsk: Executor = (ctx, capability, payload) => {
  const question = String(payload.question);
  const asked = capability.role === 'manager' && capability.ancestry.length === 0 ? ctx.ports.parentQuestions.record(capability, question) : ctx.ports.managerQa.ask(capability, question);
  return succeed('qa.ask', { question_id: asked.questionId });
};
const executeAnswer: Executor = (ctx, capability, payload) => {
  const result = ctx.ports.managerQa.answer(
    capability, String(payload.question_id), String(payload.answer),
  );
  return result.success
    ? succeed('qa.answer', { answered: true })
    : refusalFor('qa.answer', 'answer_stale');
};
const executeTable: Record<BenchmarkBrokerCapability, Executor> = {
  'task.read': executeRead,
  'task.create': executeCreate,
  'task.decompose': executeDecompose,
  'task.claim': executeClaim,
  'task.propose_complete': executeProposeComplete,
  'task.propose_block': executeProposeBlock,
  'artifact.write': executeArtifactWrite,
  'dependency.declare': executeDeclare,
  'qa.ask': executeAsk,
  'qa.answer': executeAnswer,
};
function execute(ctx: BrokerContext, capability: ActorCapability, action: BenchmarkBrokerCapability, payload: Readonly<Record<string, unknown>>): BrokerCallResult {
  return executeTable[action](ctx, capability, payload);
}
function readableSet(ctx: BrokerContext, capability: ActorCapability): Task[] {
  const ids = new Set([
    capability.task_id, ...capability.ancestry, ...descendantsOf(ctx, capability.task_id),
  ]);
  return [...ids]
    .map(id => ctx.ports.taskRepository.getById(id))
    .filter((task): task is Task => task !== null);
}
function run(ctx: BrokerContext, context: GuardContext): BrokerCallResult {
  const refusal = authorize(ctx, context);
  // §8.4: a rejection is RETURNED, never a silent skip, and does not touch the tree — no port
  // has been called by this point.
  if (refusal) return refusal;
  try {
    return execute(ctx, context.capability, context.action, context.payload);
  } catch (error) {
    const typed = typedPortFailure(error);
    if (typed) return refusalFor(context.action, typed.reason, typed.code);
    throw error;
  }
}
export function createBenchmarkTaskBroker(input: BrokerConstruction): BenchmarkTaskBroker {
  const ctx: BrokerContext = {
    policy: input.policy,
    ports: input.ports,
    capabilities: input.capabilities,
    project: input.project,
    trialArtifactRoot: input.trialArtifactRoot,
    claimTarget: input.claimTarget,
    templateWhitelist: new Set(input.policy.child_template_whitelist),
  };
  return {
    /** The whole model-facing surface. The capability is AMBIENT (§18 G5-W4), never a parameter. */
    async call(action, payload) {
      return run(ctx, { capability: requireAmbientCapability(ctx.capabilities), action, payload, target: null });
    },
    /** §7.2 P3's coordinator-internal signature, where the target IS named and R4 stays live. */
    async proposeComplete(capability, taskId, note) {
      return run(ctx, { capability, action: 'task.propose_complete', payload: { note }, target: taskId });
    },
    async proposeBlock(capability, taskId, reason) {
      return run(ctx, { capability, action: 'task.propose_block', payload: { reason }, target: taskId });
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** §19.12.1/§19.12.6 — narrows the proposal union by the literal `success:false` member: an exact
 *  `ProposalRow` has no success field (the bare ack is returned); a refusal is translated by
 *  value, 33 through R8 and 34 through R1, never thrown, never reaching the store. */
function proposalRefusal(action: BenchmarkBrokerCapability, result: BrokerProposalResult): BrokerRefusal | null {
  if (!('success' in result)) return null;
  if (result.success) {
    throw new TypeError('P3 proposal result carries success:true — not a ProposalRow');
  }
  return refusalForProposalCode(action, result.code);
}

function refusalForProposalCode(action: BenchmarkBrokerCapability, code: number | undefined): BrokerRefusal {
  if (code === 33) return refuse(action, 'R8');
  if (code === 34) return refuse(action, 'R1');
  throw new TypeError(`P3 returned an unsupported proposal refusal code: ${String(code)}`);
}

function typedPortFailure(error: unknown): { reason: 'proposal_invalidated' | 'ledger_unreadable'; code: 37 | 42 } | null {
  if (typeof error !== 'object' || error === null) return null;
  const { reason, code } = error as { reason?: unknown; code?: unknown };
  if (reason === 'proposal_invalidated' && code === 37) return { reason, code };
  if (reason === 'ledger_unreadable' && code === 42) return { reason, code };
  return null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function requestedTemplates(payload: Readonly<Record<string, unknown>>): string[] {
  const templates: string[] = [];
  if (typeof payload.template === 'string') templates.push(payload.template);
  if (Array.isArray(payload.subtasks)) {
    for (const subtask of payload.subtasks) {
      const template = (subtask as { template?: unknown } | null)?.template;
      if (typeof template === 'string') templates.push(template);
    }
  }
  return templates;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function objectCapabilityKeys(subtask: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of CAPABILITY_SHAPED_ARGUMENT_KEYS) {
    if (Object.hasOwn(subtask, key)) found.push(`subtasks[].${key}`);
  }
  return found;
}

/** The capability-shaped keys present in the payload, including inside `subtasks` items — the one
 *  declared container of objects. A capability field smuggled one level down is refused the same
 *  way. */
function capabilityShapedKeys(payload: Readonly<Record<string, unknown>>): string[] {
  const found: string[] = [];
  for (const key of CAPABILITY_SHAPED_ARGUMENT_KEYS) {
    if (Object.hasOwn(payload, key)) found.push(key);
  }
  if (Array.isArray(payload.subtasks)) {
    for (const subtask of payload.subtasks) {
      if (isObject(subtask)) found.push(...objectCapabilityKeys(subtask));
    }
  }
  return found;
}

function introducesCycle(edges: Map<string, string[]>, from: string): boolean {
  const seen = new Set<string>();
  const frontier = [...(edges.get(from) ?? [])];
  while (frontier.length > 0) {
    const next = frontier.pop()!;
    if (next === from) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    frontier.push(...(edges.get(next) ?? []));
  }
  return false;
}

/**
 * §8.4 R5's resolve-then-contain (the discipline `confinedJournalPath` already uses): `realpath`
 * is applied to the deepest ancestor that exists, so an uncreated leaf is still resolved through
 * every symlink — resolving only the string would let a symlinked directory escape the root.
 */
function resolveRealPath(target: string): string {
  const resolved = path.resolve(target);
  const trailing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

function containedIn(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}
