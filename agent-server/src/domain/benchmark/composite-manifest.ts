// input:  attempt records, authoritative edges, the frozen policy identity and Gate 8's accounting
// output: the canonical cortex-bench-composite-manifest/1 document, its refusals and its publication
// pos:    Composite manifest encoding, structural validation and atomic publication
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  ATTEMPT_EDGE_KINDS, ATTEMPT_RECORD_KEYS, EDGE_ENDPOINT_LEGALITY, threadScopedIdentityHolds,
  type AttemptEdge, type AttemptEdgeKind, type AttemptRecord, type EndpointRef,
  type EndpointRefKind,
} from './attempt-record.js';
import type { AccountingRecord } from './accounting-reconciliation.js';
import {
  BENCHMARK_FAILURES, type BenchmarkFailureClass, type BenchmarkFailureReason,
} from './resolved-policy.js';
import {
  NODE_TRAJECTORY_MERGE_FS, type TrajectoryMergeFileSystem,
} from '../agent-run/trajectory-merge.js';

export type { AttemptEdge, AttemptEdgeKind, AttemptRecord, EndpointRef, EndpointRefKind };
export { ATTEMPT_EDGE_KINDS, EDGE_ENDPOINT_LEGALITY };

export const COMPOSITE_MANIFEST_SCHEMA_VERSION = 'cortex-bench-composite-manifest/1';

export type OrchestrationModeName = 'direct' | 'coder-review' | 'manager';

/** §9.4's shared preconditions, in the evaluation order §9.4 states (`design:2744`). */
export const SHARED_CHECK_IDS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as const;

/** §9.4's per-mode rows, in the order §9.4's mode tables list them (G4-CM19). */
export const MODE_CHECK_IDS: Readonly<Record<OrchestrationModeName, readonly string[]>> =
  Object.freeze({
    direct: Object.freeze(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']),
    'coder-review': Object.freeze(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']),
    manager: Object.freeze([
      'M-1', 'M-2', 'M-3', 'M-4', 'M-5', 'M-6', 'M-7', 'M-8',
      'M-9', 'M-10', 'M-11', 'M-12', 'M-13', 'M-14', 'M-15', 'M-16',
    ]),
  });

export function checkIdsForMode(mode: OrchestrationModeName): readonly string[] {
  return [...SHARED_CHECK_IDS, ...MODE_CHECK_IDS[mode]];
}

export type PredicateCheckResult = 'pass' | 'fail' | 'unavailable';

export interface PredicateCheck {
  readonly check_id: string;
  readonly result: PredicateCheckResult;
  /** G4-CM21: `null` on `pass`, a non-empty string otherwise. */
  readonly detail: string | null;
}

export interface CompositeManifestPredicate {
  readonly mode: OrchestrationModeName;
  readonly checks: readonly PredicateCheck[];
}

/**
 * G4-CM7/CM8 — the two maps are byte-for-byte the frozen policy's own objects, COPIED and never
 * recomputed: recomputing would make the manifest a second authority on identity, and §1.4 is the
 * only one. Their key order is the policy's own, carried verbatim and never re-sorted.
 */
export interface CompositeManifestIdentity {
  readonly model_execution_identity_hash: Readonly<Record<string, string>>;
  readonly role_tool_surface_hash: Readonly<Record<string, string>>;
  readonly bundle_manifest_hash: string;
}

export interface CompositeManifestRoots {
  readonly parent_attempt_id: string;
  /** `null` exactly in the taskless modes of G4-CM11 — the ONE place the taskless shape is visible. */
  readonly root_task_id: string | null;
}

/** Eleven members (§17 17.1.2, count ruled by enumerating the construct). */
export interface CompositeManifest {
  readonly schema_version: typeof COMPOSITE_MANIFEST_SCHEMA_VERSION;
  readonly trial_id: string;
  readonly root_run_id: string;
  readonly arm_name: string;
  readonly arm_canonical_sha256: string;
  readonly identity: CompositeManifestIdentity;
  /** May not be empty: a trial with no attempt has no manifest to publish. */
  readonly nodes: readonly AttemptRecord[];
  /** May be empty: mode `direct` has zero edges by §9.4 D2. */
  readonly edges: readonly AttemptEdge[];
  readonly roots: CompositeManifestRoots;
  /** Gate 8's record, VERBATIM (O-G4-ACCT). Gate 8 delivers the value; Gate 4 delivers the carrier. */
  readonly accounting: AccountingRecord;
  readonly predicate: CompositeManifestPredicate;
}

/**
 * G4-CM1 — member order is fixed by declaration order, not by lexicographic sort. Order is a
 * VALIDATED property rather than a degree of freedom a canonicaliser normalises away.
 */
export const COMPOSITE_MANIFEST_KEYS = [
  'schema_version', 'trial_id', 'root_run_id', 'arm_name', 'arm_canonical_sha256',
  'identity', 'nodes', 'edges', 'roots', 'accounting', 'predicate',
] as const satisfies readonly (keyof CompositeManifest)[];

type MissingManifestKeys = Exclude<keyof CompositeManifest, typeof COMPOSITE_MANIFEST_KEYS[number]>;
export type CompositeManifestKeysAreExhaustive = MissingManifestKeys extends never ? true : never;
const _manifestKeysAreExhaustive: CompositeManifestKeysAreExhaustive = true;
void _manifestKeysAreExhaustive;

/**
 * One named code per refusal. Every code rides an EXISTING §2.6 failure: the invariant-4 pair rides
 * 39 `attempt_unaccounted`, everything else rides 40 `composite_manifest_invalid`. §17 (17.0)
 * allocates no new failure code.
 */
export const COMPOSITE_MANIFEST_VIOLATION_CODES = [
  // document closure
  'schema_version_invalid', 'unknown_top_level_member', 'top_level_member_missing',
  'member_order_invalid', 'nodes_empty',
  // §9.2 invariant 1
  'attempt_id_not_unique', 'edge_endpoint_unresolved', 'edge_endpoint_type_invalid',
  // §9.2 invariant 2
  'attempt_dag_cycle', 'attempt_dag_unrooted',
  // §9.2 invariant 3
  'task_depth_exceeded', 'task_count_exceeded',
  // §9.2 invariant 4 (biconditional)
  'attempt_missing_lifecycle_pair', 'lifecycle_pair_missing_attempt',
  // canonical order and projection
  'nodes_out_of_order', 'edges_out_of_order', 'edge_duplicated', 'node_edge_projection_mismatch',
  // roots and trial coherence
  'roots_parent_attempt_invalid', 'node_trial_id_mismatch', 'accounting_trial_id_mismatch',
  'accounting_shape_invalid',
  // node-level
  'attempt_ordinal_invalid', 'superseded_by_unresolved', 'task_ancestry_invalid',
  'thread_scoped_identity_invalid',
  // predicate
  'predicate_checks_incomplete', 'predicate_checks_out_of_order', 'predicate_check_detail_invalid',
] as const;
export type CompositeManifestViolationCode = typeof COMPOSITE_MANIFEST_VIOLATION_CODES[number];

const UNACCOUNTED_CODES = new Set<CompositeManifestViolationCode>([
  'attempt_missing_lifecycle_pair', 'lifecycle_pair_missing_attempt',
]);

function failureCode(reason: BenchmarkFailureReason): number {
  const failure = BENCHMARK_FAILURES.find(candidate => candidate.reason === reason);
  if (!failure) throw new Error(`Unknown benchmark failure reason: ${reason}`);
  return failure.code;
}

export interface CompositeManifestViolation {
  readonly code: CompositeManifestViolationCode;
  /** The shipped §2.6 code this refusal rides. Never a newly allocated one. */
  readonly failure_code: number;
  readonly detail: string;
}

export class CompositeManifestError extends Error {
  readonly code: number;
  readonly failureClass: BenchmarkFailureClass;

  constructor(
    readonly reason: Extract<
      BenchmarkFailureReason, 'composite_manifest_invalid' | 'attempt_unaccounted'
    > | 'output_path_exists',
    detail: string,
    readonly violations: readonly CompositeManifestViolation[] = [],
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'CompositeManifestError';
    // `output_path_exists` is the merge taxonomy's reason (`trajectory-merge.ts:23`); as a benchmark
    // failure it rides 40, because a manifest that could not be published is an invalid one.
    const rides = reason === 'attempt_unaccounted' ? 'attempt_unaccounted' : 'composite_manifest_invalid';
    const failure = BENCHMARK_FAILURES.find(candidate => candidate.reason === rides)!;
    this.code = failure.code;
    this.failureClass = failure.failureClass;
  }

  record(): Record<string, unknown> {
    return {
      code: this.code,
      failure_class: this.failureClass,
      reason: this.reason,
      violations: this.violations.map(violation => ({
        code: violation.code, failure_code: violation.failure_code, detail: violation.detail,
      })),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Endpoint algebra
// ---------------------------------------------------------------------------------------------

function endpointId(ref: EndpointRef): string {
  // G4-CM17 sorts `{"ref":"direct-parent"}` as `id = ""`, which is also its vertex key.
  return ref.ref === 'direct-parent' ? '' : ref.id;
}

function endpointKey(ref: EndpointRef): string {
  return `${ref.ref}\u0000${endpointId(ref)}`;
}

const KIND_ORDINAL: ReadonlyMap<AttemptEdgeKind, number> = new Map(
  ATTEMPT_EDGE_KINDS.map((kind, index) => [kind, index + 1]),
);

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEdges(left: AttemptEdge, right: AttemptEdge): number {
  return (KIND_ORDINAL.get(left.kind)! - KIND_ORDINAL.get(right.kind)!)
    || compareStrings(left.from.ref, right.from.ref)
    || compareStrings(endpointId(left.from), endpointId(right.from))
    || compareStrings(left.to.ref, right.to.ref)
    || compareStrings(endpointId(left.to), endpointId(right.to));
}

/**
 * (17.1.4.1) — `depth(n)` is the number of edges on the SHORTEST path from
 * `roots.parent_attempt_id` to `n` over the `spawn`/`decompose`/`dispatch` subset. Shortest is
 * specified rather than assumed because §9.2 invariant 2 guarantees only that the subset is a DAG
 * rooted there, and a DAG admits several paths. Depth is DERIVED, never a stored field.
 */
const DEPTH_EDGE_KINDS = new Set<AttemptEdgeKind>(['spawn', 'decompose', 'dispatch']);

function attemptDepths(
  edges: readonly AttemptEdge[], parentAttemptId: string,
): ReadonlyMap<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!DEPTH_EDGE_KINDS.has(edge.kind)) continue;
    const from = endpointKey(edge.from);
    const bucket = adjacency.get(from);
    if (bucket) bucket.push(endpointKey(edge.to));
    else adjacency.set(from, [endpointKey(edge.to)]);
  }
  const start = endpointKey({ ref: 'attempt', id: parentAttemptId });
  const depths = new Map<string, number>([[start, 0]]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = depths.get(current)!;
    for (const next of adjacency.get(current) ?? []) {
      if (depths.has(next)) continue;
      depths.set(next, depth + 1);
      queue.push(next);
    }
  }
  const attemptDepth = new Map<string, number>();
  for (const [key, depth] of depths) {
    const [ref, id] = key.split('\u0000');
    if (ref === 'attempt') attemptDepth.set(id, depth);
  }
  return attemptDepth;
}

function hasCycle(edges: readonly AttemptEdge[]): boolean {
  const adjacency = new Map<string, string[]>();
  const vertices = new Set<string>();
  for (const edge of edges) {
    if (!DEPTH_EDGE_KINDS.has(edge.kind)) continue;
    const from = endpointKey(edge.from);
    const to = endpointKey(edge.to);
    vertices.add(from);
    vertices.add(to);
    const bucket = adjacency.get(from);
    if (bucket) bucket.push(to);
    else adjacency.set(from, [to]);
  }
  const state = new Map<string, 'open' | 'closed'>();
  const visit = (vertex: string): boolean => {
    const seen = state.get(vertex);
    if (seen === 'open') return true;
    if (seen === 'closed') return false;
    state.set(vertex, 'open');
    for (const next of adjacency.get(vertex) ?? []) {
      if (visit(next)) return true;
    }
    state.set(vertex, 'closed');
    return false;
  };
  for (const vertex of vertices) {
    if (visit(vertex)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// F7 — build
// ---------------------------------------------------------------------------------------------

export interface BuildCompositeManifestInput {
  readonly trial_id: string;
  readonly root_run_id: string;
  readonly arm_name: string;
  readonly arm_canonical_sha256: string;
  readonly identity: CompositeManifestIdentity;
  readonly nodes: readonly AttemptRecord[];
  readonly edges: readonly AttemptEdge[];
  readonly roots: CompositeManifestRoots;
  readonly accounting: AccountingRecord;
  readonly mode: OrchestrationModeName;
  /**
   * Only the checks actually evaluated. Every §9.4 id NOT supplied here is recorded explicitly
   * UNAVAILABLE — never `pass`. A check that reads `pass` because nobody ran it is the guess
   * §9.6 A5 exists to forbid.
   */
  readonly evaluatedChecks?: Readonly<Record<string, { result: PredicateCheckResult; detail: string | null }>>;
}

const UNEVALUATED_DETAIL = 'not evaluated at this pin';

function buildPredicate(
  mode: OrchestrationModeName,
  evaluated: BuildCompositeManifestInput['evaluatedChecks'],
): CompositeManifestPredicate {
  const checks = checkIdsForMode(mode).map((check_id): PredicateCheck => {
    const supplied = evaluated?.[check_id];
    if (!supplied) return { check_id, result: 'unavailable', detail: UNEVALUATED_DETAIL };
    return { check_id, result: supplied.result, detail: supplied.detail };
  });
  return { mode, checks };
}

/**
 * F7 (§9.5, `design:2814`) — build the attempt DAG and record the per-check results. The two total
 * orders (G4-CM12, G4-CM17) are applied here so that re-encoding the same DAG is byte-stable, and
 * `nodes[i].edges` is derived as the projection G4-CM18 fixes rather than trusted from the caller.
 */
export function buildCompositeManifest(input: BuildCompositeManifestInput): CompositeManifest {
  const edges = [...input.edges].sort(compareEdges);
  const depths = attemptDepths(edges, input.roots.parent_attempt_id);
  const projected = input.nodes.map((node): AttemptRecord => ({
    ...node,
    edges: edges.filter(edge => edge.from.ref === 'attempt' && edge.from.id === node.attempt_id),
  }));
  const nodes = projected.sort((left, right) => (
    (depths.get(left.attempt_id) ?? Number.MAX_SAFE_INTEGER)
      - (depths.get(right.attempt_id) ?? Number.MAX_SAFE_INTEGER)
    || left.attempt_ordinal - right.attempt_ordinal
    || compareStrings(left.attempt_id, right.attempt_id)
  ));
  return {
    schema_version: COMPOSITE_MANIFEST_SCHEMA_VERSION,
    trial_id: input.trial_id,
    root_run_id: input.root_run_id,
    arm_name: input.arm_name,
    arm_canonical_sha256: input.arm_canonical_sha256,
    identity: input.identity,
    nodes,
    edges,
    roots: input.roots,
    // VERBATIM: the same object reference reconcileAccounting returned. No arithmetic, no
    // re-shaping, no re-ordering (G4-CM23).
    accounting: input.accounting,
    predicate: buildPredicate(input.mode, input.evaluatedChecks),
  };
}

// ---------------------------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------------------------

function canonicalEndpoint(ref: EndpointRef): Record<string, unknown> {
  return ref.ref === 'direct-parent' ? { ref: ref.ref } : { ref: ref.ref, id: ref.id };
}

function canonicalEdge(edge: AttemptEdge): Record<string, unknown> {
  return { kind: edge.kind, from: canonicalEndpoint(edge.from), to: canonicalEndpoint(edge.to) };
}

function canonicalNode(node: AttemptRecord): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of ATTEMPT_RECORD_KEYS) {
    if (key === 'edges') ordered[key] = node.edges.map(canonicalEdge);
    else if (key === 'tokens') {
      const tokens = node.tokens;
      // All four members always present (G4-CM2), in declaration order.
      ordered[key] = {
        input: tokens.input, output: tokens.output,
        cache_read: tokens.cache_read, cache_creation: tokens.cache_creation,
      };
    } else ordered[key] = node[key];
  }
  return ordered;
}

/**
 * G4-CM4 — UTF-8, no BOM, `\n` line endings, two-space indent, exactly one trailing `\n`.
 *
 * `accounting` and the two `identity` maps are passed through UNTOUCHED: re-ordering either would
 * be the re-shaping O-G4-ACCT (G4-CM23) and G4-CM8 forbid. Everything this module owns is written
 * in its declared order instead.
 */
export function canonicalCompositeManifestBytes(manifest: CompositeManifest): Buffer {
  const ordered: Record<string, unknown> = {};
  for (const key of COMPOSITE_MANIFEST_KEYS) {
    if (key === 'nodes') ordered[key] = manifest.nodes.map(canonicalNode);
    else if (key === 'edges') ordered[key] = manifest.edges.map(canonicalEdge);
    else if (key === 'roots') {
      ordered[key] = {
        parent_attempt_id: manifest.roots.parent_attempt_id,
        root_task_id: manifest.roots.root_task_id,
      };
    } else if (key === 'predicate') {
      ordered[key] = {
        mode: manifest.predicate.mode,
        checks: manifest.predicate.checks.map(check => ({
          check_id: check.check_id, result: check.result, detail: check.detail,
        })),
      };
    } else ordered[key] = manifest[key];
  }
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Validation — §9.2's invariants, each refusal with its own named code
// ---------------------------------------------------------------------------------------------

export interface CompositeManifestContext {
  readonly limits: { readonly max_task_depth: number; readonly max_tasks: number };
  /**
   * The lifecycle stems observed under the trajectory root, i.e. the `<stem>` of every
   * `<stem>.started.json`. Supplied as DATA so the validator stays pure — the same reason §17
   * G4-SM2 makes the seal evaluator take its operands as data.
   */
  readonly lifecycleStems: readonly string[];
}

const PROXY_KEYS = [
  'requests', 'cost_usd', 'input_tokens', 'output_tokens', 'audit_log', 'lease_echo', 'source',
];
const JOURNAL_KEYS = ['requests', 'cost_usd', 'steps', 'tokens', 'source'];

export function validateCompositeManifest(
  manifest: CompositeManifest,
  context: CompositeManifestContext,
): readonly CompositeManifestViolation[] {
  const violations: CompositeManifestViolation[] = [];
  const add = (code: CompositeManifestViolationCode, detail: string): void => {
    violations.push({
      code,
      failure_code: failureCode(
        UNACCOUNTED_CODES.has(code) ? 'attempt_unaccounted' : 'composite_manifest_invalid',
      ),
      detail,
    });
  };

  const record = manifest as unknown as Record<string, unknown>;
  const presentKeys = Object.keys(record);
  const declared = new Set<string>(COMPOSITE_MANIFEST_KEYS);
  for (const key of presentKeys) {
    if (!declared.has(key)) add('unknown_top_level_member', key);
  }
  for (const key of COMPOSITE_MANIFEST_KEYS) {
    if (!Object.hasOwn(record, key)) add('top_level_member_missing', key);
  }
  const expectedOrder = COMPOSITE_MANIFEST_KEYS.filter(key => Object.hasOwn(record, key));
  const actualOrder = presentKeys.filter(key => declared.has(key));
  if (actualOrder.join(',') !== expectedOrder.join(',')) {
    add('member_order_invalid', `expected ${expectedOrder.join(',')}, got ${actualOrder.join(',')}`);
  }

  if (manifest.schema_version !== COMPOSITE_MANIFEST_SCHEMA_VERSION) {
    add('schema_version_invalid', String(manifest.schema_version));
  }

  const nodes = manifest.nodes ?? [];
  const edges = manifest.edges ?? [];
  if (nodes.length === 0) add('nodes_empty', 'a trial with no attempt has no manifest to publish');

  // ---- §9.2 invariant 1: unique attempt ids ------------------------------------------------
  const attemptIds = new Set<string>();
  for (const node of nodes) {
    if (attemptIds.has(node.attempt_id)) add('attempt_id_not_unique', node.attempt_id);
    attemptIds.add(node.attempt_id);
  }
  const taskIds = new Set(nodes.map(node => node.task_id));

  // ---- §9.2 invariant 1: endpoint resolution and legality (G4-CM14 / G4-CM15) ---------------
  const resolves = (ref: EndpointRef): boolean => {
    switch (ref.ref) {
      case 'attempt': case 'proposal': case 'outcome': return attemptIds.has(ref.id);
      case 'task': return taskIds.has(ref.id);
      case 'direct-parent': return attemptIds.has(manifest.roots?.parent_attempt_id);
    }
  };
  for (const edge of edges) {
    const legality = EDGE_ENDPOINT_LEGALITY[edge.kind];
    if (!legality) {
      add('edge_endpoint_type_invalid', `unknown kind ${String(edge.kind)}`);
      continue;
    }
    if (!legality.from.includes(edge.from.ref)) {
      add('edge_endpoint_type_invalid', `${edge.kind}.from may not be ${edge.from.ref}`);
    }
    if (!legality.to.includes(edge.to.ref)) {
      add('edge_endpoint_type_invalid', `${edge.kind}.to may not be ${edge.to.ref}`);
    }
    if (!resolves(edge.from)) add('edge_endpoint_unresolved', `${edge.kind}.from ${endpointKey(edge.from)}`);
    if (!resolves(edge.to)) add('edge_endpoint_unresolved', `${edge.kind}.to ${endpointKey(edge.to)}`);
  }

  // ---- G4-CM17: duplicates and total order --------------------------------------------------
  const edgeTriples = new Set<string>();
  for (const edge of edges) {
    const triple = `${edge.kind}\u0000${endpointKey(edge.from)}\u0000${endpointKey(edge.to)}`;
    if (edgeTriples.has(triple)) add('edge_duplicated', triple);
    edgeTriples.add(triple);
  }
  const sortedEdges = [...edges].sort(compareEdges);
  if (edges.some((edge, index) => compareEdges(edge, sortedEdges[index]) !== 0)) {
    add('edges_out_of_order', 'edges are not in (kind, from, to) order');
  }

  // ---- §9.2 invariant 2: DAG rooted at roots.parent_attempt_id ------------------------------
  const parentAttemptId = manifest.roots?.parent_attempt_id;
  if (hasCycle(edges)) add('attempt_dag_cycle', 'spawn/decompose/dispatch subset contains a cycle');
  const depths = attemptDepths(edges, parentAttemptId);
  for (const node of nodes) {
    if (!depths.has(node.attempt_id)) {
      add('attempt_dag_unrooted', node.attempt_id);
    }
  }

  // ---- G4-CM12: node total order ------------------------------------------------------------
  const sortedNodes = [...nodes].sort((left, right) => (
    (depths.get(left.attempt_id) ?? Number.MAX_SAFE_INTEGER)
      - (depths.get(right.attempt_id) ?? Number.MAX_SAFE_INTEGER)
    || left.attempt_ordinal - right.attempt_ordinal
    || compareStrings(left.attempt_id, right.attempt_id)
  ));
  if (nodes.some((node, index) => node.attempt_id !== sortedNodes[index].attempt_id)) {
    add('nodes_out_of_order', 'nodes are not in (depth, attempt_ordinal, attempt_id) order');
  }

  // ---- §9.2 invariant 3: policy bounds ------------------------------------------------------
  for (const node of nodes) {
    const depth = depths.get(node.attempt_id);
    if (depth !== undefined && depth > context.limits.max_task_depth) {
      add('task_depth_exceeded', `${node.attempt_id} at depth ${depth}`);
    }
  }
  // In a taskless mode (G4-CM11) `task_id` carries `trial_id` as a RE-USED identifier, not a task,
  // and `roots.root_task_id === null` is the only place that shape is visible (17.1.6). Counting
  // the placeholder would make every `direct` trial exceed its own `max_tasks = 0`, contradicting
  // §9.4 D2, which declares such a trial valid.
  const distinctTasks = manifest.roots?.root_task_id === null ? 0 : taskIds.size;
  if (distinctTasks > context.limits.max_tasks) {
    add('task_count_exceeded', `${distinctTasks} distinct task_id > ${context.limits.max_tasks}`);
  }

  // ---- §9.2 invariant 4: the biconditional over lifecycle pairs -----------------------------
  const stems = new Set(context.lifecycleStems);
  for (const node of nodes) {
    if (!stems.has(node.attempt_id)) add('attempt_missing_lifecycle_pair', node.attempt_id);
  }
  for (const stem of stems) {
    if (!attemptIds.has(stem)) add('lifecycle_pair_missing_attempt', stem);
  }

  // ---- G4-CM18: node-local projection -------------------------------------------------------
  for (const node of nodes) {
    const expected = edges.filter(
      edge => edge.from.ref === 'attempt' && edge.from.id === node.attempt_id,
    );
    const actual = node.edges ?? [];
    const same = actual.length === expected.length
      && expected.every((edge, index) => compareEdges(edge, actual[index]) === 0);
    if (!same) add('node_edge_projection_mismatch', node.attempt_id);
  }

  // ---- roots (17.1.6) -----------------------------------------------------------------------
  const rootNode = nodes.find(node => node.attempt_id === parentAttemptId);
  if (!rootNode || depths.get(parentAttemptId) !== 0 || rootNode.thread_id !== null) {
    add('roots_parent_attempt_invalid', String(parentAttemptId));
  }

  // ---- trial coherence (G4-CM23 / G4-CM24) --------------------------------------------------
  for (const node of nodes) {
    if (node.trial_id !== manifest.trial_id) add('node_trial_id_mismatch', node.attempt_id);
  }
  if (manifest.accounting?.trial_id !== manifest.trial_id) {
    add('accounting_trial_id_mismatch', String(manifest.accounting?.trial_id));
  }
  // G4-CM25: the input types are not the record types. `adapter_id` or `roles` appearing here means
  // an encoder copied `ProxyExport`/`JournalTotals` instead of the returned record.
  const proxyKeys = Object.keys(manifest.accounting?.proxy ?? {});
  const journalKeys = Object.keys(manifest.accounting?.journal ?? {});
  if (proxyKeys.join(',') !== PROXY_KEYS.join(',')) {
    add('accounting_shape_invalid', `proxy keys ${proxyKeys.join(',')}`);
  }
  if (journalKeys.join(',') !== JOURNAL_KEYS.join(',')) {
    add('accounting_shape_invalid', `journal keys ${journalKeys.join(',')}`);
  }

  // ---- node-level ---------------------------------------------------------------------------
  for (const node of nodes) {
    if (!Number.isInteger(node.attempt_ordinal) || node.attempt_ordinal < 1) {
      add('attempt_ordinal_invalid', `${node.attempt_id} ordinal ${node.attempt_ordinal}`);
    }
    const superseded = node.disposition === 'superseded';
    if (superseded !== (node.superseded_by !== null)
      || (node.superseded_by !== null && !attemptIds.has(node.superseded_by))) {
      add('superseded_by_unresolved', node.attempt_id);
    }
    const ancestry = node.task_ancestry ?? [];
    if (ancestry.length === 0 || ancestry[ancestry.length - 1] !== node.task_id) {
      add('task_ancestry_invalid', node.attempt_id);
    }
    // G4-N14: refused in BOTH directions — a thread attempt that lost its thread-scoped identity,
    // and a parent attempt that fabricated one.
    if (!threadScopedIdentityHolds(node)) {
      add('thread_scoped_identity_invalid', node.attempt_id);
    }
  }

  // ---- predicate (G4-CM19 / CM20 / CM21) ----------------------------------------------------
  // A missing or unknown `predicate` is already reported as `top_level_member_missing`; the check
  // list simply has no expectation to be measured against, and inventing one would double-report.
  const mode = manifest.predicate?.mode;
  const expectedChecks = mode && MODE_CHECK_IDS[mode] ? checkIdsForMode(mode) : null;
  const actualChecks = (manifest.predicate?.checks ?? []).map(check => check.check_id);
  if (expectedChecks) {
    const missing = expectedChecks.filter(id => !actualChecks.includes(id));
    if (missing.length > 0) add('predicate_checks_incomplete', missing.join(','));
    else if (actualChecks.join(',') !== expectedChecks.join(',')) {
      add('predicate_checks_out_of_order', actualChecks.join(','));
    }
  }
  for (const check of manifest.predicate?.checks ?? []) {
    const detailOk = check.result === 'pass'
      ? check.detail === null
      : typeof check.detail === 'string' && check.detail.length > 0;
    if (!detailOk) add('predicate_check_detail_invalid', check.check_id);
  }

  return violations;
}

// ---------------------------------------------------------------------------------------------
// F8 — the composite manifest's atomic publication (§9.5, §7.2 P22 `publishComposite`)
// ---------------------------------------------------------------------------------------------

function temporaryPath(outputPath: string): string {
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return `${outputPath}.tmp.${nonce}`;
}

function writeFull(fd: number, bytes: Buffer, fileSystem: TrajectoryMergeFileSystem): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += fileSystem.write(fd, bytes, offset, bytes.length - offset);
  }
}

function safeCleanup(filePath: string, fileSystem: TrajectoryMergeFileSystem): void {
  try {
    if (fileSystem.exists(filePath)) fileSystem.unlink(filePath);
  } catch { /* cleanup is best-effort; the publication result is what matters */ }
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

/**
 * F8's manifest half. The atomicity is the shipped one (`trajectory-merge.ts:426-444`): temp opened
 * `O_EXCL`, written, fsynced, closed, then hard-LINKED to the final path. A pre-existing final path
 * is `output_path_exists` and a HARD failure — G4-PB6's ground for keeping one production writer,
 * because a second writer turns that hard failure into a race.
 *
 * G4-CM5: the manifest's identity is the sha256 over its canonical bytes, and the published file is
 * re-read and re-hashed before this returns; a differing hash is `composite_manifest_invalid`.
 *
 * The ATIF half of F8 keeps its own shipped publisher and is not touched here.
 */
export function publishComposite(
  manifest: CompositeManifest,
  outputPath: string,
  fileSystem: TrajectoryMergeFileSystem = NODE_TRAJECTORY_MERGE_FS,
): { path: string; sha256: string } {
  const resolved = path.resolve(outputPath);
  const bytes = canonicalCompositeManifestBytes(manifest);
  const expected = createHash('sha256').update(bytes).digest('hex');
  if (fileSystem.exists(resolved)) {
    throw new CompositeManifestError('output_path_exists', resolved);
  }
  const temporary = temporaryPath(resolved);
  let fd: number | null = null;
  try {
    fd = fileSystem.open(
      temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600,
    );
    writeFull(fd, bytes, fileSystem);
    fileSystem.fsync(fd);
    fileSystem.close(fd);
    fd = null;
    try {
      fileSystem.link(temporary, resolved);
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        throw new CompositeManifestError('output_path_exists', resolved);
      }
      throw error;
    }
    safeCleanup(temporary, fileSystem);
  } catch (error) {
    if (fd !== null) {
      try { fileSystem.close(fd); } catch { /* the throw below is the outcome */ }
    }
    safeCleanup(temporary, fileSystem);
    throw error;
  }
  const republished = createHash('sha256').update(fileSystem.readFile(resolved)).digest('hex');
  if (republished !== expected) {
    throw new CompositeManifestError(
      'composite_manifest_invalid', `published bytes re-read as ${republished}`,
    );
  }
  return { path: resolved, sha256: expected };
}
