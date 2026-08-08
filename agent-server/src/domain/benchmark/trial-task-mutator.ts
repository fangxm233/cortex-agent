// input:  a coordinator-supplied structural dependency set (registry, task rows, lock assertion,
//         shipped lifecycle functions, proposal store entry, release authority)
// output: the §7.2 P3 CapabilityAwareTaskMutator — seven synchronous, capability-fenced methods
// pos:    §19.12 — the corrected P3 authority contract (R2)
// >>> If I am updated, update my header and folder CORTEX.md <<<
//
// IMPORT DISCIPLINE (§19.12.3): this module may import ONLY Node builtins and `./capabilities.js`.
// Every repository, registry, lock, proposal-row and lifecycle shape below is STRUCTURAL; the
// production wiring that binds the shipped functions lives in `domain/tasks/mutator.ts`
// (createTrialCapabilityAwareTaskMutator), which imports this module — never the reverse.
//
// The fence (§19.12.5). Every method performs the EXHAUSTIVE ordered C1–C5 fence before its first
// lifecycle, lock, refresh or store call: C1 exact live registry object; C2 production mint
// identity; C3 trial binding; C4 method authority (action membership, or the coordinator-owned
// target leg / release-transition rules for claim and unclaim); C5 actor-subject currency — the
// authoritative row and the registry attempt for `cap.task_id`, never an arbitrary target. A
// named mutation target is checked separately and never supplies the R1 comparison. Codes 33 and
// 34 are RETURNED BY VALUE, never thrown; a lifecycle/input/lock failure is `{success:false,
// message}` with no invented code.
//
// Why synchronous (§19.12.1): a method body with no `await` cannot be interleaved with any other
// trial actor on the coordinator's single-threaded loop, and the shipped synchronous
// `withTaskFileMutationLock`-wrapped lifecycle functions are still in the call path. No P3 method
// returns a Promise and none calls `runExclusive`.

import {
  isCoordinatorMintedActorCapability, type ActorCapability,
} from './capabilities.js';

/** §19.12.1 — the by-value refusal the two proposal methods return instead of a row. The broker
 *  narrows the union by the literal `success: false` member and translates 33 through R8 and 34
 *  through R1; a P3 body never throws 33/34. */
export interface MutationRefusal {
  readonly success: false;
  readonly message: string;
  readonly code: 33 | 34;
}

/** The structural ten-field proposal row: identical field-for-field to the shipped row
 *  (`proposal-seal.ts:125-153`), pinned to it by the wiring-point assignability check in
 *  `composite-runtime-ports.ts` — the ten fields are what the key §8.6 state machine persists. */
export interface ProposalRow {
  readonly task_id: string;
  readonly dispatch_generation: string;
  readonly attempt_id: string;
  readonly intent: 'complete' | 'block';
  readonly note: string | null;
  readonly state: 'proposed' | 'sealed' | 'invalidated';
  readonly unmet: readonly string[];
  readonly invalidated_by: string | null;
  readonly proposed_at: string;
  readonly settled_at: string | null;
}

/** §19.12.1 — `ProposalRow | MutationRefusal`; the two proposal methods return exactly this. */
export type ProposalMutationResult = ProposalRow | MutationRefusal;

/** The frozen §7.2 `BrokerResult` shape, declared structurally (the interface module cannot be
 *  imported here — its closure reaches `@platform/index.js`, and a reachability rule cannot
 *  exempt type-only edges, §18 G5-R2). */
export interface BrokerResult {
  success: boolean;
  message?: string;
  code?: number;
}

/** §19.12.5 — the read-only release authority. Gate 6's coordinator attempt-finalisation/
 *  recovery transition marks the exact attempt as releasing, synchronously calls `unclaim`, then
 *  clears the mark and invalidates the token. The mark is process-local state — the model cannot
 *  mint or present it, which is how P3 validates the coordinator-only direct caller. */
export interface AttemptReleaseAuthority {
  isCurrentRelease(capability: ActorCapability): boolean;
}

/** The authoritative task row fields P3 reads. Everything else stays behind the lifecycle
 *  functions and the broker. */
export interface TrialTaskRow {
  readonly id: string;
  readonly text: string;
  readonly claimed_by: string | null;
  readonly dispatch_generation: string | null;
}

export interface TrialCurrentAttempt {
  readonly dispatch_generation: string;
  readonly attempt_id: string;
}

/** The shipped lifecycle results are `{success, message, ...}`; P3 reads only the first two. */
export interface LifecycleResult {
  success: boolean;
  message?: string;
}

/** The structural proposal-store entry, mirroring `ProposalInput` (`proposal-seal.ts`). The
 *  note/reason is carried opaquely and never parsed (G4-SM7). */
export interface ProposalRecordInput {
  readonly key: {
    readonly task_id: string;
    readonly dispatch_generation: string;
    readonly attempt_id: string;
  };
  readonly intent: 'complete' | 'block';
  readonly note: string | null;
}

/** The frozen `TaskMutationRequest` of the P3 port, declared structurally. */
export interface TaskMutationRequest {
  project: string;
  taskId?: string;
  fields: Readonly<Record<string, unknown>>;
}

/** The EXHAUSTIVE structural dependency set of `createCapabilityAwareTaskMutator`. Gate 6's
 *  production bootstrap supplies the real objects through `createTrialCapabilityAwareTaskMutator`
 *  in `domain/tasks/mutator.ts`, which binds the shipped lifecycle functions. */
export interface CapabilityAwareTaskMutatorDeps {
  /** C1/C5 — the exact-object registry (S-B, `actor-capability-scope.ts`), viewed structurally. */
  readonly registry: {
    isRegistered(capability: ActorCapability): boolean;
    currentAttempt(taskId: string): TrialCurrentAttempt | null;
  };
  /** C5 — the authoritative row for a task id (the P2 repository read surface). */
  readonly getTask: (taskId: string) => TrialTaskRow | null;
  /** P2 — the authoritative actionable set, rechecked by the direct P3 claim leg. */
  readonly getActionable: () => readonly TrialTaskRow[];
  /** P2 — reload the authoritative repository view after a successful lifecycle write. */
  readonly refresh: () => void;
  /** P4 — assert the trial lock; `null` means the trial owner holds it. */
  readonly assertLock: (project: string, owner: string) => string | null;
  /** The shipped claim lifecycle (`system/task-state.ts`), lock-wrapped and synchronous. */
  readonly claimTask: (
    text: string | null, project: string, agentId: string,
    taskId: string, generation: string,
  ) => LifecycleResult;
  /** The shipped unclaim lifecycle (`system/task-state.ts`). */
  readonly unclaimTask: (
    text: string | null, project: string, taskId: string,
    ownership: { readonly generation: string },
  ) => LifecycleResult;
  /** The shipped keep-parent decompose lifecycle (`system/task-mutations.ts`) — the same function
   *  the CLI `spawn` path calls (`task-cli.ts:815-847`). */
  readonly decomposeTask: (
    project: string, text: string | null, subtasks: readonly unknown[],
    taskId: string,
    options: { readonly keepParent: boolean; readonly ownership: { readonly generation: string } },
  ) => LifecycleResult;
  /** The shipped edit lifecycle (`system/task-lifecycle-edit.ts`). */
  readonly editTask: (
    project: string, options: { readonly taskId: string; readonly addDependsOn: readonly string[] },
  ) => LifecycleResult;
  /** The shipped proposal store entry (`proposal-seal.ts`); returns the exact row to persist. */
  readonly recordProposal: (project: string, input: ProposalRecordInput) => ProposalRow;
  /** C4 — the coordinator's attempt-finalisation/recovery release transition. */
  readonly attemptReleaseAuthority: AttemptReleaseAuthority;
  /** C3 — the trial this mutator serves (the registry binding). */
  readonly trialId: string;
  /** The trial project as the lifecycle functions and the proposal store see it. */
  readonly project: string;
  /** The owner the trial lock is held under (the broker asserts the same owner). */
  readonly lockOwner: string;
}

/** The §7.2 P3 surface, structurally identical to the frozen declaration. There is deliberately
 *  no `complete`/`block`/`uncomplete`: sealing is the coordinator's (§8.6), and the two proposal
 *  methods return `ProposalMutationResult` (§19.12.1). */
export interface CapabilityAwareTaskMutator {
  claim(capability: ActorCapability, taskId: string): BrokerResult;
  unclaim(capability: ActorCapability, taskId: string): BrokerResult;
  add(capability: ActorCapability, request: TaskMutationRequest): BrokerResult;
  decompose(capability: ActorCapability, request: TaskMutationRequest): BrokerResult;
  edit(capability: ActorCapability, request: TaskMutationRequest): BrokerResult;
  proposeComplete(
    capability: ActorCapability, taskId: string, note: string,
  ): ProposalMutationResult;
  proposeBlock(
    capability: ActorCapability, taskId: string, reason: string,
  ): ProposalMutationResult;
}

function authorityRefusal(message: string): MutationRefusal {
  return Object.freeze({ success: false as const, message, code: 33 as const });
}

function staleRefusal(message: string): MutationRefusal {
  return Object.freeze({ success: false as const, message, code: 34 as const });
}

/** C1–C3 — the exact live registered production-minted token bound to this trial. Token-id
 *  equality is insufficient: `isRegistered` is the exact-object registry check and the WeakSet
 *  identity is the mint check (§19.12.5). */
function subjectFence(deps: CapabilityAwareTaskMutatorDeps, capability: ActorCapability): MutationRefusal | null {
  if (!deps.registry.isRegistered(capability)) {
    return authorityRefusal('capability is not the exact registered live token (§8.2)');
  }
  if (!isCoordinatorMintedActorCapability(capability)) {
    return authorityRefusal('capability was not minted by the production coordinator mint (§8.2)');
  }
  if (capability.trial_id !== deps.trialId) {
    return authorityRefusal('capability belongs to another trial (§1.4)');
  }
  return null;
}

/** C5 — actor-subject currency. ALWAYS reads `cap.task_id`: the authoritative row's generation
 *  and the registry's current attempt must equal the capability. A named mutation target is
 *  checked separately and never supplies this comparison (§19.12.5). */
function staleSelf(deps: CapabilityAwareTaskMutatorDeps, capability: ActorCapability): MutationRefusal | null {
  const attempt = deps.registry.currentAttempt(capability.task_id);
  if (attempt === null
    || attempt.attempt_id !== capability.attempt_id
    || attempt.dispatch_generation !== capability.dispatch_generation) {
    return staleRefusal('capability is not the task\'s current attempt (D-9)');
  }
  const row = deps.getTask(capability.task_id);
  if (row === null || row.dispatch_generation !== capability.dispatch_generation) {
    return staleRefusal('stale task dispatch generation');
  }
  return null;
}

function lifecycleFailure(message: string | undefined, fallback: string): BrokerResult {
  return { success: false, message: message ?? fallback };
}

function proposal(
  deps: CapabilityAwareTaskMutatorDeps,
  capability: ActorCapability,
  taskId: string,
  intent: 'complete' | 'block',
  note: string,
): ProposalMutationResult {
  const subject = subjectFence(deps, capability);
  if (subject) return subject;
  if (taskId !== capability.task_id) {
    return authorityRefusal('proposal target is not the capability\'s own task (R4)');
  }
  const action = intent === 'complete' ? 'task.propose_complete' : 'task.propose_block';
  if (!capability.allowed_actions.has(action)) {
    return authorityRefusal(`${action} is not in the capability's allowed actions (R8)`);
  }
  const stale = staleSelf(deps, capability);
  if (stale) return stale;
  return deps.recordProposal(deps.project, {
    key: {
      task_id: capability.task_id,
      dispatch_generation: capability.dispatch_generation,
      attempt_id: capability.attempt_id,
    },
    intent,
    note,
  });
}

/** §19.12.4 — the seven-method lifecycle mapping, synchronous end to end. */
export function createCapabilityAwareTaskMutator(
  deps: CapabilityAwareTaskMutatorDeps,
): CapabilityAwareTaskMutator {
  return {
    /** Coordinator-only target leg: the capability IS the fresh target capability, so C1–C3 plus
     *  self-target prove the leg; C5's pre-claim requires an unclaimed/null-generation row and a
     *  registry attempt equal to the fresh capability. The lifecycle writes the capability's own
     *  attempt as the agent and its own fresh generation. */
    claim(capability, taskId) {
      const subject = subjectFence(deps, capability);
      if (subject) return subject;
      if (taskId !== capability.task_id) {
        return authorityRefusal('claim target is not the capability\'s own task');
      }
      const attempt = deps.registry.currentAttempt(capability.task_id);
      if (attempt === null
        || attempt.attempt_id !== capability.attempt_id
        || attempt.dispatch_generation !== capability.dispatch_generation) {
        return staleRefusal('capability is not the target\'s current attempt (D-9)');
      }
      const row = deps.getTask(capability.task_id);
      if (row === null) return staleRefusal('task row missing');
      if (row.claimed_by !== null || row.dispatch_generation !== null) {
        return staleRefusal('target is already claimed');
      }
      if (!deps.getActionable().some(task => task.id === capability.task_id)) {
        return lifecycleFailure('target is not actionable', 'claim refused');
      }
      const result = deps.claimTask(
        row.text, deps.project, capability.attempt_id, taskId, capability.dispatch_generation,
      );
      if (!result.success) return lifecycleFailure(result.message, 'claim refused');
      deps.refresh();
      return { success: true, message: result.message };
    },

    /** Self-release only: the exact registered/minted/current capability of the attempt the
     *  coordinator's finalisation/recovery transition is releasing. Every RoleSlot is eligible
     *  only as the current role of that same attempt; there is no role-authority shortcut and no
     *  cross-target release. */
    unclaim(capability, taskId) {
      const subject = subjectFence(deps, capability);
      if (subject) return subject;
      if (taskId !== capability.task_id) {
        return authorityRefusal('unclaim targets a task other than the capability\'s own');
      }
      if (!deps.attemptReleaseAuthority.isCurrentRelease(capability)) {
        return authorityRefusal('attempt is not in the coordinator finalisation/recovery release transition');
      }
      const stale = staleSelf(deps, capability);
      if (stale) return stale;
      const row = deps.getTask(capability.task_id)!;
      const result = deps.unclaimTask(row.text, deps.project, capability.task_id, {
        generation: capability.dispatch_generation,
      });
      if (!result.success) return lifecycleFailure(result.message, 'unclaim refused');
      deps.refresh();
      return { success: true, message: result.message };
    },

    /** §19.12.4 — one-child keep-parent spawn: the same `decomposeTask(project, null, [subtask],
     *  cap.task_id, {keepParent:true, ownership})` the shipped CLI `spawn` path uses. The child
     *  hangs under `cap.task_id` and the retained parent joins on it; top-level `addTask` (which
     *  sets `parent:null`) is never called, and no system-lock path is reachable. */
    add(capability, request) {
      const subject = subjectFence(deps, capability);
      if (subject) return subject;
      if (!capability.allowed_actions.has('task.create')) {
        return authorityRefusal('task.create is not in the capability\'s allowed actions (R8)');
      }
      const stale = staleSelf(deps, capability);
      if (stale) return stale;
      const lockError = deps.assertLock(deps.project, deps.lockOwner);
      if (lockError !== null) return lifecycleFailure(lockError, 'project lock not held (R10)');
      const fields = request.fields;
      const subtask: Record<string, unknown> = { text: String(fields.text ?? '') };
      for (const key of ['why', 'done_when', 'template', 'priority', 'plan'] as const) {
        if (fields[key] !== undefined) subtask[key] = String(fields[key]);
      }
      if (fields.depends_on !== undefined && Array.isArray(fields.depends_on)) {
        subtask.depends_on = (fields.depends_on as unknown[]).map(String);
      }
      if (!String(subtask.text)) return lifecycleFailure('task text is required', 'add refused');
      const result = deps.decomposeTask(deps.project, null, [subtask], capability.task_id, {
        keepParent: true,
        ownership: { generation: capability.dispatch_generation },
      });
      if (!result.success) return lifecycleFailure(result.message, 'add refused');
      deps.refresh();
      return { success: true, message: result.message };
    },

    /** Keep-parent decomposition of the capability's own task, ownership-fenced; the join parent
     *  survives (§9.4 M-2). */
    decompose(capability, request) {
      const subject = subjectFence(deps, capability);
      if (subject) return subject;
      if (!capability.allowed_actions.has('task.decompose')) {
        return authorityRefusal('task.decompose is not in the capability\'s allowed actions (R8)');
      }
      const stale = staleSelf(deps, capability);
      if (stale) return stale;
      const lockError = deps.assertLock(deps.project, deps.lockOwner);
      if (lockError !== null) return lifecycleFailure(lockError, 'project lock not held (R10)');
      const subtasks = Array.isArray(request.fields.subtasks) ? request.fields.subtasks : [];
      if (subtasks.length === 0) return lifecycleFailure('decompose requires at least one subtask', 'decompose refused');
      const result = deps.decomposeTask(deps.project, null, subtasks, capability.task_id, {
        keepParent: true,
        ownership: { generation: capability.dispatch_generation },
      });
      if (!result.success) return lifecycleFailure(result.message, 'decompose refused');
      deps.refresh();
      return { success: true, message: result.message };
    },

    /** dependency.declare: R1 is proven against `cap.task_id`; the named target is the separate
     *  concern of the broker's descendant/endpoints/acyclic guards and is never the R1 subject. */
    edit(capability, request) {
      const subject = subjectFence(deps, capability);
      if (subject) return subject;
      if (!capability.allowed_actions.has('dependency.declare')) {
        return authorityRefusal('dependency.declare is not in the capability\'s allowed actions (R8)');
      }
      const stale = staleSelf(deps, capability);
      if (stale) return stale;
      const lockError = deps.assertLock(deps.project, deps.lockOwner);
      if (lockError !== null) return lifecycleFailure(lockError, 'project lock not held (R10)');
      const targetId = typeof request.taskId === 'string' ? request.taskId : '';
      const addDependsOn = Array.isArray(request.fields.addDependsOn)
        ? (request.fields.addDependsOn as unknown[]).map(String)
        : [];
      const result = deps.editTask(deps.project, { taskId: targetId, addDependsOn });
      if (!result.success) return lifecycleFailure(result.message, 'edit refused');
      deps.refresh();
      return { success: true, message: result.message };
    },

    /** §19.12.6 — records the intent through the shipped store entry exactly once and returns
     *  the SAME object reference it returns; note stays opaque. Refusals precede the store call
     *  and leave the proposal file absent/unchanged; codes 33/34 are never exceptions. */
    proposeComplete(capability, taskId, note) {
      return proposal(deps, capability, taskId, 'complete', note);
    },

    proposeBlock(capability, taskId, reason) {
      return proposal(deps, capability, taskId, 'block', reason);
    },
  };
}
