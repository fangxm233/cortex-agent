// input:  manager- and coder-review-shaped attempt DAGs with their on-disk lifecycle pairs
// output: recursion depth, role-indexed identity, DAG partition and named-refusal proofs
// pos:    §9.3 M2-M9 recursive ATIF merge contract suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. Every case goes through the production `mergeTrajectory` and the production
// `NODE_TRAJECTORY_MERGE_FS`; nothing a test supplies stands in for production composition. The
// attempt DAG is INPUT DATA, not a stub: it is the same §9.2 document `buildCompositeManifest`
// produces, and the fixture mints its ids with the production `mintAttemptId`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  mergeTrajectory, type AttemptDag, type TrajectoryMergeReason,
} from '../../../src/domain/agent-run/trajectory-merge.js';
import {
  threadScopedIdentityHolds,
} from '../../../src/domain/benchmark/attempt-record.js';
import type { AttemptEdge } from '../../../src/domain/benchmark/attempt-record.js';
import {
  MANAGER_TREE_CALL_ID, attemptIdOf, writeCoderReviewFixture, writeDagFixture,
  writeManagerTreeFixture, managerTreeEdges, managerTreeSpecs, type DagFixture,
} from './atif-dag-fixtures.js';
import {
  removeFirstEvent, removeFragment, setModelIdentity, setSupervisor, setTerminalField,
} from './trajectory-merge-fixtures.js';

/**
 * §9.3's failure taxonomy, ENUMERATED FROM THE CONSTRUCT at `trajectory-merge.ts:20-24` — thirteen
 * reasons. `satisfies` closes it in one direction and `Unlisted` in the other, so a wave that mints
 * a fourteenth reason fails `tsc` here rather than shipping an unnamed refusal.
 */
const SHIPPED_REASONS = [
  'started_without_terminal', 'EACCES', 'ENOSPC', 'malformed_fragment', 'identity_hash_drift',
  'unresolvable_subagent_link', 'unbound_child_fragment', 'missing_child_fragment',
  'ambiguous_subagent_link', 'output_path_exists', 'output_path_not_writable',
  'containment_failure', 'aggregate_metrics_underivable',
] as const satisfies readonly TrajectoryMergeReason[];

type UnlistedReason = Exclude<TrajectoryMergeReason, typeof SHIPPED_REASONS[number]>;
const _taxonomyIsClosed: UnlistedReason extends never ? true : never = true;
void _taxonomyIsClosed;

const AGENT_SERVER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atif-recursive-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface PublishedTrajectory {
  trajectory_id: string;
  steps: Array<Record<string, any>>;
  extra: Record<string, any>;
  final_metrics?: Record<string, any>;
  subagent_trajectories?: PublishedTrajectory[];
}

function publish(
  fixture: DagFixture, options: { dag?: AttemptDag; links?: Array<{ callId: string; threadId: string }> } = {},
): PublishedTrajectory {
  const outputPath = path.join(fixture.root, 'trajectory.json');
  mergeTrajectory({
    trajectoryRoot: fixture.root,
    outputPath,
    attemptDag: options.dag ?? fixture.dag,
    ...(options.links ? { subagentLinks: options.links } : {}),
  });
  return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
}

/** Refusals are asserted BY CODE. A message is never matched — R-refusal, done_when (4). */
function refusalOf(run: () => unknown): TrajectoryMergeReason | 'no-refusal' {
  try {
    run();
  } catch (error) {
    return (error as { reason: TrajectoryMergeReason }).reason;
  }
  return 'no-refusal';
}

function refusalFor(
  fixture: DagFixture, options: { dag?: AttemptDag; links?: Array<{ callId: string; threadId: string }> } = {},
): TrajectoryMergeReason | 'no-refusal' {
  return refusalOf(() => publish(fixture, options));
}

/** Number of `subagent_trajectories` hops from the root to the deepest leaf. */
function nestingDepth(trajectory: PublishedTrajectory): number {
  const children = trajectory.subagent_trajectories ?? [];
  if (children.length === 0) return 0;
  return 1 + Math.max(...children.map(nestingDepth));
}

function byId(trajectory: PublishedTrajectory, id: string): PublishedTrajectory | undefined {
  if (trajectory.trajectory_id === id) return trajectory;
  for (const child of trajectory.subagent_trajectories ?? []) {
    const found = byId(child, id);
    if (found) return found;
  }
  return undefined;
}

function trajectoryIds(trajectory: PublishedTrajectory): string[] {
  return [
    trajectory.trajectory_id,
    ...(trajectory.subagent_trajectories ?? []).flatMap(trajectoryIds),
  ];
}

function withIdentity(dag: AttemptDag, identity: Record<string, string>): AttemptDag {
  return { ...dag, identity: { model_execution_identity_hash: identity } };
}

// -------------------------------------------------------------------------------------------
// M3 / M-16 — the merge recurses over the DAG
// -------------------------------------------------------------------------------------------

describe('§9.3 M3 — buildTrajectory recurses, passing each node its own link map', () => {
  it('nests to the DAG full depth: the manager tree reaches depth 3, not depth 1', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const trajectory = publish(fixture);

    // Depth 2 alone would not prove recursion (done_when 1), so the assertion is >= 3 and the
    // exact leaf is named: gg1 is only reachable through c1 -> g1 -> gg1.
    expect(nestingDepth(trajectory)).toBeGreaterThanOrEqual(3);
    expect(trajectoryIds(trajectory).sort()).toEqual(['c1', 'c2', 'g1', 'gg1', 'run-001']);
    expect(byId(trajectory, 'c1')!.subagent_trajectories!.map(child => child.trajectory_id))
      .toEqual(['g1']);
    expect(byId(trajectory, 'g1')!.subagent_trajectories!.map(child => child.trajectory_id))
      .toEqual(['gg1']);
    expect(byId(trajectory, 'gg1')!.subagent_trajectories).toBeUndefined();
  });

  it('gives a NON-ROOT node its own link map, so a grandchild reference survives', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const trajectory = publish(fixture, {
      links: [{ callId: MANAGER_TREE_CALL_ID, threadId: 'g1' }],
    });

    expect(trajectory.extra.subagent_link_source).toBe('explicit');
    const child = byId(trajectory, 'c1')!;
    const results = child.steps.flatMap(step => step.observation?.results ?? []);
    const linked = results.find(item => item.source_call_id === MANAGER_TREE_CALL_ID);
    // An empty map handed to the child — the shipped `new Map()` at `atif.ts:303` — publishes
    // `null` here and silently loses the edge.
    expect(linked.subagent_trajectory_ref).toEqual([{ trajectory_id: 'g1' }]);
  });

  it('refuses an explicit link that does not resolve to a DAG child of its own node', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    expect(refusalFor(fixture, { links: [{ callId: MANAGER_TREE_CALL_ID, threadId: 'c2' }] }))
      .toBe('unresolvable_subagent_link');
  });
});

// -------------------------------------------------------------------------------------------
// §9.4 C7 vs M-16 — the two mode-specific tree-shape checks, satisfied by one recursion
// -------------------------------------------------------------------------------------------

describe('§9.4 C7 and M-16 are per-mode checks, both met by the same recursion', () => {
  it('C7: a coder-review DAG publishes EXACTLY one subagent_trajectories level', () => {
    const fixture = writeCoderReviewFixture(makeRoot());
    const trajectory = publish(fixture, {
      links: [{ callId: 'call-a', threadId: 'a' }, { callId: 'call-b', threadId: 'b' }],
    });

    expect(nestingDepth(trajectory)).toBe(1);
    expect(trajectory.extra.subagent_link_source).toBe('explicit');
    expect(trajectory.subagent_trajectories!.map(child => child.trajectory_id)).toEqual(['a', 'b']);
    for (const child of trajectory.subagent_trajectories!) {
      expect(Object.hasOwn(child, 'subagent_trajectories')).toBe(false);
    }
  });
});

// -------------------------------------------------------------------------------------------
// M4 — identity is an INDEXING operation on the role-indexed map (design B-1)
// -------------------------------------------------------------------------------------------

describe('§9.3 M4 — the merge indexes identity.model_execution_identity_hash BY ROLE', () => {
  it('a role ABSENT from the frozen map is identity_hash_drift', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const identity = { ...fixture.dag.identity.model_execution_identity_hash };
    delete identity['benchmark-fixer'];

    // Every fragment still carries the parent's MEIH, so the shipped parent-equality check
    // (`trajectory-merge.ts:236-245`) ACCEPTS this input. Only an indexing read refuses it.
    expect(refusalFor(fixture, { dag: withIdentity(fixture.dag, identity) }))
      .toBe('identity_hash_drift');
  });

  it("an attempt whose MEIH differs from ITS ROLE'S entry is identity_hash_drift", () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    setModelIdentity(fixture.journals.get(attemptIdOf('g1'))!, '7'.repeat(64));
    expect(refusalFor(fixture)).toBe('identity_hash_drift');
  });

  it('accepts a HETEROGENEOUS role model frozen in policy (plan:222)', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const reviewerHash = '8'.repeat(64);
    setModelIdentity(fixture.journals.get(attemptIdOf('g1'))!, reviewerHash);
    const identity = {
      ...fixture.dag.identity.model_execution_identity_hash,
      'benchmark-reviewer': reviewerHash,
    };

    // The decisive case: parent-equality REFUSES this legal arm, role-indexing accepts it. A test
    // suite without it cannot tell the two readings apart, because a constant map makes them agree.
    const trajectory = publish(fixture, { dag: withIdentity(fixture.dag, identity) });
    expect(byId(trajectory, 'g1')!.extra.model_execution_identity_hash).toBe(reviewerHash);
  });
});

// -------------------------------------------------------------------------------------------
// M2 — partition by the DAG, not by `thread_id === null`
// -------------------------------------------------------------------------------------------

describe('§9.3 M2 — fragments partition by roots.parent_attempt_id and recurse', () => {
  it('roots the walk at roots.parent_attempt_id, not at the null-thread fragment', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const reRooted: AttemptDag = {
      ...fixture.dag, roots: { parent_attempt_id: attemptIdOf('c1') },
    };

    // Rooted at c1 the parent process and c2 fall outside the DAG. The flat
    // `thread_id === null` rule would pick the parent process and merge all five happily.
    expect(refusalFor(fixture, { dag: reRooted })).toBe('unresolvable_subagent_link');
  });

  it('refuses a declared attempt that no edge reaches from the root', () => {
    const root = makeRoot();
    const specs = managerTreeSpecs();
    const edges = managerTreeEdges().filter(edge => (
      !(edge.kind === 'spawn' && edge.to.ref === 'attempt' && edge.to.id === attemptIdOf('c2'))
    ));
    const fixture = writeDagFixture(root, specs, edges);
    expect(refusalFor(fixture)).toBe('unresolvable_subagent_link');
  });

  it('refuses one attempt claimed as a child by two parents', () => {
    const root = makeRoot();
    const edges: AttemptEdge[] = [
      ...managerTreeEdges(),
      {
        kind: 'spawn',
        from: { ref: 'attempt', id: attemptIdOf('c2') },
        to: { ref: 'attempt', id: attemptIdOf('gg1') },
      },
    ];
    const fixture = writeDagFixture(root, managerTreeSpecs(), edges);
    expect(refusalFor(fixture)).toBe('ambiguous_subagent_link');
  });
});

// -------------------------------------------------------------------------------------------
// M7 — completeness generalised to DAG nodes <-> lifecycle pairs, both refusals NAMED
// -------------------------------------------------------------------------------------------

describe('§9.3 M7 — every unaccounted attempt gets a NAMED refusal', () => {
  it('a DAG node with no lifecycle pair is missing_child_fragment', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    removeFragment(fixture.journals.get(attemptIdOf('gg1'))!);
    expect(refusalFor(fixture)).toBe('missing_child_fragment');
  });

  it('a lifecycle pair with no DAG node is unbound_child_fragment', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const undeclared: AttemptDag = {
      ...fixture.dag,
      nodes: fixture.dag.nodes.filter(node => node.attempt_id !== attemptIdOf('c2')),
      edges: fixture.dag.edges.filter(edge => (
        !(edge.to.ref === 'attempt' && edge.to.id === attemptIdOf('c2'))
      )),
    };
    expect(refusalFor(fixture, { dag: undeclared })).toBe('unbound_child_fragment');
  });

  it('an edge reaching an attempt the manifest never declares is missing_child_fragment', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const undeclaredNode: AttemptDag = {
      ...fixture.dag,
      nodes: fixture.dag.nodes.filter(node => node.attempt_id !== attemptIdOf('gg1')),
    };
    expect(refusalFor(fixture, { dag: undeclaredNode })).toBe('missing_child_fragment');
  });

  it('a malformed fragment still refuses as malformed_fragment', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    setTerminalField(fixture.journals.get(attemptIdOf('g1'))!, 'journal_path', 'elsewhere.ndjson');
    expect(refusalFor(fixture)).toBe('malformed_fragment');
  });

  it('mints no new failure code: the taxonomy is still closed at its shipped thirteen', () => {
    expect(SHIPPED_REASONS.length).toBe(13);
    const fixture = writeManagerTreeFixture(makeRoot());
    removeFragment(fixture.journals.get(attemptIdOf('gg1'))!);
    expect(SHIPPED_REASONS as readonly string[]).toContain(refusalFor(fixture));
  });
});

// -------------------------------------------------------------------------------------------
// M5 / M6 / M8 / M9 — the shipped checks, applied to every node of the DAG
// -------------------------------------------------------------------------------------------

describe('§9.3 M5/M6/M8/M9 generalise to the DAG without changing semantics', () => {
  it('M6: totals are summed RECURSIVELY, so a depth-3 leaf is inside the aggregate', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const trajectory = publish(fixture);

    // Root + direct children alone would give 1600/160/16, which is a DIFFERENT number.
    expect(trajectory.final_metrics).toEqual({
      total_prompt_tokens: fixture.totals.prompt,
      total_completion_tokens: fixture.totals.completion,
      total_cached_tokens: fixture.totals.cached,
      total_cost_usd: fixture.totals.cost,
      total_steps: fixture.totals.steps,
      extra: {
        prompt_tokens_definition:
          'input_tokens + cache_creation_input_tokens + cache_read_input_tokens',
        cached_tokens_definition: 'cache_read_input_tokens',
      },
    });
    expect(fixture.totals.prompt).toBe(1_000 + 200 + 400 + 40 + 8);
  });

  it('M6: a node with no cost_record is aggregate_metrics_underivable at any depth', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    removeFirstEvent(fixture.journals.get(attemptIdOf('gg1'))!, 'cost_record');
    expect(refusalFor(fixture)).toBe('aggregate_metrics_underivable');
  });

  it('M5: containment is checked on a DEPTH-3 node, not only on the root', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    setSupervisor(fixture.journals.get(attemptIdOf('gg1'))!, false, 1);
    expect(refusalFor(fixture)).toBe('containment_failure');
  });

  it('M8: snapshot validation is run for a DEPTH-3 node, not only for the root', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    setTerminalField(fixture.journals.get(attemptIdOf('gg1'))!, 'event_count', 99);
    expect(refusalFor(fixture)).toBe('malformed_fragment');
  });

  it('M9: publication is unchanged — a pre-existing output is output_path_exists', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    fs.writeFileSync(path.join(fixture.root, 'trajectory.json'), 'occupied\n');
    expect(refusalFor(fixture)).toBe('output_path_exists');
  });

  it('a depth-3 tree still passes Harbor 0.20.0 authoritative validation', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const outputPath = path.join(fixture.root, 'trajectory.json');
    mergeTrajectory({
      trajectoryRoot: fixture.root, outputPath, attemptDag: fixture.dag,
    });
    const result = spawnSync('python3', ['scripts/validate-atif.py', '--trajectory-file', '-'], {
      cwd: AGENT_SERVER_ROOT, encoding: 'utf8', input: fs.readFileSync(outputPath),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      errors: [],
      validator: 'harbor.utils.trajectory_validator.TrajectoryValidator',
      harbor_version: '0.20.0',
    });
  }, 300_000);

  it('publishes byte-identical output for identical DAG input', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const first = path.join(fixture.root, 'a.json');
    const second = path.join(fixture.root, 'b.json');
    const one = mergeTrajectory({
      trajectoryRoot: fixture.root, outputPath: first, attemptDag: fixture.dag,
    });
    const two = mergeTrajectory({
      trajectoryRoot: fixture.root, outputPath: second, attemptDag: fixture.dag,
    });
    expect(two.sha256).toBe(one.sha256);
    expect(fs.readFileSync(second)).toEqual(fs.readFileSync(first));
  });
});

// -------------------------------------------------------------------------------------------
// Wave-2 shape preservation (done_when 7)
// -------------------------------------------------------------------------------------------

describe('the frozen wave-2 attempt shape survives this wave', () => {
  it('every attempt node the recursion consumes satisfies the D-NULL3 biconditional', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    expect(fixture.dag.nodes.length).toBe(5);
    for (const node of fixture.dag.nodes) {
      expect(threadScopedIdentityHolds(node), node.attempt_id).toBe(true);
      expect(node.dispatch_generation).toBeNull();
    }
  });

  it('reports every merged fragment, parent first, in DAG pre-order', () => {
    const fixture = writeManagerTreeFixture(makeRoot());
    const result = mergeTrajectory({
      trajectoryRoot: fixture.root,
      outputPath: path.join(fixture.root, 'trajectory.json'),
      attemptDag: fixture.dag,
    });
    expect(result.fragments.map(fragment => fragment.thread_id))
      .toEqual([null, 'c1', 'g1', 'gg1', 'c2']);
    expect(result.trajectoryId).toBe('run-001');
  });
});
