// input:  a broker action, untrusted arguments, and the ambient capability
// output: the authorised effect, or a typed refusal that does not touch the tree
// pos:    §8.3's authorization matrix, §8.4's twelve rejections and §8.5's projection split
// >>> If I am updated, update my header and folder CORTEX.md <<<
//
// THE FENCE, not a convention. §8.3's matrix is exhaustive and says so — "an action absent from
// this table does not exist" (`design:2409-2410`) — so the table below is the whole surface: there
// is no `task.complete`, no `task.block` and no `task.uncomplete`, because sealing is the
// coordinator's act (§8.6). Each row carries its GUARD list, not merely its membership.
//
// Import discipline, the reason this module does not import `composite-runtime-ports.ts` or
// `proposal-seal.ts`: a dependency-cruiser reachability rule cannot exempt type-only edges
// (§18 G5-R2), and both modules reach `@platform/index.js` through `core/types/thread-types.ts:476`.
// Importing either — even for a type — would make this module an eighth §7.3 X2 seed and raise
// that rule's pinned count. The port shapes it consumes are therefore declared STRUCTURALLY below;
// `task-broker.test.ts` pins them to the frozen §7.2 declarations with a compile-time assignability
// check, which lives in the test tree and so is not a `src` edge.
//
// What is NOT here: the proposal → seal machine (Gate 4's `proposal-seal.ts`, reached through the
// P3 port per §7.2 P3 / (17.2.1), never re-implemented), `CapabilityAwareTaskMutator` itself (the
// next child's), §8.6's seal and publication sites (Gate 6's), and the MCP registration surface
// and P15 transport (§18 (18.4); wave 3 and Gate 6). §8.5 is therefore proven against this
// module's own call surface, which is stated rather than papered over.

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
 * R6, R9 and R10 carry NO `code` key at all. §18's finding G5-N4 records that those three
 * rejections have no failure code anywhere in the contract and sets the interim rule binding on
 * Gate 5: return the refusal with `reason` set to the §8.4 name and OMIT `code`, rather than reuse
 * a code for a different condition — which §2.6 names explicitly as a defect (`design:442`). In
 * particular R6 does NOT borrow compile-time code 20: 20 is Class **P** ("nothing started"), and a
 * runtime broker refusal is Class R. The §2.6 registry stays a contiguous 1–44.
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
 * §18 G5-W7's frame, minus `seq`: `seq` belongs to leg 2's newline-delimited framing
 * (G5-W6.2/6.3), and the transport is not Gate 5's. There is deliberately NO message field —
 * §2.6's P-iii/R-iii require a machine-readable reason, and a refusal that carries prose invites a
 * consumer to parse it. `status` is §5.2's `rejected`: NON-terminal for the tree.
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

function succeed(
  action: BenchmarkBrokerCapability, result: Readonly<Record<string, unknown>>,
): BrokerSuccess {
  return Object.freeze({ ok: true as const, status: 'completed' as const, action, result });
}

/** P3's frozen error modes are code 33 capability miss and code 34 generation miss. A false result
 *  is already a no-mutation refusal; never turn it into a success acknowledgement. */
function mutationRefusal(
  action: BenchmarkBrokerCapability,
  result: { readonly success: boolean; readonly code?: number },
): BrokerRefusal | null {
  if (result.success) return null;
  if (result.code === 33) return refuse(action, 'R8');
  if (result.code === 34) return refuse(action, 'R1');
  throw new TypeError(`P3 returned an unsupported failure code: ${String(result.code)}`);
}

// ── §18 (18.3) G5-W5 the ten entry points ───────────────────────────────────

/**
 * G5-W5's tool-name column, exhaustive: these ten names are the entire model-facing broker surface.
 * The mapping is total and mechanical — the action name with `.` replaced by `_` — except the two
 * `qa.*` actions, whose names §6.7 already fixed to the shipped `ask_manager` / `answer_subtask`.
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
 * rather than using one, which §18's rule forbids outright; G5-W4.4 classifies the call as a
 * schema rejection, so the broker refuses it as `BrokerArgumentsError`. `task_id` is deliberately
 * NOT a member: it is a legitimate TARGET argument on three actions, and what G5-W4.4 excludes is
 * `task_id`-of-self, which no schema declares.
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
  | 'task_budget' | 'depth_budget' | 'trial_path' | 'qa_whitelisted';

export interface BrokerActionSpec {
  readonly action: BenchmarkBrokerCapability;
  readonly tool: string;
  /** The `.strict()` key set. A key outside it is refused, never ignored. */
  readonly argumentKeys: readonly string[];
  /** §8.3's "Additional guards beyond capability membership" column, as data. */
  readonly guards: readonly BrokerGuardId[];
}

function row(
  action: BenchmarkBrokerCapability,
  argumentKeys: readonly string[],
  guards: readonly BrokerGuardId[],
): BrokerActionSpec {
  return Object.freeze({
    action,
    tool: BROKER_TOOL_NAMES[action],
    argumentKeys: Object.freeze([...argumentKeys]),
    guards: Object.freeze([...guards]),
  });
}

/**
 * §8.3's matrix. Exactly ten rows, and the absence of a field is how a whole rejection class is
 * made UNEXPRESSIBLE rather than policed: `task.create` has no `parent` (§8.3 fixes it to
 * `cap.task_id`), `task.decompose` no `keep_parent` (forced `true`, so the destructive variant that
 * would destroy §9.4 M2's join node is unreachable), `task.claim` no `generation` (only the
 * dispatcher mints one), the two proposals no `task_id` (R4's class removed from the model-facing
 * surface, not policed), and `artifact.write` no `path` (fixed to `manager/<cap.task_id>/artifact.md`).
 */
export const BROKER_ACTION_TABLE: Readonly<Record<BenchmarkBrokerCapability, BrokerActionSpec>> =
  Object.freeze({
    'task.read': row('task.read', ['task_id'], ['read_scope']),
    'task.create': row(
      'task.create',
      ['text', 'why', 'done_when', 'template', 'priority', 'plan', 'depends_on'],
      ['lock_held', 'template_whitelisted', 'task_budget', 'depth_budget'],
    ),
    'task.decompose': row(
      'task.decompose', ['subtasks'],
      ['lock_held', 'generation_current', 'template_whitelisted', 'task_budget', 'depth_budget'],
    ),
    'task.claim': row('task.claim', ['task_id'], ['in_branch']),
    'task.propose_complete': row(
      'task.propose_complete', ['note'],
      ['target_self', 'generation_current', 'ledger_readable'],
    ),
    'task.propose_block': row(
      'task.propose_block', ['reason'], ['target_self', 'generation_current'],
    ),
    'artifact.write': row('artifact.write', ['content'], ['trial_path']),
    'dependency.declare': row(
      'dependency.declare', ['task_id', 'depends_on'], ['in_branch_endpoints', 'acyclic'],
    ),
    'qa.ask': row('qa.ask', ['question'], ['qa_whitelisted']),
    'qa.answer': row('qa.answer', ['question_id', 'answer'], ['qa_whitelisted']),
  });

// ── §8.5 the model-visible projection ───────────────────────────────────────

/**
 * EXHAUSTIVE, and proved so: `MODEL_VISIBLE_TASK_FIELDS ∪ PROJECTION_WITHHELD_TASK_FIELDS` is
 * exactly `keyof Task`, checked at compile time below and again by test against a real row. A field
 * added to `Task` lands in neither list and stops the build, so the projection cannot silently
 * start carrying something new.
 */
export const MODEL_VISIBLE_TASK_FIELDS = Object.freeze([
  'id', 'text', 'why', 'done_when', 'priority', 'status', 'template', 'plan', 'project',
  'parent', 'depends_on', 'gpu', 'gpu_count', 'blocked_by', 'paused', 'approval_needed',
  'approved_at', 'not_before', 'completed_at', 'completed_note', 'pending_at',
] as const satisfies readonly (keyof Task)[]);

/**
 * §8.5's "claims / generations … not projected at all" (`design:2460`) plus the host-side
 * provenance fields, which are fencing data in exactly the sense §8.5's Q&A row means: "the model
 * sees the question, never the record's fencing fields".
 *
 * `dispatch_generation` is the load-bearing member. A generation is never shown to a model, so it
 * cannot be echoed back into a mutation — and G5-W4.5 makes that STRUCTURAL rather than a review
 * convention, because no argument of any of the ten accepts one either.
 */
export const PROJECTION_WITHHELD_TASK_FIELDS = Object.freeze([
  'dispatch_generation', 'claimed_by', 'claimed_at',
  'origin_session_id', 'origin_channel', 'origin_thread_id',
] as const satisfies readonly (keyof Task)[]);

type ProjectionPartitionGap = Exclude<
  keyof Task,
  typeof MODEL_VISIBLE_TASK_FIELDS[number] | typeof PROJECTION_WITHHELD_TASK_FIELDS[number]
>;
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

/** The narrowed, structural view of the frozen §7.2 ports this broker calls. The frozen bundle must
 *  satisfy it (pinned by test), and it references the S-B `ActorCapability` for every `cap`
 *  parameter, exactly as the frozen declarations do after the token wiring. */
export interface BrokerPorts {
  readonly taskRepository: {
    getById(taskId: string): Task | null;
    list(filter: { project?: string; status?: string; parent?: string }): Task[];
  };
  readonly taskMutator: {
    claim(
      capability: ActorCapability, taskId: string,
    ): { success: boolean; code?: number };
    add(
      capability: ActorCapability, request: BrokerMutationRequest,
    ): { success: boolean; code?: number };
    decompose(
      capability: ActorCapability, request: BrokerMutationRequest,
    ): { success: boolean; code?: number };
    edit(
      capability: ActorCapability, request: BrokerMutationRequest,
    ): { success: boolean; code?: number };
    /** Routes into Gate 4's shipped `proposal-seal.ts` through P3, per §7.2 P3 / (17.2.1), which
     *  is the next child's coupling — never re-implemented here. */
    proposeComplete(
      capability: ActorCapability, taskId: string, note: string,
    ): { readonly state: string };
    proposeBlock(
      capability: ActorCapability, taskId: string, reason: string,
    ): { readonly state: string };
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
    answer(
      capability: ActorCapability, questionId: string, answer: string,
    ): { success: boolean };
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
}

export interface BenchmarkTaskBroker {
  /** The whole model-facing surface. The capability is AMBIENT (§18 G5-W4) and is not a parameter:
   *  a caller can only USE a capability, never NAME one. */
  call(
    action: BenchmarkBrokerCapability, payload: Readonly<Record<string, unknown>>,
  ): Promise<BrokerCallResult>;
  /** §7.2 P3's coordinator-internal signature, where the target IS named and R4 therefore stays
   *  live. G5-W3: §8.3's "Broker method" column names coordinator-internal methods, not
   *  model-facing entry points. */
  proposeComplete(
    capability: ActorCapability, taskId: string, note: string,
  ): Promise<BrokerCallResult>;
  proposeBlock(
    capability: ActorCapability, taskId: string, reason: string,
  ): Promise<BrokerCallResult>;
}

// ── the fence ───────────────────────────────────────────────────────────────

export function createBenchmarkTaskBroker(input: BrokerConstruction): BenchmarkTaskBroker {
  const { policy, ports, capabilities, project, trialArtifactRoot } = input;
  const templateWhitelist = new Set(policy.child_template_whitelist);

  function descendantsOf(taskId: string): Set<string> {
    const found = new Set<string>();
    const frontier = [taskId];
    while (frontier.length > 0) {
      for (const child of ports.taskRepository.list({ parent: frontier.pop()! })) {
        if (found.has(child.id)) continue;
        found.add(child.id);
        frontier.push(child.id);
      }
    }
    return found;
  }

  /** §8.4 R2/R3 in one decision, because their order matters: a target in `cap.ancestry` is the
   *  UPWARD case R3 names specifically, and only a target that is neither self nor a descendant nor
   *  an ancestor falls through to R2's general cross-branch case. */
  function branchRejection(
    capability: ActorCapability, targetId: string,
  ): BrokerRejectionId | null {
    if (targetId === capability.task_id) return null;
    if (capability.ancestry.includes(targetId)) return 'R3';
    return descendantsOf(capability.task_id).has(targetId) ? null : 'R2';
  }

  interface GuardContext {
    readonly capability: ActorCapability;
    readonly action: BenchmarkBrokerCapability;
    readonly payload: Readonly<Record<string, unknown>>;
    /** Leg 1's explicitly named target (§7.2 P3's `proposeComplete(cap, taskId, note)`). `null` on
     *  the model-facing surface, whose schemas declare no `task_id` for the two proposals — which
     *  is how §8.4 R4's class is REMOVED there rather than policed. */
    readonly target: string | null;
  }

  type Guard = (context: GuardContext) => BrokerRejectionId | null;

  const guardTable: Record<BrokerGuardId, Guard> = {
    read_scope: ({ capability, payload }) => {
      const target = payload.task_id;
      if (typeof target !== 'string') return null;
      if (target === capability.task_id || capability.ancestry.includes(target)) return null;
      return descendantsOf(capability.task_id).has(target) ? null : 'R2';
    },

    in_branch: ({ capability, payload }) => branchRejection(capability, String(payload.task_id)),

    in_branch_endpoints: ({ capability, payload }) => {
      const endpoints = [String(payload.task_id), ...asStringArray(payload.depends_on)];
      for (const endpoint of endpoints) {
        const rejection = branchRejection(capability, endpoint);
        if (rejection !== null) return rejection;
      }
      return null;
    },

    acyclic: ({ payload }) => {
      const from = String(payload.task_id);
      const edges = new Map<string, string[]>();
      for (const task of ports.taskRepository.list({})) edges.set(task.id, [...task.depends_on]);
      edges.set(from, [...(edges.get(from) ?? []), ...asStringArray(payload.depends_on)]);
      if (introducesCycle(edges, from)) {
        // §8.3's guard column requires the resulting graph to stay acyclic, but the closed R1–R12
        // map has no member for a cyclic declare — so this is a mutation-validity refusal of the
        // same class as a schema rejection, not an R-refusal (no code exists, and none may be
        // minted, §18 G5-N4; reusing R2's code for it would be the §2.6 defect).
        throw new BrokerArgumentsError(
          'dependency.declare', 'the resulting dependency graph would contain a cycle',
        );
      }
      return null;
    },

    target_self: ({ capability, target }) => {
      if (target === null || target === capability.task_id) return null;
      return capability.ancestry.includes(target) ? 'R3' : 'R4';
    },

    generation_current: ({ capability }) => {
      const task = ports.taskRepository.getById(capability.task_id);
      if (task === null) return 'R2';
      if (task.dispatch_generation !== capability.dispatch_generation) return 'R1';
      // D-9: the same generation can carry more than one attempt (rework re-entry, manager
      // rotation), so the generation match alone is not the fence §8.4 R1 asks for. The task's
      // current attempt is the coordinator-side record the registry keeps at registration.
      const current = capabilities.currentAttempt(capability.task_id);
      if (current === null || current.attempt_id !== capability.attempt_id) return 'R1';
      return null;
    },

    ledger_readable: ({ capability }) => {
      try {
        ports.acceptanceLedger.pending(project, capability.task_id);
        return null;
      } catch {
        // D-11 inverts the shipped fail-open at `acceptance-ledger.ts:38-48`: an unreadable ledger
        // reads as "nothing pending", which would admit a proposal §9.4 M-4 must fence.
        return 'R11';
      }
    },

    lock_held: ({ capability }) => (
      // One project, one lock, held by the trial: every actor of the trial asserts the same owner.
      ports.taskLocks.assertHeld(project, capability.trial_id) === null ? null : 'R10'
    ),

    template_whitelisted: ({ payload }) => {
      for (const template of requestedTemplates(payload)) {
        if (!templateWhitelist.has(template)) return 'R6';
      }
      return null;
    },

    task_budget: ({ action, payload }) => {
      const added = action === 'task.decompose' && Array.isArray(payload.subtasks)
        ? payload.subtasks.length : 1;
      return ports.taskRepository.list({}).length + added > policy.limits.max_tasks
        ? 'R9' : null;
    },

    // §8.3: `depth(cap) < max_task_depth`. The actor's depth is the length of its ancestry; a
    // child it creates would sit one level deeper.
    depth_budget: ({ capability }) => (
      capability.ancestry.length >= policy.limits.max_task_depth ? 'R9' : null
    ),

    trial_path: ({ capability }) => {
      const target = ports.taskArtifacts.artifactPath(project, capability.task_id);
      return containedIn(resolveRealPath(trialArtifactRoot), resolveRealPath(target))
        ? null : 'R5';
    },

    // §2.4: Q&A disabled means the capabilities are ABSENT, not refused. This re-checks the frozen
    // policy as well as the token, so a token whose allowed_actions somehow exceeded the arm's
    // whitelist is still refused.
    qa_whitelisted: ({ capability, action }) => (
      policy.capability_whitelist.includes(action) && capability.allowed_actions.has(action)
        ? null : 'R8'
    ),
  };

  const guards: Readonly<Record<BrokerGuardId, Guard>> = Object.freeze(guardTable);

  /**
   * The authorisation order, fixed and documented because a guard order is a security property:
   * a caller must never learn from a refusal something the earlier fence would have denied, and
   * a forged-authority attempt is refused before anything else.
   */
  function authorize(context: GuardContext): BrokerRefusal | null {
    const { capability, action, payload } = context;
    // R12 — the token must be live and belong to THIS trial. §8.2's lifetime rule is immediate, so
    // a capability invalidated between registration and call fails here rather than at the next one.
    if (!capabilities.isRegistered(capability) || capability.trial_id !== policy.trial_id) {
      return refuse(action, 'R12');
    }
    // G5-W4.4 — naming a capability instead of using one is a schema rejection, and the broker
    // re-enforces the exclusion so the property is structural rather than a review convention.
    // The scan descends into the one declared container of objects (`subtasks`), so a capability
    // field cannot be smuggled one level down.
    for (const key of capabilityShapedKeys(payload)) {
      throw new BrokerArgumentsError(action, `capability-shaped argument key: ${key}`);
    }
    // An action absent from §8.3's table does not exist (G5-W6.2: the action must be a member of
    // the closed union); a non-member is a protocol error, not an R-refusal.
    const spec = Object.hasOwn(BROKER_ACTION_TABLE, action)
      ? BROKER_ACTION_TABLE[action] : undefined;
    if (spec === undefined) {
      throw new BrokerArgumentsError(action, 'action is not a member of §8.3\'s table');
    }
    // R8 — the requested action is not in the capability's allowed set.
    if (!capability.allowed_actions.has(action)) {
      return refuse(action, 'R8');
    }
    // R7 — §2.7 admits no runtime profile re-resolution by any actor; a profile-naming key is the
    // broker surface's only place R7 can fire.
    for (const key of PROFILE_SHAPED_ARGUMENT_KEYS) {
      if (Object.hasOwn(payload, key)) return refuse(action, 'R7');
    }
    // The schema is `.strict()` (G5-W4.4): an undeclared key is a schema rejection.
    for (const key of Object.keys(payload)) {
      if (!spec.argumentKeys.includes(key)) {
        throw new BrokerArgumentsError(action, `undeclared argument key: ${key}`);
      }
    }
    assertBrokerArguments(action, payload);
    for (const guard of spec.guards) {
      const rejection = guards[guard](context);
      if (rejection !== null) return refuse(action, rejection);
    }
    return null;
  }

  function execute(
    capability: ActorCapability,
    action: BenchmarkBrokerCapability,
    payload: Readonly<Record<string, unknown>>,
  ): BrokerCallResult {
    switch (action) {
      case 'task.read': {
        const target = payload.task_id;
        const rows = typeof target === 'string'
          ? [ports.taskRepository.getById(target)].filter((task): task is Task => task !== null)
          : readableSet(capability);
        return succeed(action, { tasks: rows.map(projectTaskForModel) });
      }
      case 'task.create': {
        const rejected = mutationRefusal(action, ports.taskMutator.add(capability, {
          project, fields: { ...payload, parent: capability.task_id },
        }));
        return rejected ?? succeed(action, { created: true });
      }
      case 'task.decompose': {
        const rejected = mutationRefusal(action, ports.taskMutator.decompose(capability, {
          project,
          taskId: capability.task_id,
          // §8.3: `keepParent` is forced true in-trial; the destructive variant would replace the
          // parent row and destroy the join node §9.4 M2 depends on.
          fields: { subtasks: payload.subtasks, keepParent: true },
        }));
        return rejected ?? succeed(action, { decomposed: true });
      }
      case 'task.claim': {
        const target = String(payload.task_id);
        const rejected = mutationRefusal(action, ports.taskMutator.claim(capability, target));
        return rejected ?? succeed(action, { claimed: target });
      }
      case 'task.propose_complete':
        ports.taskMutator.proposeComplete(capability, capability.task_id, String(payload.note));
        // §8.6: the model does not get to see its own proposal as a result — the row carries the
        // generation and the attempt (G5-W4.5), so only the bare ack is returned.
        return succeed(action, { proposal_recorded: true });
      case 'task.propose_block':
        ports.taskMutator.proposeBlock(capability, capability.task_id, String(payload.reason));
        return succeed(action, { proposal_recorded: true });
      case 'artifact.write':
        ports.taskArtifacts.write(capability, String(payload.content));
        return succeed(action, { written: true });
      case 'dependency.declare': {
        const rejected = mutationRefusal(action, ports.taskMutator.edit(capability, {
          project,
          taskId: String(payload.task_id),
          fields: { addDependsOn: asStringArray(payload.depends_on) },
        }));
        return rejected ?? succeed(action, { declared: true });
      }
      case 'qa.ask': {
        const question = String(payload.question);
        // §8.3 / §6.7: a root manager's target is the direct parent, never ask_manager.
        const asked = capability.role === 'manager' && capability.ancestry.length === 0
          ? ports.parentQuestions.record(capability, question)
          : ports.managerQa.ask(capability, question);
        return succeed(action, { question_id: asked.questionId });
      }
      case 'qa.answer': {
        const result = ports.managerQa.answer(
          capability, String(payload.question_id), String(payload.answer),
        );
        return result.success
          ? succeed(action, { answered: true })
          : refusalFor(action, 'answer_stale');
      }
    }
  }

  function readableSet(capability: ActorCapability): Task[] {
    const ids = new Set([
      capability.task_id, ...capability.ancestry, ...descendantsOf(capability.task_id),
    ]);
    return [...ids]
      .map(id => ports.taskRepository.getById(id))
      .filter((task): task is Task => task !== null);
  }

  function run(context: GuardContext): BrokerCallResult {
    const refusal = authorize(context);
    // §8.4: a rejection is a typed refusal RETURNED to the caller, never a silent skip, and it does
    // not touch the tree — which is why no port has been called by this point.
    if (refusal) return refusal;
    try {
      return execute(context.capability, context.action, context.payload);
    } catch (error) {
      const typed = typedPortFailure(error);
      if (typed) return refusalFor(context.action, typed.reason, typed.code);
      throw error;
    }
  }

  return {
    async call(action, payload) {
      return run({
        capability: requireAmbientCapability(capabilities), action, payload, target: null,
      });
    },
    async proposeComplete(capability, taskId, note) {
      return run({
        capability, action: 'task.propose_complete', payload: { note }, target: taskId,
      });
    },
    async proposeBlock(capability, taskId, reason) {
      return run({
        capability, action: 'task.propose_block', payload: { reason }, target: taskId,
      });
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function typedPortFailure(
  error: unknown,
): { reason: 'proposal_invalidated' | 'ledger_unreadable'; code: 37 | 42 } | null {
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
      if (typeof subtask !== 'object' || subtask === null) continue;
      for (const key of CAPABILITY_SHAPED_ARGUMENT_KEYS) {
        if (Object.hasOwn(subtask, key)) found.push(`subtasks[].${key}`);
      }
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
 * §8.4 R5's resolve-then-contain, the discipline `confinedJournalPath` already uses
 * (`trajectory-merge.ts:150` at §18's pin). `realpath` is applied to the deepest ancestor that
 * exists, so a path whose leaf has not been created yet is still resolved through every symlink on
 * the way — resolving only the string would let a symlinked directory escape the root.
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
