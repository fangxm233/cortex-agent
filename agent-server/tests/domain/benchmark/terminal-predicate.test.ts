// input:  §9.4's mode checklists, per-attempt journal events and the published ATIF facts
// output: proof that D2/C7 are EVALUATED, that the census is load-bearing, and that code 41 fires
// pos:    §9.4 terminal predicate contract tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { it } from 'vitest';

import type { NormalizedEvent } from '../../../src/agent-adapter/normalize/event-types.js';
import { BENCHMARK_FAILURES } from '../../../src/domain/benchmark/resolved-policy.js';
import type { AttemptEdge } from '../../../src/domain/benchmark/attempt-record.js';
import {
  assertTerminalPredicate,
  evaluateTerminalChecks,
  nativeSubagentCensus,
  TerminalPredicateError,
  TERMINAL_PREDICATE_UNMET_CODE,
  type AttemptJournal,
  type PublishedAtifFacts,
  type TerminalCheckInput,
} from '../../../src/domain/benchmark/terminal-predicate.js';

function toolUse(toolUseId: string, name: string): NormalizedEvent {
  return { type: 'tool_use', toolUseId, name, input: {} } as NormalizedEvent;
}

function activity(parentToolUseId: string): NormalizedEvent {
  return {
    type: 'subagent_activity', parentToolUseId, subagentType: null, kind: 'assistant',
  } as NormalizedEvent;
}

function journal(attempt_id: string, events: NormalizedEvent[]): AttemptJournal {
  return { attempt_id, events };
}

function assertIsPredicateError(error: unknown): asserts error is TerminalPredicateError {
  if (!(error instanceof TerminalPredicateError)) throw new Error('expected a predicate refusal');
}

const ONE_NODE = [{ attempt_id: 'run-r1' }] as unknown as TerminalCheckInput['nodes'];
const TWO_NODES = [
  { attempt_id: 'run-r1' }, { attempt_id: 'thread-c1' },
] as unknown as TerminalCheckInput['nodes'];

function input(overrides: Partial<TerminalCheckInput> = {}): TerminalCheckInput {
  return {
    mode: 'direct',
    terminalState: 'completed',
    nodes: ONE_NODE,
    edges: [],
    attempts: [journal('run-r1', [])],
    atif: null,
    ...overrides,
  };
}

/** §9.6 A2's four operands as the shipped accumulator reports them; no row below reads them, which
 *  is the point — the checklist decides §9.4, the accounting decides §9.6. */
const METRICS: PublishedAtifFacts['finalMetrics'] = {
  total_prompt_tokens: 1010, total_completion_tokens: 22, total_cached_tokens: 15,
  total_cost_usd: 0.0035, total_steps: 2,
};

const EXPLICIT_ONE_LEVEL: PublishedAtifFacts = {
  subagentLevels: 1, linkSource: 'explicit', finalMetrics: METRICS,
};

// ── the census predicate itself (G4-SA12) ───────────────────────────────────────────────────

it('G4-SA12 — the census counts `Agent` AND `Task`, and attests through parentToolUseId', () => {
  const census = nativeSubagentCensus([
    toolUse('u1', 'Agent'), activity('u1'),
    toolUse('u2', 'Task'),
    toolUse('u3', 'Bash'),
  ]);
  // `Task` is counted: a census keyed on 'Agent' alone passes vacuously on the alias.
  assert.equal(census.calls, 2);
  assert.deepEqual(census.unattested, ['u2']);
});

it('G4-SA12 — a `Task`-aliased transcript is NOT vacuously clean', () => {
  const census = nativeSubagentCensus([toolUse('u1', 'Task')]);
  assert.equal(census.calls, 1);
  assert.deepEqual(census.unattested, ['u1']);
});

// ── D2 — three conjuncts, each evaluated separately ─────────────────────────────────────────

it('D2 — passes for a witnessed one-node zero-edge direct trial', () => {
  const checks = evaluateTerminalChecks(input());
  assert.deepEqual(Object.keys(checks), ['D2']);
  assert.equal(checks.D2.result, 'pass');
  assert.equal(checks.D2.detail, null);
});

it('D2 conjunct 1 — more than one node FAILS', () => {
  const checks = evaluateTerminalChecks(input({ nodes: TWO_NODES }));
  assert.equal(checks.D2.result, 'fail');
  assert.match(checks.D2.detail!, /2 nodes/);
});

it('D2 conjunct 2 — a descent edge FAILS', () => {
  const edges: AttemptEdge[] = [
    { kind: 'spawn', from: { ref: 'attempt', id: 'run-r1' }, to: { ref: 'attempt', id: 'thread-c1' } },
  ];
  const checks = evaluateTerminalChecks(input({ edges }));
  assert.equal(checks.D2.result, 'fail');
  assert.match(checks.D2.detail!, /spawn/);
});

it('D2 conjunct 3 — an UNATTESTED native subagent call FAILS (OC-11 invisibility closed)', () => {
  // The shape is otherwise perfect: one node, zero edges. Only the census sees the subagent.
  const checks = evaluateTerminalChecks(input({
    attempts: [journal('run-r1', [toolUse('u1', 'Agent')])],
  }));
  assert.equal(checks.D2.result, 'fail');
  assert.match(checks.D2.detail!, /u1/);
});

it('D2 conjunct 3 — the SAME shape with the call attested PASSES', () => {
  const checks = evaluateTerminalChecks(input({
    attempts: [journal('run-r1', [toolUse('u1', 'Agent'), activity('u1')])],
  }));
  assert.equal(checks.D2.result, 'pass');
});

// ── C7 — census + one level + explicit link source ──────────────────────────────────────────

it('C7 — passes only when all three conjuncts hold', () => {
  const checks = evaluateTerminalChecks(input({
    mode: 'coder-review', nodes: TWO_NODES, atif: EXPLICIT_ONE_LEVEL,
  }));
  assert.deepEqual(Object.keys(checks), ['C7']);
  assert.equal(checks.C7.result, 'pass');
});

it('C7 — an unattested call FAILS even with a perfect tree', () => {
  const checks = evaluateTerminalChecks(input({
    mode: 'coder-review', nodes: TWO_NODES, atif: EXPLICIT_ONE_LEVEL,
    attempts: [journal('run-r1', [toolUse('u1', 'Task')])],
  }));
  assert.equal(checks.C7.result, 'fail');
  assert.match(checks.C7.detail!, /u1/);
});

it('C7 — the wrong number of subagent levels FAILS', () => {
  const checks = evaluateTerminalChecks(input({
    mode: 'coder-review', nodes: TWO_NODES,
    atif: { ...EXPLICIT_ONE_LEVEL, subagentLevels: 2 },
  }));
  assert.equal(checks.C7.result, 'fail');
  assert.match(checks.C7.detail!, /2 subagent_trajectories levels/);
});

it('C7 — no published ATIF at all FAILS', () => {
  const checks = evaluateTerminalChecks(input({
    mode: 'coder-review', nodes: TWO_NODES, atif: null,
  }));
  assert.equal(checks.C7.result, 'fail');
});

it('C7 — a DERIVED link source FAILS the row (§9.3 M1)', () => {
  // This row previously read `unavailable`, on the ground that F7 had no link map independent of
  // the parent's own tool results and asserting `explicit` off those results would be circular.
  // That ground is gone: G4-PB8 (`design:8368`) rules that F8 passes the DAG's own link map through
  // `MergeTrajectoryOptions.subagentLinks`, and §9.3 M1 (`design:2715`) makes that map MANDATORY
  // in-trial with `collectThreadLinks` not consulted. A published `tool_result` source therefore
  // means the merge fell back to parsing model-produced text — the defect M1 removes, not an
  // undecided conjunct.
  const checks = evaluateTerminalChecks(input({
    mode: 'coder-review', nodes: TWO_NODES,
    atif: { ...EXPLICIT_ONE_LEVEL, linkSource: 'tool_result' },
  }));
  assert.equal(checks.C7.result, 'fail');
  assert.match(checks.C7.detail!, /tool_result, not explicit/);
});

it('C7 — the level and link-source conjuncts are reported SEPARATELY', () => {
  // One mutant that collapsed the two into a single check would still pass the two tests above.
  const checks = evaluateTerminalChecks(input({
    mode: 'coder-review', nodes: TWO_NODES,
    atif: { ...EXPLICIT_ONE_LEVEL, subagentLevels: 0, linkSource: 'tool_result' },
  }));
  assert.equal(checks.C7.result, 'fail');
  assert.match(checks.C7.detail!, /0 subagent_trajectories levels/);
  assert.match(checks.C7.detail!, /tool_result, not explicit/);
});

// ── the success-checklist guard ─────────────────────────────────────────────────────────────

it('a trial that never claimed success is scored against NO rows', () => {
  // §9.4 is a SUCCESS checklist: scoring a cancelled trial against it would convert its shipped
  // terminal classification into a code-41 refusal for a predicate it never asserted.
  assert.deepEqual(evaluateTerminalChecks(input({ terminalState: 'cancelled' })), {});
});

// ── code 41, asserted BY INTEGER ────────────────────────────────────────────────────────────

it('code 41 is the SHIPPED terminal_predicate_unmet, asserted by integer', () => {
  const shipped = BENCHMARK_FAILURES.find(f => f.reason === 'terminal_predicate_unmet');
  assert.equal(shipped!.code, 41);
  assert.equal(TERMINAL_PREDICATE_UNMET_CODE, 41);
  // 44 entries, enumerated rather than taken from prose.
  assert.equal(BENCHMARK_FAILURES.length, 44);
});

it('an EVALUATED failing row raises code 41 carrying the failing check ids', () => {
  let error: unknown;
  try {
    assertTerminalPredicate({
      mode: 'direct',
      checks: [
        { check_id: 'G1', result: 'unavailable', detail: 'not evaluated at this pin' },
        { check_id: 'D2', result: 'fail', detail: 'the DAG has 2 nodes, not exactly one' },
      ],
    });
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(error instanceof TerminalPredicateError, true);
  assertIsPredicateError(error);
  assert.equal(error.code, 41);
  assert.equal(error.reason, 'terminal_predicate_unmet');
  const record = error.record();
  assert.equal(record.code, 41);
  assert.deepEqual(record.unmet, ['D2']);
});

it('an UNAVAILABLE row is not a failure — it is a row this pin did not decide', () => {
  assert.doesNotThrow(() => assertTerminalPredicate({
    mode: 'coder-review',
    checks: [
      { check_id: 'C7', result: 'unavailable', detail: 'link source underivable' },
      { check_id: 'C1', result: 'pass', detail: null },
    ],
  }));
});
