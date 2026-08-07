// input:  a fragment's journal, lifecycle and identity facts
// output: the §9.1 attempt record, the closed §9.2 edge union, and derived attempt identity
// pos:    Per-attempt record and attempt-DAG edge vocabulary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { Backend } from '../../agent-adapter/types.js';
import type { AgentSlot } from '../agent-run/journal.js';
import type { TerminalReason, TerminalState } from '../agent-run/manifest-contract.js';

/**
 * An attempt is a FRAGMENT — one process or one thread — never a step. §17 (17.3.1) ruled this
 * (Branch B) against three frozen statements that cannot all be literally true. The load-bearing
 * consequence: an attempt is the unit that OWNS A JOURNAL, so `journal_sha256`, `event_count` and
 * the `<stem>.started.json`/`<stem>.terminal.json` pair are each well-defined for exactly one node.
 */

export const ATTEMPT_DISPOSITIONS = [
  'accepted', 'rejected', 'superseded', 'invalidated', 'none',
] as const;
export type AttemptDisposition = typeof ATTEMPT_DISPOSITIONS[number];

/**
 * The endpoints of §9.2's edges are heterogeneous — `depends_on` is task→task, `decompose` is
 * attempt→task, `dispatch` task→attempt, `proposal` attempt→proposal, `seal` proposal→outcome — so
 * a bare string endpoint cannot express them. `direct-parent` carries no id: it is §9.2 invariant
 * 1's named exception and resolves to `roots.parent_attempt_id`.
 */
export const ENDPOINT_REF_KINDS = [
  'attempt', 'task', 'proposal', 'outcome', 'direct-parent',
] as const;
export type EndpointRefKind = typeof ENDPOINT_REF_KINDS[number];

export type EndpointRef =
  | { readonly ref: 'attempt'; readonly id: string }
  | { readonly ref: 'task'; readonly id: string }
  | { readonly ref: 'proposal'; readonly id: string }
  | { readonly ref: 'outcome'; readonly id: string }
  | { readonly ref: 'direct-parent' };

/**
 * THIRTEEN kinds. §9.2's table has twelve ROWS (`design:2680`-`:2691`) but its last row names two
 * kinds, `question` and `answer`. A union built by counting rows ships twelve members and silently
 * rejects a legal edge. Array order is §9.2's own row order and is the `kind_ordinal` G4-CM17 sorts
 * by; the ordinal itself is never written to the wire.
 */
export const ATTEMPT_EDGE_KINDS = [
  'spawn', 'decompose', 'depends_on', 'dispatch', 'proposal', 'seal', 'delivery',
  'verdict', 'rework', 'supersede', 'rotation', 'question', 'answer',
] as const;
export type AttemptEdgeKind = typeof ATTEMPT_EDGE_KINDS[number];

export interface AttemptEdge {
  readonly kind: AttemptEdgeKind;
  /** Three members, no payload (G4-CM16): the edge records topology only. A question's text lives
   * in the mailbox, a verdict's note in the acceptance ledger, a proposal's note in the proposal
   * store. A manifest that can disagree with the ledger is worse than one that is silent. */
  readonly from: EndpointRef;
  readonly to: EndpointRef;
}

export interface EdgeEndpointLegality {
  readonly from: readonly EndpointRefKind[];
  readonly to: readonly EndpointRefKind[];
}

/** G4-CM15 — the endpoint types legal for each kind are fixed. A `depends_on` edge whose `from` is
 * an attempt is `composite_manifest_invalid`, not a lenient read. */
export const EDGE_ENDPOINT_LEGALITY: Readonly<Record<AttemptEdgeKind, EdgeEndpointLegality>> =
  Object.freeze({
    spawn: { from: ['attempt'], to: ['attempt'] },
    decompose: { from: ['attempt'], to: ['task'] },
    depends_on: { from: ['task'], to: ['task'] },
    dispatch: { from: ['task'], to: ['attempt'] },
    proposal: { from: ['attempt'], to: ['proposal'] },
    seal: { from: ['proposal'], to: ['outcome'] },
    delivery: { from: ['outcome'], to: ['attempt'] },
    verdict: { from: ['attempt'], to: ['attempt'] },
    rework: { from: ['attempt'], to: ['attempt'] },
    supersede: { from: ['attempt'], to: ['attempt'] },
    rotation: { from: ['attempt'], to: ['attempt'] },
    question: { from: ['attempt'], to: ['attempt', 'direct-parent'] },
    answer: { from: ['attempt', 'direct-parent'], to: ['attempt'] },
  });

/**
 * All four members always present (G4-CM2). The shipped `TokenCounts` declares `cache_read` and
 * `cache_creation` optional (`manifest-contract.ts:26`, `:27`); on the wire an absent counter is
 * `null`, so two manifests of one trial can never differ by key PRESENCE and a validator never has
 * to distinguish "absent" from "null".
 */
export interface AttemptTokenCounts {
  readonly input: number | null;
  readonly output: number | null;
  readonly cache_read: number | null;
  readonly cache_creation: number | null;
}

/**
 * §9.1's record (`design:2571-2603`), 39 members. Every key is ALWAYS PRESENT; `| null` marks a
 * member whose VALUE may be null, never an optional key (G4-CM2).
 */
export interface AttemptRecord {
  // identity
  readonly trial_id: string;
  readonly root_run_id: string;
  readonly task_id: string;
  readonly parent_task_id: string | null;
  /**
   * Widened against §9.1's non-nullable declaration (finding G4-N13, decision D-NULL3). Two
   * grounds, and the second is the decisive one: the shipped source type is ALREADY nullable
   * (`core/task-parser.ts:35` declares `dispatch_generation: string | null`), and the benchmark
   * path never claims at all — `benchmark-local-thread-orchestrator.ts` references no dispatcher
   * and creates its threads with `createThread(...)` at `:389`. So this is null for EVERY attempt
   * on this path, parent and thread alike. Re-using `root_run_id` here would fabricate a
   * distinction the data does not contain; `null` means UNDERIVABLE, never `""`.
   */
  readonly dispatch_generation: string | null;
  readonly attempt_id: string;
  readonly attempt_ordinal: number;
  // ancestry
  /** `null` for the parent attempt — `runner.ts:726` writes `threadId: null` into the header. This
   * is the PARENT-ATTEMPT PREDICATE the G4-N14 biconditional below is scoped by. */
  readonly thread_id: string | null;
  /** Finding G4-N16: no benchmark writer produces `metadata.parentThreadId`. `registerChildSpawn`
   * (`tree.ts:130-136`) writes `childThreadIds` (`:133`) and `waitingOn` (`:134`) ONLY — the
   * `parentThreadId` at `:130` is its parameter, a name collision. Already nullable, so the shape
   * survives; the linkage repair is deferred. */
  readonly parent_thread_id: string | null;
  /**
   * Widened under the G4-N14 biconditional (decision D-NULL3), NOT unconditionally: for a thread
   * attempt this IS derivable, so a bare `| null` would let a thread attempt lose real data and
   * still pass schema. See `THREAD_SCOPED_IDENTITY_FIELDS`.
   *
   * Finding G4-N15: (17.1.4) row 10 sources this as `metadata.rootThreadId`, which is undefined
   * for every benchmark thread — its only production writer is off the benchmark path, and
   * `createBenchmarkRecord` writes `metadata: { trigger: 'benchmark-local' }`. The shipped
   * derivation is the accessor `getRootThreadId` (`tree.ts:26-27`), whose `?? t.id` fallback is
   * correct only at depth 1; a producer at depth ≥ 2 must establish the root from the trial scope
   * instead of trusting the fallback.
   */
  readonly root_thread_id: string | null;
  /** Ordered root-first; the node's own `task_id` is the last element. */
  readonly task_ancestry: readonly string[];
  // execution shape
  /** Widened under the same G4-N14 biconditional as `root_thread_id`. Derivable for a thread
   * attempt (`createBenchmarkRecord` passes `templateName: request.template` at `:390`); absent for
   * the parent process, which has no `ThreadRecord`. */
  readonly template: string | null;
  /** G4-AI8: the fragment's ENTRY role, verbatim the journal header's `agentSlot`, never its
   * terminal one — which is what makes the equality mechanically assertable. */
  readonly role: AgentSlot;
  readonly stage: string | null;
  // model identity
  readonly backend: Backend;
  readonly provider: string | null;
  readonly requested_model: string;
  /** Never defaulted to `requested_model`: that would be synthesized data labelled native, which
   * §9.6 A5 forbids. */
  readonly reported_model: string | null;
  // The OBSERVED scalars for THIS attempt's role — a different quantity from the manifest's
  // role-indexed frozen expectation, which is copied from the policy and never recomputed (G4-CM9).
  readonly model_execution_identity_hash: string;
  readonly role_tool_surface_hash: string;
  readonly bundle_manifest_hash: string;
  // outcome
  readonly terminal_state: TerminalState;
  readonly terminal_reason: TerminalReason;
  readonly disposition: AttemptDisposition;
  /** Non-null iff `disposition === 'superseded'`, and it must resolve to a node (D-10). */
  readonly superseded_by: string | null;
  // evidence
  /** Root-relative, never absolute — the shipped manifest contract is relocatable by construction. */
  readonly artifact_path: string | null;
  readonly artifact_sha256: string | null;
  readonly journal_path: string;
  readonly journal_sha256: string;
  readonly event_count: number;
  readonly terminal_manifest_path: string;
  /** NEW: §9.1 records the terminal manifest as "written and re-validated but never hashed today".
   * The hash is taken over the PUBLISHED bytes, after the rename, never over the pre-publication
   * buffer. */
  readonly terminal_manifest_sha256: string;
  // edges (§9.2)
  /** G4-CM18: exactly the subsequence of the top-level `edges` whose `from` is this attempt, in the
   * same relative order. The top-level array is authoritative. */
  readonly edges: readonly AttemptEdge[];
  // usage and time
  readonly started_at: string;
  readonly ended_at: string;
  /** `null` means UNDERIVABLE, never zero (§9.6 A5). */
  readonly steps: number | null;
  /** `null` means UNDERIVABLE, never zero. A JSON number as §9.1 declares it; the decimal-string
   * conversion R-A5-3 requires happens at the `accounting` boundary and is Gate 8's, not the
   * node's (G4-N3). */
  readonly cost_usd: number | null;
  readonly tokens: AttemptTokenCounts;
  /** Widened to nullable against §9.1's non-nullable declaration (finding G4-N4): no shipped
   * mechanism produces a per-attempt value at this pin — the proxy meters by `source_ip` with no
   * caller identity and the merge accumulator has no request counter. Writing `0` is FORBIDDEN;
   * it is the §9.6 A5 violation one level down from (17.6). */
  readonly provider_requests: number | null;
}

/**
 * §9.1's declaration order, which G4-CM1 makes a validated property of the wire form rather than a
 * serialisation style. The `keyof` element type closes it in one direction (no key that is not a
 * member) and `AttemptRecordKeysAreExhaustive` closes it in the other (no member left out), so the
 * list cannot silently drift from the interface.
 */
export const ATTEMPT_RECORD_KEYS = [
  'trial_id', 'root_run_id', 'task_id', 'parent_task_id', 'dispatch_generation',
  'attempt_id', 'attempt_ordinal',
  'thread_id', 'parent_thread_id', 'root_thread_id', 'task_ancestry',
  'template', 'role', 'stage',
  'backend', 'provider', 'requested_model', 'reported_model',
  'model_execution_identity_hash', 'role_tool_surface_hash', 'bundle_manifest_hash',
  'terminal_state', 'terminal_reason', 'disposition', 'superseded_by',
  'artifact_path', 'artifact_sha256', 'journal_path', 'journal_sha256', 'event_count',
  'terminal_manifest_path', 'terminal_manifest_sha256',
  'edges',
  'started_at', 'ended_at', 'steps', 'cost_usd', 'tokens', 'provider_requests',
] as const satisfies readonly (keyof AttemptRecord)[];

type MissingAttemptRecordKeys = Exclude<keyof AttemptRecord, typeof ATTEMPT_RECORD_KEYS[number]>;
/** Compile-time exhaustiveness: adding a member to `AttemptRecord` without adding it to
 * `ATTEMPT_RECORD_KEYS` makes this alias `never`-violating and fails `tsc`. */
export type AttemptRecordKeysAreExhaustive = MissingAttemptRecordKeys extends never ? true : never;
const _attemptRecordKeysAreExhaustive: AttemptRecordKeysAreExhaustive = true;
void _attemptRecordKeysAreExhaustive;

/** The shipped lifecycle identifier grammar (`manifest.ts:254`), which `assertPathIdentifier`
 * (`:256`) applies before a stem is built. Restated here rather than imported because
 * `lifecycleStem` is not exported and §10's Gate-4 grant does not cover exporting it; the equality
 * with the shipped writer's output is asserted by test instead. */
const LIFECYCLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class AttemptIdentityError extends Error {
  constructor(detail: string) {
    super(`attempt identity invalid: ${detail}`);
    this.name = 'AttemptIdentityError';
  }
}

/**
 * G4-AI2 — the id is DERIVED from shipped identifiers, never randomly minted, and the BARE STEM is
 * the whole rule: there is no `#<step>` suffix in any mode (the Branch A clause is struck by the
 * (17.3.1) ruling).
 *
 * G4-AI6 — why derived and not `randomUUID()`: `dispatch_generation` is a randomUUID because its
 * job is to be a FENCE. `attempt_id` has the opposite job — it is a KEY and must be
 * encoder-independent, so that two encoders reading the same trajectory root produce the same id.
 * That is exactly what F8's publish-then-re-read-and-re-hash check needs (G4-CM5); a randomly
 * minted key would make the re-read hash depend on which process wrote it.
 *
 * G4-AI3 — uniqueness scope is the TRIAL, by construction: a `rootRunId` is unique per agent-run
 * process and a `threadId` per thread, so no two attempts of one trial derive the same string. The
 * validator still asserts it, because a construction argument that is never checked is a comment.
 */
export function mintAttemptId(rootRunId: string, threadId: string | null): string {
  const id = threadId ?? rootRunId;
  if (!LIFECYCLE_ID_PATTERN.test(id)) {
    throw new AttemptIdentityError('id must match the lifecycle identifier grammar');
  }
  return `${threadId === null ? 'run' : 'thread'}-${id}`;
}

/**
 * G4-N14 / D-NULL3 — the thread-scoped identity fields. Each is derivable exactly when the attempt
 * IS a thread, so their nullability is a BICONDITIONAL rather than a bare widening:
 *
 *   `thread_id === null`  ⟺  `root_thread_id === null`  ⟺  `template === null`
 *
 * A thread attempt carrying `null` in either field has silently lost real data; a parent attempt
 * carrying non-null in either has fabricated it. Both directions are refused.
 */
export const THREAD_SCOPED_IDENTITY_FIELDS = ['root_thread_id', 'template'] as const;

export function threadScopedIdentityHolds(node: Pick<
  AttemptRecord, 'thread_id' | 'root_thread_id' | 'template'
>): boolean {
  const isParent = node.thread_id === null;
  return THREAD_SCOPED_IDENTITY_FIELDS.every(field => (node[field] === null) === isParent);
}

export interface AttemptOrdinalInput {
  readonly attempt_id: string;
  readonly task_id: string;
  readonly started_at: string;
}

/**
 * G4-AI4 — `attempt_ordinal` is the 1-BASED index of an attempt among those sharing its `task_id`,
 * ordered by `started_at` ascending with ties broken by `attempt_id` ascending. The scope is the
 * TASK, not the trial and not the thread, because §9.2's `rework` edge is "rejected verdict → next
 * attempt of the SAME TASK" — the ordinal is exactly what "next" counts. There is no ordinal 0
 * anywhere, so a reader never has to ask which base a given manifest used.
 *
 * G4-AI5 — ordinals are never re-used and never re-numbered. Ordering by `started_at` makes the
 * ordinal a function of the trial's HISTORY, not of its final state: a superseded attempt keeps its
 * ordinal and the replacement takes the next. Re-numbering would make §9.2's node sort differ
 * between an in-flight and a published manifest.
 */
export function assignAttemptOrdinals(
  attempts: readonly AttemptOrdinalInput[],
): ReadonlyMap<string, number> {
  const byTask = new Map<string, AttemptOrdinalInput[]>();
  for (const attempt of attempts) {
    const bucket = byTask.get(attempt.task_id);
    if (bucket) bucket.push(attempt);
    else byTask.set(attempt.task_id, [attempt]);
  }
  const ordinals = new Map<string, number>();
  for (const bucket of byTask.values()) {
    const ordered = [...bucket].sort((left, right) => (
      left.started_at < right.started_at ? -1
        : left.started_at > right.started_at ? 1
          : left.attempt_id < right.attempt_id ? -1
            : left.attempt_id > right.attempt_id ? 1 : 0
    ));
    ordered.forEach((attempt, index) => ordinals.set(attempt.attempt_id, index + 1));
  }
  return ordinals;
}
