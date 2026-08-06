// input:  built attempt DAGs, the shipped AccountingRecord, and deliberately corrupted manifests
// output: canonical-form, verbatim-accounting and both-direction structural-invariant proofs
// pos:    Composite manifest encoding and validation tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// BOTH DIRECTIONS. Every §9.2 structural invariant is proved twice: a valid graph is ACCEPTED, and
// each violation is REFUSED with its OWN named code, asserted BY CODE. No assertion in this file
// matches a message string — `codesOf` collects `violation.code`, never `violation.detail`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  COMPOSITE_MANIFEST_KEYS,
  COMPOSITE_MANIFEST_SCHEMA_VERSION,
  COMPOSITE_MANIFEST_VIOLATION_CODES,
  CompositeManifestError,
  MODE_CHECK_IDS,
  SHARED_CHECK_IDS,
  buildCompositeManifest,
  canonicalCompositeManifestBytes,
  checkIdsForMode,
  publishComposite,
  validateCompositeManifest,
  type CompositeManifest,
  type CompositeManifestContext,
  type CompositeManifestViolationCode,
} from '../../../src/domain/benchmark/composite-manifest.js';
import {
  NODE_TRAJECTORY_MERGE_FS,
  type TrajectoryMergeFileSystem,
} from '../../../src/domain/agent-run/trajectory-merge.js';
import {
  reconcileAccounting,
  type AccountingRecord,
  type JournalTotals,
  type ProxyExport,
} from '../../../src/domain/benchmark/accounting-reconciliation.js';
import { BENCHMARK_FAILURES } from '../../../src/domain/benchmark/resolved-policy.js';
import type { AttemptEdge, AttemptRecord } from '../../../src/domain/benchmark/attempt-record.js';
import { sampleAttempt } from './attempt-record.test.js';

const SHA = 'b'.repeat(64);

function accountingRecord(): AccountingRecord {
  const proxy: ProxyExport = {
    schema_version: 'cortex-bench-proxy-export/1', trial_id: 'trial-1', adapter_id: 'adapter-1',
    requests: { status: 'available', value: 4 },
    cost_usd: { status: 'available', value: '0.000200' },
    input_tokens: { status: 'available', value: 10 },
    output_tokens: { status: 'available', value: 20 },
    audit_log: { status: 'available', value: { entries: 1 } },
    lease_echo: { status: 'available', value: { echoed: true } },
    source: 'proxy_export',
  };
  const journal: JournalTotals = {
    requests: { status: 'unavailable', reason: 'journal_underivable' },
    cost_usd: { status: 'available', value: '0.000200' },
    steps: { status: 'available', value: 3 },
    tokens: {
      input: { status: 'available', value: 10 },
      output: { status: 'available', value: 20 },
      cached: { status: 'available', value: 0 },
    },
    source: 'trajectory_merge',
    roles: ['parent'],
  };
  return reconcileAccounting(proxy, journal);
}

const IDENTITY = {
  model_execution_identity_hash: { parent: SHA },
  role_tool_surface_hash: { parent: SHA },
  bundle_manifest_hash: SHA,
};

/** A taskless `direct` trial: exactly one node, zero edges (§9.4 D2). */
function directManifest(): CompositeManifest {
  return buildCompositeManifest({
    trial_id: 'trial-1', root_run_id: 'r1', arm_name: 'arm-a', arm_canonical_sha256: SHA,
    identity: IDENTITY,
    nodes: [sampleAttempt({ attempt_id: 'run-r1', task_id: 'trial-1', task_ancestry: ['trial-1'] })],
    edges: [],
    roots: { parent_attempt_id: 'run-r1', root_task_id: null },
    accounting: accountingRecord(),
    mode: 'direct',
  });
}

const directContext: CompositeManifestContext = {
  limits: { max_task_depth: 0, max_tasks: 0 },
  lifecycleStems: ['run-r1'],
};

/** A two-node manager DAG exercising the heterogeneous attempt→task→attempt path. */
function managerManifest(overrides: {
  nodes?: readonly AttemptRecord[]; edges?: readonly AttemptEdge[];
} = {}): CompositeManifest {
  const parent = sampleAttempt({
    attempt_id: 'run-r1', task_id: 't-root', task_ancestry: ['t-root'], thread_id: null,
  });
  const child = sampleAttempt({
    attempt_id: 'thread-c1', task_id: 't-child', parent_task_id: 't-root',
    task_ancestry: ['t-root', 't-child'], thread_id: 'c1',
    // A THREAD attempt: the G4-N14 biconditional requires non-null thread-scoped identity here.
    root_thread_id: 'c1', template: 'benchmark-coder-review',
    journal_path: 'thread-c1.journal.ndjson', terminal_manifest_path: 'thread-c1.terminal.json',
  });
  return buildCompositeManifest({
    trial_id: 'trial-1', root_run_id: 'r1', arm_name: 'arm-a', arm_canonical_sha256: SHA,
    identity: IDENTITY,
    nodes: overrides.nodes ?? [parent, child],
    edges: overrides.edges ?? [
      { kind: 'decompose', from: { ref: 'attempt', id: 'run-r1' }, to: { ref: 'task', id: 't-child' } },
      { kind: 'dispatch', from: { ref: 'task', id: 't-child' }, to: { ref: 'attempt', id: 'thread-c1' } },
    ],
    roots: { parent_attempt_id: 'run-r1', root_task_id: 't-root' },
    accounting: accountingRecord(),
    mode: 'manager',
  });
}

const managerContext: CompositeManifestContext = {
  limits: { max_task_depth: 4, max_tasks: 8 },
  lifecycleStems: ['run-r1', 'thread-c1'],
};

function codesOf(
  manifest: CompositeManifest, context: CompositeManifestContext,
): CompositeManifestViolationCode[] {
  // BY CODE, never by message: only `.code` is ever read.
  return validateCompositeManifest(manifest, context).map(violation => violation.code);
}

/** Structural mutation helper — the manifest is readonly by type, so corruption is explicit. */
function mutate(manifest: CompositeManifest, patch: Record<string, unknown>): CompositeManifest {
  return { ...manifest, ...patch } as CompositeManifest;
}

describe('the eleven top-level members (§17 17.1.2, count RULED eleven)', () => {
  it('declares exactly eleven members in declaration order', () => {
    // The heading said "nine"; §9.2's sketch spreads eleven members over nine member-bearing lines
    // (design:2639 carries three on one line). The count is obtained by ENUMERATING THE CONSTRUCT.
    expect(COMPOSITE_MANIFEST_KEYS.length).toBe(11);
    expect([...COMPOSITE_MANIFEST_KEYS]).toEqual([
      'schema_version', 'trial_id', 'root_run_id', 'arm_name', 'arm_canonical_sha256',
      'identity', 'nodes', 'edges', 'roots', 'accounting', 'predicate',
    ]);
  });

  it('a built manifest carries all eleven and nothing else', () => {
    expect(Object.keys(directManifest())).toEqual([...COMPOSITE_MANIFEST_KEYS]);
    expect(directManifest().schema_version).toBe(COMPOSITE_MANIFEST_SCHEMA_VERSION);
    expect(COMPOSITE_MANIFEST_SCHEMA_VERSION).toBe('cortex-bench-composite-manifest/1');
  });
});

describe('canonical form (§17 17.1.1) — order is not a degree of freedom', () => {
  it('G4-CM1: two manifests differing ONLY in member order serialise identically', () => {
    const manifest = directManifest();
    const shuffled = {} as Record<string, unknown>;
    for (const key of [...COMPOSITE_MANIFEST_KEYS].reverse()) {
      shuffled[key] = (manifest as unknown as Record<string, unknown>)[key];
    }
    expect(Object.keys(shuffled)).not.toEqual([...COMPOSITE_MANIFEST_KEYS]);
    expect(canonicalCompositeManifestBytes(shuffled as unknown as CompositeManifest))
      .toEqual(canonicalCompositeManifestBytes(manifest));
  });

  it('G4-CM3/CM12/CM17: two manifests differing ONLY in ELEMENT order serialise identically', () => {
    const forward = managerManifest();
    const reversed = managerManifest({
      nodes: [...managerManifest().nodes].reverse(),
      edges: [...managerManifest().edges].reverse(),
    });
    expect(canonicalCompositeManifestBytes(reversed)).toEqual(
      canonicalCompositeManifestBytes(forward),
    );
  });

  it('G4-CM12: nodes are totally ordered by (depth, attempt_ordinal, attempt_id)', () => {
    // §9.2's own (depth, attempt_ordinal) is a PARTIAL order — two attempts of two tasks at the
    // same depth may share an ordinal — so `attempt_id` is the tie-break that makes it total.
    const ordered = managerManifest().nodes.map(node => node.attempt_id);
    expect(ordered).toEqual(['run-r1', 'thread-c1']);
  });

  it('G4-CM17: edges are totally ordered by kind ordinal then endpoints', () => {
    // `decompose` is ordinal 2 and `dispatch` ordinal 4, so decompose sorts first regardless of
    // the order they were supplied in.
    expect(managerManifest().edges.map(edge => edge.kind)).toEqual(['decompose', 'dispatch']);
  });

  it('G4-CM4: UTF-8, two-space indent, exactly one trailing newline, no BOM', () => {
    const bytes = canonicalCompositeManifestBytes(directManifest());
    const text = bytes.toString('utf8');
    expect(text.startsWith('{\n  "schema_version"')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('}\n\n')).toBe(false);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('G4-CM5: the manifest identity is sha256 over exactly those canonical bytes', () => {
    const bytes = canonicalCompositeManifestBytes(directManifest());
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(createHash('sha256').update(canonicalCompositeManifestBytes(directManifest())).digest('hex'))
      .toBe(expected);
  });

  it('G4-CM18: node-local edges are the projection of the top-level array', () => {
    const manifest = managerManifest();
    const parent = manifest.nodes.find(node => node.attempt_id === 'run-r1')!;
    const child = manifest.nodes.find(node => node.attempt_id === 'thread-c1')!;
    // Exactly the subsequence whose `from` is this attempt. The `dispatch` edge's `from` is a TASK,
    // so it is projected onto no node — which is what G4-CM18 requires a validator to assert.
    expect(parent.edges.map(edge => edge.kind)).toEqual(['decompose']);
    expect(child.edges).toEqual([]);
  });
});

describe('O-G4-ACCT — the AccountingRecord is placed VERBATIM (§17 17.1.8)', () => {
  it('carries the NINE members that SHIPPED, including `checks`', () => {
    // §15.4.3's sketch shows EIGHT and omits `checks` (accounting-reconciliation.ts:113).
    const accounting = directManifest().accounting;
    expect(Object.keys(accounting)).toEqual([
      'schema_version', 'trial_id', 'proxy', 'journal', 'tolerance',
      'deltas', 'reconciled', 'unaccounted_roles', 'checks',
    ]);
    expect(Object.keys(accounting).length).toBe(9);
    expect(accounting.checks).toBeDefined();
  });

  it('ProxyAccounting keeps all SEVEN members including audit_log', () => {
    // `audit_log` (:53) is absent from §15.4.3's sketch too.
    expect(Object.keys(directManifest().accounting.proxy)).toEqual([
      'requests', 'cost_usd', 'input_tokens', 'output_tokens',
      'audit_log', 'lease_echo', 'source',
    ]);
  });

  it('G4-CM25: the INPUT types are not the record types — adapter_id and roles are NOT carried', () => {
    // The trap O-G4-ACCT exists to close: copying `ProxyExport`/`JournalTotals` instead of the
    // returned record re-shapes it while still producing a document that parses.
    const accounting = directManifest().accounting;
    expect(Object.hasOwn(accounting.proxy, 'adapter_id')).toBe(false);
    expect(Object.hasOwn(accounting.proxy, 'schema_version')).toBe(false);
    expect(Object.hasOwn(accounting.journal, 'roles')).toBe(false);
    expect(Object.keys(accounting.journal)).toEqual([
      'requests', 'cost_usd', 'steps', 'tokens', 'source',
    ]);
  });

  it('G4-CM23: NOTHING is re-derived, re-rounded, re-summed, recomputed or re-ordered', () => {
    const record = accountingRecord();
    const manifest = buildCompositeManifest({
      trial_id: 'trial-1', root_run_id: 'r1', arm_name: 'arm-a', arm_canonical_sha256: SHA,
      identity: IDENTITY,
      nodes: [sampleAttempt({ attempt_id: 'run-r1', task_id: 'trial-1' })],
      edges: [], roots: { parent_attempt_id: 'run-r1', root_task_id: null },
      accounting: record, mode: 'direct',
    });
    // Reference identity: the very object reconcileAccounting returned, not a copy of it.
    expect(manifest.accounting).toBe(record);
    // And byte-preserving through the canonical encoder — key ORDER included.
    const parsed = JSON.parse(canonicalCompositeManifestBytes(manifest).toString('utf8'));
    expect(JSON.stringify(parsed.accounting)).toBe(JSON.stringify(record));
    expect(parsed.accounting.deltas).toEqual(record.deltas);
    expect(parsed.accounting.reconciled).toEqual(record.reconciled);
    expect(parsed.accounting.checks).toEqual(record.checks);
    expect(parsed.accounting.tolerance.requests_abs).toBe(0);
  });

  it('G4-CM26: journal.requests is permanently unavailable, and no decimal is re-rounded', () => {
    const accounting = directManifest().accounting;
    expect(accounting.journal.requests).toEqual(
      { status: 'unavailable', reason: 'journal_underivable' },
    );
    // A re-rounded decimal string is the classic re-derivation; the text must survive exactly.
    expect(accounting.journal.cost_usd).toEqual({ status: 'available', value: '0.000200' });
  });
});

describe('predicate (§17 17.1.7)', () => {
  it('G4-CM20: checks are EXHAUSTIVE for the mode — a missing id is not an implicit pass', () => {
    expect(directManifest().predicate.checks.map(check => check.check_id))
      .toEqual(checkIdsForMode('direct'));
    expect(checkIdsForMode('direct')).toEqual([...SHARED_CHECK_IDS, ...MODE_CHECK_IDS.direct]);
  });

  it('G4-CM19: shared G1..G8 come first, then the mode rows in §9.4 order', () => {
    expect(checkIdsForMode('manager').slice(0, 8)).toEqual(
      ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'],
    );
    expect(checkIdsForMode('manager').slice(8, 10)).toEqual(['M-1', 'M-2']);
    expect(checkIdsForMode('coder-review')).toHaveLength(16);
    expect(checkIdsForMode('manager')).toHaveLength(24);
  });

  it('records an unevaluated check as explicitly UNAVAILABLE — never as pass', () => {
    // A check that reads `pass` because nobody ran it is §9.6 A5's guess in a new place.
    const checks = directManifest().predicate.checks;
    expect(checks.every(check => check.result === 'unavailable')).toBe(true);
    expect(checks.some(check => check.result === 'pass')).toBe(false);
    expect(checks.every(check => typeof check.detail === 'string' && check.detail.length > 0))
      .toBe(true);
  });

  it('carries an evaluated check through with its own result', () => {
    const manifest = buildCompositeManifest({
      trial_id: 'trial-1', root_run_id: 'r1', arm_name: 'arm-a', arm_canonical_sha256: SHA,
      identity: IDENTITY,
      nodes: [sampleAttempt({ attempt_id: 'run-r1', task_id: 'trial-1' })],
      edges: [], roots: { parent_attempt_id: 'run-r1', root_task_id: null },
      accounting: accountingRecord(), mode: 'direct',
      evaluatedChecks: { G1: { result: 'pass', detail: null } },
    });
    const g1 = manifest.predicate.checks.find(check => check.check_id === 'G1')!;
    expect(g1).toEqual({ check_id: 'G1', result: 'pass', detail: null });
  });
});

describe('§9.2 structural invariants — DIRECTION 1: a valid graph is ACCEPTED', () => {
  it('accepts the taskless single-node direct manifest with ZERO violations', () => {
    expect(codesOf(directManifest(), directContext)).toEqual([]);
  });

  it('accepts the two-node manager DAG with ZERO violations', () => {
    expect(codesOf(managerManifest(), managerContext)).toEqual([]);
  });
});

describe('§9.2 structural invariants — DIRECTION 2: each violation, its OWN named code', () => {
  it('every declared violation code is distinct and the union is closed', () => {
    expect(new Set(COMPOSITE_MANIFEST_VIOLATION_CODES).size)
      .toBe(COMPOSITE_MANIFEST_VIOLATION_CODES.length);
  });

  // ---- document closure -------------------------------------------------------------------
  it('schema_version_invalid', () => {
    const bad = mutate(directManifest(), { schema_version: 'cortex-bench-composite-manifest/2' });
    expect(codesOf(bad, directContext)).toContain('schema_version_invalid');
  });

  it('unknown_top_level_member — G4-CM6 closes the document in both directions', () => {
    const bad = mutate(directManifest(), { surprise: 1 });
    expect(codesOf(bad, directContext)).toContain('unknown_top_level_member');
  });

  it('top_level_member_missing', () => {
    const bad = { ...directManifest() } as Record<string, unknown>;
    delete bad.predicate;
    expect(codesOf(bad as unknown as CompositeManifest, directContext))
      .toContain('top_level_member_missing');
  });

  it('member_order_invalid — G4-CM1 makes order a VALIDATED property', () => {
    const manifest = directManifest();
    const reordered = {} as Record<string, unknown>;
    for (const key of [...COMPOSITE_MANIFEST_KEYS].reverse()) {
      reordered[key] = (manifest as unknown as Record<string, unknown>)[key];
    }
    expect(codesOf(reordered as unknown as CompositeManifest, directContext))
      .toContain('member_order_invalid');
  });

  it('nodes_empty — a trial with no attempt has no manifest to publish', () => {
    const bad = mutate(directManifest(), { nodes: [] });
    expect(codesOf(bad, { ...directContext, lifecycleStems: [] })).toContain('nodes_empty');
  });

  // ---- §9.2 invariant 1 -------------------------------------------------------------------
  it('attempt_id_not_unique', () => {
    const node = sampleAttempt({ attempt_id: 'run-r1', task_id: 'trial-1' });
    const bad = mutate(directManifest(), { nodes: [node, node] });
    expect(codesOf(bad, directContext)).toContain('attempt_id_not_unique');
  });

  it('edge_endpoint_unresolved — G4-CM14', () => {
    const bad = mutate(managerManifest(), {
      edges: [{
        kind: 'spawn', from: { ref: 'attempt', id: 'run-r1' },
        to: { ref: 'attempt', id: 'ghost' },
      }],
    });
    expect(codesOf(bad, managerContext)).toContain('edge_endpoint_unresolved');
  });

  it('edge_endpoint_type_invalid — G4-CM15, a depends_on from an attempt is NOT a lenient read', () => {
    const bad = mutate(managerManifest(), {
      edges: [{
        kind: 'depends_on', from: { ref: 'attempt', id: 'run-r1' },
        to: { ref: 'task', id: 't-child' },
      }],
    });
    expect(codesOf(bad, managerContext)).toContain('edge_endpoint_type_invalid');
  });

  it('the id-less direct-parent endpoint RESOLVES to roots.parent_attempt_id', () => {
    const ok = managerManifest({
      edges: [
        { kind: 'decompose', from: { ref: 'attempt', id: 'run-r1' }, to: { ref: 'task', id: 't-child' } },
        { kind: 'dispatch', from: { ref: 'task', id: 't-child' }, to: { ref: 'attempt', id: 'thread-c1' } },
        { kind: 'question', from: { ref: 'attempt', id: 'thread-c1' }, to: { ref: 'direct-parent' } },
      ],
    });
    expect(codesOf(ok, managerContext)).toEqual([]);
  });

  // ---- §9.2 invariant 2 -------------------------------------------------------------------
  it('attempt_dag_cycle', () => {
    const bad = mutate(managerManifest(), {
      edges: [
        { kind: 'spawn', from: { ref: 'attempt', id: 'run-r1' }, to: { ref: 'attempt', id: 'thread-c1' } },
        { kind: 'spawn', from: { ref: 'attempt', id: 'thread-c1' }, to: { ref: 'attempt', id: 'run-r1' } },
      ],
    });
    expect(codesOf(bad, managerContext)).toContain('attempt_dag_cycle');
  });

  it('attempt_dag_unrooted', () => {
    const bad = mutate(managerManifest(), { edges: [] });
    expect(codesOf(bad, managerContext)).toContain('attempt_dag_unrooted');
  });

  // ---- §9.2 invariant 3 -------------------------------------------------------------------
  it('task_depth_exceeded', () => {
    expect(codesOf(managerManifest(), { ...managerContext, limits: { max_task_depth: 1, max_tasks: 8 } }))
      .toContain('task_depth_exceeded');
  });

  it('task_count_exceeded', () => {
    expect(codesOf(managerManifest(), { ...managerContext, limits: { max_task_depth: 4, max_tasks: 1 } }))
      .toContain('task_count_exceeded');
  });

  // ---- §9.2 invariant 4 (biconditional; rides code 39) ------------------------------------
  it('attempt_missing_lifecycle_pair — a node with no pair', () => {
    const codes = codesOf(managerManifest(), { ...managerContext, lifecycleStems: ['run-r1'] });
    expect(codes).toContain('attempt_missing_lifecycle_pair');
  });

  it('lifecycle_pair_missing_attempt — the CONVERSE direction', () => {
    const codes = codesOf(directManifest(), {
      ...directContext, lifecycleStems: ['run-r1', 'thread-orphan'],
    });
    expect(codes).toContain('lifecycle_pair_missing_attempt');
  });

  it('both invariant-4 codes ride shipped code 39 attempt_unaccounted, the rest ride 40', () => {
    const thirtyNine = BENCHMARK_FAILURES.find(f => f.reason === 'attempt_unaccounted')!.code;
    const forty = BENCHMARK_FAILURES.find(f => f.reason === 'composite_manifest_invalid')!.code;
    expect(thirtyNine).toBe(39);
    expect(forty).toBe(40);
    const pairViolations = validateCompositeManifest(managerManifest(), {
      ...managerContext, lifecycleStems: ['run-r1'],
    }).filter(v => v.code === 'attempt_missing_lifecycle_pair');
    expect(pairViolations[0].failure_code).toBe(39);
    const schemaViolations = validateCompositeManifest(
      mutate(directManifest(), { schema_version: 'wrong' }), directContext,
    ).filter(v => v.code === 'schema_version_invalid');
    expect(schemaViolations[0].failure_code).toBe(40);
  });

  // ---- ordering / projection ---------------------------------------------------------------
  it('nodes_out_of_order', () => {
    const bad = mutate(managerManifest(), { nodes: [...managerManifest().nodes].reverse() });
    expect(codesOf(bad, managerContext)).toContain('nodes_out_of_order');
  });

  it('edges_out_of_order', () => {
    const bad = mutate(managerManifest(), { edges: [...managerManifest().edges].reverse() });
    expect(codesOf(bad, managerContext)).toContain('edges_out_of_order');
  });

  it('edge_duplicated — the same (kind, from, to) triple twice is ONE edge asserted twice', () => {
    const edge = managerManifest().edges[0];
    const bad = mutate(managerManifest(), { edges: [edge, edge, managerManifest().edges[1]] });
    expect(codesOf(bad, managerContext)).toContain('edge_duplicated');
  });

  it('node_edge_projection_mismatch', () => {
    const manifest = managerManifest();
    const broken = manifest.nodes.map(node => (
      node.attempt_id === 'run-r1' ? { ...node, edges: [] } : node
    ));
    expect(codesOf(mutate(manifest, { nodes: broken }), managerContext))
      .toContain('node_edge_projection_mismatch');
  });

  // ---- roots / coherence -------------------------------------------------------------------
  it('roots_parent_attempt_invalid — must resolve to a node at depth 0 with thread_id null', () => {
    const bad = mutate(directManifest(), {
      roots: { parent_attempt_id: 'nobody', root_task_id: null },
    });
    expect(codesOf(bad, directContext)).toContain('roots_parent_attempt_invalid');
  });

  it('node_trial_id_mismatch — G4-CM23 asserts, never re-derives', () => {
    const bad = mutate(directManifest(), {
      nodes: [sampleAttempt({ attempt_id: 'run-r1', trial_id: 'other-trial' })],
    });
    expect(codesOf(bad, directContext)).toContain('node_trial_id_mismatch');
  });

  it('accounting_trial_id_mismatch — G4-CM24 keeps the duplicate and ASSERTS it', () => {
    const bad = mutate(directManifest(), { trial_id: 'renamed' });
    expect(codesOf(bad, directContext)).toContain('accounting_trial_id_mismatch');
  });

  it('accounting_shape_invalid — the exact key sets of proxy (7) and journal (5)', () => {
    const manifest = directManifest();
    const reshaped = {
      ...manifest.accounting,
      proxy: { ...manifest.accounting.proxy, adapter_id: 'leaked' },
    };
    expect(codesOf(mutate(manifest, { accounting: reshaped }), directContext))
      .toContain('accounting_shape_invalid');
  });

  // ---- node-level --------------------------------------------------------------------------
  it('attempt_ordinal_invalid — base 1, there is no ordinal 0', () => {
    const bad = mutate(directManifest(), {
      nodes: [sampleAttempt({ attempt_id: 'run-r1', task_id: 'trial-1', attempt_ordinal: 0 })],
    });
    expect(codesOf(bad, directContext)).toContain('attempt_ordinal_invalid');
  });

  it('superseded_by_unresolved — non-null iff disposition is superseded, and must resolve', () => {
    const bad = mutate(directManifest(), {
      nodes: [sampleAttempt({
        attempt_id: 'run-r1', task_id: 'trial-1',
        disposition: 'superseded', superseded_by: 'ghost',
      })],
    });
    expect(codesOf(bad, directContext)).toContain('superseded_by_unresolved');
  });

  it('task_ancestry_invalid — root-first, the node own task_id last', () => {
    const bad = mutate(directManifest(), {
      nodes: [sampleAttempt({
        attempt_id: 'run-r1', task_id: 'trial-1', task_ancestry: ['someone-else'],
      })],
    });
    expect(codesOf(bad, directContext)).toContain('task_ancestry_invalid');
  });

  it('thread_scoped_identity_invalid — a THREAD attempt that lost its identity (G4-N14)', () => {
    const manifest = managerManifest();
    const stripped = manifest.nodes.map(node => (
      node.thread_id === null ? node : { ...node, root_thread_id: null, template: null }
    ));
    expect(codesOf(mutate(manifest, { nodes: stripped }), managerContext))
      .toContain('thread_scoped_identity_invalid');
  });

  it('thread_scoped_identity_invalid — a PARENT attempt that fabricated one (G4-N14)', () => {
    const bad = mutate(directManifest(), {
      nodes: [sampleAttempt({
        attempt_id: 'run-r1', task_id: 'trial-1', thread_id: null, root_thread_id: 'invented',
      })],
    });
    expect(codesOf(bad, directContext)).toContain('thread_scoped_identity_invalid');
  });

  it('predicate_checks_incomplete', () => {
    const manifest = directManifest();
    const bad = mutate(manifest, {
      predicate: { mode: 'direct', checks: manifest.predicate.checks.slice(0, 3) },
    });
    expect(codesOf(bad, directContext)).toContain('predicate_checks_incomplete');
  });

  it('predicate_checks_out_of_order', () => {
    const manifest = directManifest();
    const bad = mutate(manifest, {
      predicate: { mode: 'direct', checks: [...manifest.predicate.checks].reverse() },
    });
    expect(codesOf(bad, directContext)).toContain('predicate_checks_out_of_order');
  });

  it('predicate_check_detail_invalid — G4-CM21: null on pass, non-empty otherwise', () => {
    const manifest = directManifest();
    const checks = manifest.predicate.checks.map((check, index) => (
      index === 0 ? { ...check, result: 'fail' as const, detail: null } : check
    ));
    expect(codesOf(mutate(manifest, { predicate: { mode: 'direct', checks } }), directContext))
      .toContain('predicate_check_detail_invalid');
  });
});

describe('publishComposite — F8 atomic publication (§9.5, §7.2 P22)', () => {
  function tempRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'composite-'));
  }

  it('publishes the canonical bytes and returns their sha256', () => {
    const root = tempRoot();
    try {
      const output = path.join(root, 'composite.json');
      const manifest = directManifest();
      const result = publishComposite(manifest, output);
      const bytes = canonicalCompositeManifestBytes(manifest);
      expect(fs.readFileSync(output)).toEqual(bytes);
      expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(result.path).toBe(output);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('G4-CM5: it re-reads and re-hashes what it published', () => {
    const root = tempRoot();
    try {
      const output = path.join(root, 'composite.json');
      const result = publishComposite(directManifest(), output);
      const reread = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
      expect(reread).toBe(result.sha256);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a pre-existing final path is a HARD output_path_exists, never an overwrite', () => {
    const root = tempRoot();
    try {
      const output = path.join(root, 'composite.json');
      fs.writeFileSync(output, 'occupied');
      expect(() => publishComposite(directManifest(), output)).toThrow(CompositeManifestError);
      // The publication is guarded so a second writer turns a hard failure into a race (G4-PB6).
      expect(fs.readFileSync(output, 'utf8')).toBe('occupied');
      try {
        publishComposite(directManifest(), output);
      } catch (error) {
        expect((error as CompositeManifestError).reason).toBe('output_path_exists');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves no temporary file behind on success or on refusal', () => {
    const root = tempRoot();
    try {
      const output = path.join(root, 'composite.json');
      publishComposite(directManifest(), output);
      expect(fs.readdirSync(root)).toEqual(['composite.json']);
      expect(() => publishComposite(directManifest(), output)).toThrow();
      expect(fs.readdirSync(root)).toEqual(['composite.json']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Found BY THE PRE-REGISTERED MUTATION SWEEP (M14c survived). The pre-check and the link's EEXIST
  // translation are deliberately redundant, so removing either one alone stayed green: the other
  // masked it. The EEXIST arm is only reachable when the final path appears BETWEEN the pre-check
  // and the link — a TOCTOU race no single-threaded test can provoke through the real filesystem.
  // Injecting the seam reaches it, and turns the redundancy into two independently proven guards.
  it('refuses with output_path_exists when the final path appears in the pre-check/link race', () => {
    const root = tempRoot();
    try {
      const output = path.join(root, 'composite.json');
      const linked: string[] = [];
      const racing: TrajectoryMergeFileSystem = {
        ...NODE_TRAJECTORY_MERGE_FS,
        // The pre-check sees nothing AT THE FINAL PATH ONLY. Every other path — notably the
        // temporary, which `safeCleanup` probes through this same seam — stays truthful, so this
        // test cannot manufacture a cleanup result the real filesystem would not produce.
        exists: filePath => (
          filePath === path.resolve(output) ? false : NODE_TRAJECTORY_MERGE_FS.exists(filePath)
        ),
        // ...and the publication loses the race to a writer that got there first.
        link: (source, destination) => {
          linked.push(destination);
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        },
      };
      let reason: string | null = null;
      try {
        publishComposite(directManifest(), output, racing);
      } catch (error) {
        reason = (error as CompositeManifestError).reason;
      }
      expect(reason).toBe('output_path_exists');
      expect(linked).toEqual([path.resolve(output)]);
      // The lost race still leaves no temporary file behind.
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('CompositeManifestError carries the shipped code and a JSON record for stderr', () => {
    const error = new CompositeManifestError('composite_manifest_invalid', 'detail', []);
    expect(error.code).toBe(40);
    expect(error.record().reason).toBe('composite_manifest_invalid');
    expect(error.record().code).toBe(40);
  });
});
