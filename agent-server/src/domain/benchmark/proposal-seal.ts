// input:  an actor's proposal intent and the four seal preconditions' operands, as data
// output: the seal decision, the persisted per-attempt proposal store and its two edge kinds
// pos:    §8.6's proposal → seal state machine and its persistence (G4-SM1)
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { readFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { managerNodeDir } from '@core/task-node.js';
import { atomicWriteSync } from '@core/atomic-write.js';
import type { ThreadStatus } from '@core/types/thread-types.js';
import type { SupervisorEvidence } from '../agent-run/manifest-contract.js';
import type { AttemptEdge } from './attempt-record.js';
import {
  BENCHMARK_FAILURES, type BenchmarkFailureClass, type BenchmarkFailureReason,
} from './resolved-policy.js';

/**
 * G4-SM1 — both halves live here, on `workspace-lease.ts`'s precedent: a state machine and its
 * persistence are one concept, and splitting them would need a third module to hold the state enum
 * both import. The evaluator is the DECISION (G4-SM2); the coordinator that calls it is Gate 6's
 * and is not specified here.
 */

// ── §8.6's states ───────────────────────────────────────────────────────────

/**
 * §8.6's state table has FOUR states, but `none` is the ABSENCE of a row (`design:2492`), so the
 * persisted union is these three. A row is never deleted (G4-SM5), so `none` is only ever the state
 * of a key that has not proposed.
 */
export const PROPOSAL_STATES = ['proposed', 'sealed', 'invalidated'] as const;
export type ProposalState = typeof PROPOSAL_STATES[number];

export const SEAL_PRECONDITIONS = ['S1', 'S2', 'S3', 'S4'] as const;
export type SealPrecondition = typeof SEAL_PRECONDITIONS[number];

/** V4 is NOT a member: it is the recording requirement, not a cause (`design:8200`). */
export const INVALIDATION_RULES = ['V1', 'V2', 'V3'] as const;
export type InvalidationRule = typeof INVALIDATION_RULES[number];

export type ProposalIntentKind = 'complete' | 'block';

/** The terminal an attempt may settle on: `manifest-contract.ts:12`'s `TerminalState` plus the
 *  thread machine's `aborted` (`tree.ts:9`), which V1 names but no manifest state carries. */
export type AttemptTerminal = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'aborted';

/** V1's set, verbatim from §8.6 (`design:2515`). `completed` is not a member. */
const INVALIDATING_TERMINALS: ReadonlySet<string> = new Set(['failed', 'cancelled', 'timeout', 'aborted']);

/**
 * `tree.ts:9`'s terminal thread statuses and `manifest-contract.ts:12`'s `TerminalState`, restated
 * because neither ships as a runtime array. A restatement that is never checked is a comment, so
 * the test asserts the first against `isTerminalStatus` over every `ThreadStatus` member and the
 * second against `terminalManifestProblem`'s own verdict.
 */
const TERMINAL_THREAD_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'aborted']);
const TERMINAL_MANIFEST_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'timeout']);

/**
 * The shipped lifecycle timestamp grammar, restated for the same reason: it exists as three private
 * copies (`manifest-contract.ts:9`, `manifest.ts:21`, `supervisor.ts:13`) and none is exported.
 * (17.2.3) types both row timestamps as this pattern, so the fail-closed reader enforces the
 * pattern rather than merely `typeof === 'string'` — a store carrying an unparseable
 * `settled_at` is a corrupt store, and reading it leniently is the fail-open this module exists
 * not to copy. The test asserts the restatement against the shipped validator's own verdict.
 */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ── G4-SM2 the seal evaluator ───────────────────────────────────────────────

/**
 * The four preconditions' operands, taken AS DATA: this function reads no disk, no store and no
 * clock. §4.5's F1–F6 produce them at four different points (S3's journal closure is F4, S4's
 * lifecycle validation needs the terminal manifest of F6), and a function that fetched its own
 * operands would re-order finalization, which §9.5 forbids.
 */
export interface SealOperands {
  /** S1a — the owning attempt's thread status. */
  readonly threadStatus: ThreadStatus;
  /** S1b — the terminal manifest's `state`. */
  readonly terminalManifestState: string;
  /** S2 — the supervisor evidence the manifest carries; `null` when the manifest carries none. */
  readonly supervisor: SupervisorEvidence | null;
  /** S3 — every authoritative store for this attempt flushed (§4.5 F3). */
  readonly storesFlushed: boolean;
  /** S3 — and its journal closed (§4.5 F4). */
  readonly journalClosed: boolean;
  /** S4 — `validateTrajectoryLifecycle`'s verdict for the attempt. */
  readonly trajectoryLifecycle: { readonly ok: boolean };
}

export type SealEvaluation =
  | { readonly sealed: true }
  | { readonly sealed: false; readonly unmet: readonly SealPrecondition[] };

/** The failing preconditions, in S1..S4 order. Empty iff the seal holds. */
function unmetPreconditions(operands: SealOperands): readonly SealPrecondition[] {
  const unmet: SealPrecondition[] = [];
  if (!TERMINAL_THREAD_STATUSES.has(operands.threadStatus)
    || !TERMINAL_MANIFEST_STATES.has(operands.terminalManifestState)) {
    unmet.push('S1');
  }
  if (operands.supervisor === null
    || !operands.supervisor.quiescent || operands.supervisor.descendants !== 0) {
    unmet.push('S2');
  }
  if (!operands.storesFlushed || !operands.journalClosed) unmet.push('S3');
  if (!operands.trajectoryLifecycle.ok) unmet.push('S4');
  return Object.freeze(unmet);
}

/** Only S1∧S2∧S3∧S4 seals. `unmet` names exactly the failing preconditions. */
export function evaluateSeal(operands: SealOperands): SealEvaluation {
  const unmet = unmetPreconditions(operands);
  return unmet.length === 0 ? { sealed: true } : { sealed: false, unmet };
}

// ── (17.2.3) the persisted row ──────────────────────────────────────────────

/**
 * TEN fields. (17.2.3)'s table has seven ROWS — its first names three fields and its last names two
 * — so an interface built by counting rows ships seven members and drops the key it is keyed by.
 * Declaration order is the wire order.
 */
export const PROPOSAL_ROW_KEYS = [
  'task_id', 'dispatch_generation', 'attempt_id', 'intent', 'note',
  'state', 'unmet', 'invalidated_by', 'proposed_at', 'settled_at',
] as const;

export interface ProposalRow {
  readonly task_id: string;
  readonly dispatch_generation: string;
  readonly attempt_id: string;
  readonly intent: ProposalIntentKind;
  /** The actor's note, carried OPAQUELY and never parsed (G4-SM7). */
  readonly note: string | null;
  readonly state: ProposalState;
  /** Empty when `sealed`, the failing preconditions otherwise — so an invalidation CARRIES the last
   *  refused seal's findings rather than erasing them. Empty on a row no seal was ever attempted
   *  for, because then no precondition ever failed. */
  readonly unmet: readonly SealPrecondition[];
  /** `null` while `proposed` or `sealed`. */
  readonly invalidated_by: InvalidationRule | null;
  readonly proposed_at: string;
  /** Non-null iff `state !== 'proposed'`. */
  readonly settled_at: string | null;
}

type MissingProposalRowKeys = Exclude<keyof ProposalRow, typeof PROPOSAL_ROW_KEYS[number]>;
/** Compile-time exhaustiveness: a member added without a key fails `tsc`. */
export type ProposalRowKeysAreExhaustive = MissingProposalRowKeys extends never ? true : never;
const _proposalRowKeysAreExhaustive: ProposalRowKeysAreExhaustive = true;
void _proposalRowKeysAreExhaustive;

export interface ProposalKey {
  readonly task_id: string;
  readonly dispatch_generation: string;
  readonly attempt_id: string;
}

export interface ProposalStoreFile {
  readonly task_id: string;
  readonly project: string;
  /** Append-only, in the order the attempts proposed (G4-SM5). */
  readonly proposals: readonly ProposalRow[];
}

export interface ProposalInput {
  readonly key: ProposalKey;
  readonly intent: ProposalIntentKind;
  readonly note: string | null;
}

/** What the seal makes eligible for delivery. The ledger, not this, governs the delivery count. */
export interface SealedOutcome {
  readonly task_id: string;
  readonly dispatch_generation: string;
  readonly attempt_id: string;
  readonly intent: ProposalIntentKind;
  readonly note: string | null;
}

// ── failures ────────────────────────────────────────────────────────────────

export type ProposalSealErrorDetail =
  | 'store_unreadable' | 'proposal_invalidated' | 'proposal_absent' | 'proposal_already_sealed';

/** Only the two details that ride a §8.7 code have one. NO new code is allocated (17.0). */
const DETAIL_REASON: Readonly<Record<ProposalSealErrorDetail, BenchmarkFailureReason | null>> =
  Object.freeze({
    store_unreadable: 'ledger_unreadable',
    proposal_invalidated: 'proposal_invalidated',
    proposal_absent: null,
    proposal_already_sealed: null,
  });

function failureByReason(reason: BenchmarkFailureReason) {
  const failure = BENCHMARK_FAILURES.find(candidate => candidate.reason === reason);
  if (!failure) throw new Error(`Unknown benchmark failure reason: ${reason}`);
  return failure;
}

export class ProposalSealError extends Error {
  readonly reason: BenchmarkFailureReason | null;
  readonly code: number | null;
  readonly failureClass: BenchmarkFailureClass | null;

  constructor(readonly detail: ProposalSealErrorDetail, message: string) {
    super(`${detail}: ${message}`);
    this.name = 'ProposalSealError';
    const reason = DETAIL_REASON[detail];
    const failure = reason === null ? null : failureByReason(reason);
    this.reason = reason;
    this.code = failure?.code ?? null;
    this.failureClass = failure?.failureClass ?? null;
  }
}

// ── G4-SM3 persistence ──────────────────────────────────────────────────────

/** The acceptance ledger's directory and atomic write, a DIFFERENT file: one file may not be
 *  authoritative for two state machines with different owners. */
export function proposalStorePath(project: string, taskId: string): string {
  return path.join(managerNodeDir(project, taskId), 'proposals.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'row';
  const keys = Object.keys(value);
  if (keys.length !== PROPOSAL_ROW_KEYS.length
    || !PROPOSAL_ROW_KEYS.every((key, index) => keys[index] === key)) return 'row_keys';
  for (const key of ['task_id', 'dispatch_generation', 'attempt_id'] as const) {
    if (typeof value[key] !== 'string') return key;
  }
  if (typeof value.proposed_at !== 'string' || !TIMESTAMP_PATTERN.test(value.proposed_at)) {
    return 'proposed_at';
  }
  if (value.intent !== 'complete' && value.intent !== 'block') return 'intent';
  if (value.note !== null && typeof value.note !== 'string') return 'note';
  if (!(PROPOSAL_STATES as readonly unknown[]).includes(value.state)) return 'state';
  if (!Array.isArray(value.unmet)
    || !value.unmet.every(entry => (SEAL_PRECONDITIONS as readonly unknown[]).includes(entry))) {
    return 'unmet';
  }
  if (value.invalidated_by !== null
    && !(INVALIDATION_RULES as readonly unknown[]).includes(value.invalidated_by)) {
    return 'invalidated_by';
  }
  if (value.settled_at !== null
    && (typeof value.settled_at !== 'string' || !TIMESTAMP_PATTERN.test(value.settled_at))) {
    return 'settled_at';
  }
  if ((value.settled_at !== null) !== (value.state !== 'proposed')) return 'settled_at_state';
  return null;
}

/**
 * G4-SM4 — the store fails CLOSED. `readLedger` (`acceptance-ledger.ts:40`) degrades to an empty
 * ledger on any read or parse error; this raises the shipped code 42 instead, because a store that
 * cannot be read makes a successful seal's bookkeeping unverifiable. A MISSING file is not a read
 * error: it is §8.6's `none`, the state of a task that has not proposed yet.
 */
export function readProposalStore(project: string, taskId: string): ProposalStoreFile {
  const target = proposalStorePath(project, taskId);
  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { task_id: taskId, project, proposals: [] };
    }
    throw new ProposalSealError('store_unreadable', `${target}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProposalSealError('store_unreadable', `${target}: ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.proposals)) {
    throw new ProposalSealError('store_unreadable', `${target}: proposals is not an array`);
  }
  for (const row of parsed.proposals) {
    const problem = rowProblem(row);
    if (problem !== null) {
      throw new ProposalSealError('store_unreadable', `${target}: invalid row (${problem})`);
    }
  }
  return { task_id: taskId, project, proposals: parsed.proposals as readonly ProposalRow[] };
}

function writeProposalStore(store: ProposalStoreFile): void {
  const target = proposalStorePath(store.project, store.task_id);
  mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteSync(target, JSON.stringify(store, null, 2));
}

/** Built key-by-key in `PROPOSAL_ROW_KEYS` order so the wire form cannot drift from the table. */
function buildRow(fields: ProposalRow): ProposalRow {
  return Object.freeze({
    task_id: fields.task_id,
    dispatch_generation: fields.dispatch_generation,
    attempt_id: fields.attempt_id,
    intent: fields.intent,
    note: fields.note,
    state: fields.state,
    unmet: Object.freeze([...fields.unmet]),
    invalidated_by: fields.invalidated_by,
    proposed_at: fields.proposed_at,
    settled_at: fields.settled_at,
  });
}

function sameKey(row: ProposalRow, key: ProposalKey): boolean {
  return row.task_id === key.task_id
    && row.dispatch_generation === key.dispatch_generation
    && row.attempt_id === key.attempt_id;
}

function now(): string {
  return new Date().toISOString();
}

function replaced(
  store: ProposalStoreFile, index: number, row: ProposalRow,
): ProposalRow {
  const proposals = [...store.proposals];
  proposals[index] = row;
  writeProposalStore({ task_id: store.task_id, project: store.project, proposals });
  return row;
}

// ── the machine ─────────────────────────────────────────────────────────────

/**
 * Records the actor's intent against ONE attempt (D-9). The task's authoritative status is not
 * touched: §8.6's `proposed` leaves it unchanged, so the model never sees its own proposal as a
 * result. Re-proposing on a live attempt transitions the same row — a row is never appended twice
 * for one `attempt_id` (G4-SM5).
 */
export function recordProposal(project: string, input: ProposalInput): ProposalRow {
  const store = readProposalStore(project, input.key.task_id);
  const index = store.proposals.findIndex(row => sameKey(row, input.key));
  if (index >= 0) {
    const existing = store.proposals[index];
    if (existing.state === 'invalidated') {
      throw new ProposalSealError('proposal_invalidated', `${input.key.attempt_id} is invalidated`);
    }
    if (existing.state === 'sealed') {
      throw new ProposalSealError('proposal_already_sealed', `${input.key.attempt_id} is sealed`);
    }
    return replaced(store, index, buildRow({
      ...existing, intent: input.intent, note: input.note,
    }));
  }
  const row = buildRow({
    task_id: input.key.task_id,
    dispatch_generation: input.key.dispatch_generation,
    attempt_id: input.key.attempt_id,
    intent: input.intent,
    note: input.note,
    state: 'proposed',
    unmet: [],
    invalidated_by: null,
    proposed_at: now(),
    settled_at: null,
  });
  writeProposalStore({
    task_id: store.task_id, project, proposals: [...store.proposals, row],
  });
  return row;
}

/**
 * Evaluates the seal for one proposal and writes the transition. A refused seal leaves the row
 * `proposed` and records which preconditions failed; only S1∧S2∧S3∧S4 seals.
 *
 * V2 fires FIRST and on sight: a proposal whose `attempt_id` is no longer the task's current
 * attempt is invalidated even if S1–S4 would otherwise hold (D-9).
 */
export function attemptSeal(
  project: string,
  key: ProposalKey,
  input: { readonly currentAttemptId: string; readonly operands: SealOperands },
): ProposalRow {
  const store = readProposalStore(project, key.task_id);
  const index = store.proposals.findIndex(row => sameKey(row, key));
  if (index < 0) {
    throw new ProposalSealError('proposal_absent', `${key.attempt_id} never proposed`);
  }
  const row = store.proposals[index];
  if (row.state === 'invalidated') {
    throw new ProposalSealError('proposal_invalidated', `${key.attempt_id} invalidated by ${row.invalidated_by}`);
  }
  if (row.state === 'sealed') return row;
  if (key.attempt_id !== input.currentAttemptId) {
    return replaced(store, index, buildRow({
      ...row, state: 'invalidated', invalidated_by: 'V2', settled_at: now(),
    }));
  }
  const unmet = unmetPreconditions(input.operands);
  if (unmet.length > 0) {
    return replaced(store, index, buildRow({ ...row, unmet }));
  }
  return replaced(store, index, buildRow({
    ...row, state: 'sealed', unmet: [], invalidated_by: null, settled_at: now(),
  }));
}

/**
 * V4 — invalidation is a transition written ONTO the existing row, never a deletion, so the store's
 * row count over a trial equals the number of attempts that ever proposed (G4-SM5). Only an
 * outstanding (`proposed`) row is invalidated: §8.6's diagram has no `sealed → invalidated` edge
 * (`design:2474-2486`), and re-opening a sealed outcome would contradict a delivery that may
 * already have happened.
 */
function invalidateWhere(
  project: string,
  taskId: string,
  match: (row: ProposalRow) => boolean,
  rule: InvalidationRule,
): readonly ProposalRow[] {
  const store = readProposalStore(project, taskId);
  const settledAt = now();
  const invalidated: ProposalRow[] = [];
  const proposals = store.proposals.map(row => {
    if (row.state !== 'proposed' || !match(row)) return row;
    const next = buildRow({
      ...row, state: 'invalidated', invalidated_by: rule, settled_at: settledAt,
    });
    invalidated.push(next);
    return next;
  });
  if (invalidated.length > 0) {
    writeProposalStore({ task_id: store.task_id, project, proposals });
  }
  return invalidated;
}

/**
 * V1 — an attempt terminalising `failed`, `cancelled`, `timeout` or `aborted` invalidates every
 * proposal it recorded. This is load-bearing precisely because S1 admits those terminals: a failed
 * attempt can satisfy S1∧S2∧S3∧S4, and only V1 stops it sealing.
 */
export function applyAttemptTerminal(
  project: string, taskId: string, attemptId: string, terminal: AttemptTerminal,
): readonly ProposalRow[] {
  if (!INVALIDATING_TERMINALS.has(terminal)) return [];
  return invalidateWhere(project, taskId, row => row.attempt_id === attemptId, 'V1');
}

/** V3 — trial cancellation invalidates every outstanding proposal before the F3 flush, so nothing
 *  can seal during finalisation (§4.5 F1 ordering). */
export function cancelTrialProposals(project: string, taskId: string): readonly ProposalRow[] {
  return invalidateWhere(project, taskId, () => true, 'V3');
}

/** §9.4 M-12, as a predicate rather than prose: every proposal is `sealed` or `invalidated`, none
 *  is `proposed`. */
export function outstandingProposals(project: string, taskId: string): readonly ProposalRow[] {
  return readProposalStore(project, taskId).proposals.filter(row => row.state === 'proposed');
}

/**
 * The seal is the single point at which an outcome becomes ELIGIBLE for delivery: `null` for every
 * state but `sealed`. Delivery itself stays at-least-once and is the acceptance ledger's — sealing
 * makes an outcome eligible, it does not make delivery exactly-once.
 */
export function eligibleOutcome(project: string, key: ProposalKey): SealedOutcome | null {
  const row = readProposalStore(project, key.task_id).proposals.find(entry => sameKey(entry, key));
  if (!row || row.state !== 'sealed') return null;
  return Object.freeze({
    task_id: row.task_id,
    dispatch_generation: row.dispatch_generation,
    attempt_id: row.attempt_id,
    intent: row.intent,
    note: row.note,
  });
}

/**
 * G4-SM6 — the store is the authoritative producer of two of §9.2's thirteen edge kinds: a
 * `proposal` edge for every row, a `seal` edge for every row in state `sealed`. The union is
 * CONSUMED, never extended. Endpoint ids are DERIVED from `attempt_id` rather than minted, on
 * G4-AI6's ground: a key must be encoder-independent so two encoders reading one trial agree.
 */
export function proposalStoreEdges(rows: readonly ProposalRow[]): readonly AttemptEdge[] {
  const edges: AttemptEdge[] = [];
  for (const row of rows) {
    edges.push({
      kind: 'proposal',
      from: { ref: 'attempt', id: row.attempt_id },
      to: { ref: 'proposal', id: `proposal-${row.attempt_id}` },
    });
  }
  for (const row of rows) {
    if (row.state !== 'sealed') continue;
    edges.push({
      kind: 'seal',
      from: { ref: 'proposal', id: `proposal-${row.attempt_id}` },
      to: { ref: 'outcome', id: `outcome-${row.attempt_id}` },
    });
  }
  return Object.freeze(edges);
}
