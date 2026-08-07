// input:  the orchestration mode, the built attempt DAG, per-attempt journal events, published ATIF facts
// output: §9.4's evaluated checklist rows and the shipped code-41 refusal
// pos:    §9.4 per-mode terminal success checklist, evaluated at F7
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';
import { isNativeSubagentCall } from '../agent-run/trajectory-merge.js';
import type {
  AttemptEdge, AttemptEdgeKind, AttemptRecord, CompositeManifestPredicate, OrchestrationModeName,
  PredicateCheckResult,
} from './composite-manifest.js';
import { BENCHMARK_FAILURES, type BenchmarkFailureClass } from './resolved-policy.js';

/** No new failure code is allocated (§17 17.0): §9.4's refusal rides the SHIPPED 41. */
const TERMINAL_PREDICATE_UNMET = BENCHMARK_FAILURES
  .find(failure => failure.reason === 'terminal_predicate_unmet')!;

export const TERMINAL_PREDICATE_UNMET_CODE: number = TERMINAL_PREDICATE_UNMET.code;

export interface UnmetCheck {
  readonly check_id: string;
  readonly detail: string;
}

/**
 * §8.7 code 41, "any §9.4 check for the arm's mode evaluated `fail`; the failing check ids are
 * listed in the stderr JSON" (`design:2853`). Class R, so the refusal leaves its coded reason on
 * stderr as JSON exactly as the composite manifest's does.
 */
export class TerminalPredicateError extends Error {
  readonly reason = 'terminal_predicate_unmet' as const;
  readonly code: number = TERMINAL_PREDICATE_UNMET.code;
  readonly failureClass: BenchmarkFailureClass = TERMINAL_PREDICATE_UNMET.failureClass;

  constructor(readonly unmet: readonly UnmetCheck[]) {
    super(`terminal_predicate_unmet: ${unmet.map(entry => entry.check_id).join(',')}`);
    this.name = 'TerminalPredicateError';
  }

  record(): Record<string, unknown> {
    return {
      code: this.code,
      failure_class: this.failureClass,
      reason: this.reason,
      unmet: this.unmet.map(entry => entry.check_id),
      checks: this.unmet.map(entry => ({ check_id: entry.check_id, detail: entry.detail })),
    };
  }
}

export interface NativeSubagentCensus {
  /** Native subagent calls observed, keyed on `Agent` OR `Task` (G4-SA12). */
  readonly calls: number;
  /** The `toolUseId` of every native call no `subagent_activity` event attests. */
  readonly unattested: readonly string[];
}

/**
 * G4-SA13's obligation as a predicate over ONE attempt's journal events: for every `tool_use` whose
 * name is `Agent` or `Task`, at least one `subagent_activity` names it through `parentToolUseId`.
 *
 * The call predicate is IMPORTED from the merge rather than restated. A second copy of the census
 * key is exactly how the `Task` alias became invisible in the first place, and a copy would drift
 * silently the next time the CLI adds an alias.
 */
export function nativeSubagentCensus(
  events: readonly NormalizedEvent[],
): NativeSubagentCensus {
  const attested = new Set<string>();
  for (const event of events) {
    if (event.type === 'subagent_activity') attested.add(event.parentToolUseId);
  }
  const unattested: string[] = [];
  let calls = 0;
  for (const event of events) {
    if (!isNativeSubagentCall(event)) continue;
    calls += 1;
    if (!attested.has(event.toolUseId)) unattested.push(event.toolUseId);
  }
  return { calls, unattested };
}

export interface AttemptJournal {
  readonly attempt_id: string;
  readonly events: readonly NormalizedEvent[];
}

/** What the PUBLISHED ATIF document says about itself. `null` when F8 published none. */
export interface PublishedAtifFacts {
  /** Nesting depth of `subagent_trajectories`; 0 when the root has no children. */
  readonly subagentLevels: number;
  /** `atif.ts:366` — `'tool_result'` when the links were derived from the parent's own tool
   *  results, `'explicit'` when the caller supplied an independent link map. */
  readonly linkSource: string;
}

export interface TerminalCheckInput {
  readonly mode: OrchestrationModeName;
  /** The root attempt's terminal state. §9.4 is a SUCCESS checklist and its G1 requires
   *  `completed`; a trial that never claimed success has no success predicate to measure. */
  readonly terminalState: unknown;
  readonly nodes: readonly AttemptRecord[];
  readonly edges: readonly AttemptEdge[];
  readonly attempts: readonly AttemptJournal[];
  readonly atif: PublishedAtifFacts | null;
}

export type EvaluatedChecks = Record<string, {
  result: PredicateCheckResult;
  detail: string | null;
}>;

/** §9.4 D2's own words: "zero `spawn` / `dispatch` / `decompose` edges". */
const DESCENT_EDGE_KINDS = new Set<AttemptEdgeKind>(['spawn', 'dispatch', 'decompose']);

function censusFailures(attempts: readonly AttemptJournal[]): string[] {
  return attempts.flatMap(attempt => {
    const census = nativeSubagentCensus(attempt.events);
    return census.unattested.map(
      toolUseId => `${attempt.attempt_id}: native subagent call ${toolUseId} has no subagent_activity`,
    );
  });
}

/**
 * §9.4 D2, all THREE conjuncts evaluated SEPARATELY so a report names the one that failed: exactly
 * one node, zero descent edges, and — G4-SA13, the clause that makes D2's truth WITNESSED rather
 * than merely satisfied by invisibility — a complete native-subagent census.
 */
function evaluateD2(input: TerminalCheckInput): EvaluatedChecks[string] {
  const unmet: string[] = [];
  if (input.nodes.length !== 1) {
    unmet.push(`the DAG has ${input.nodes.length} nodes, not exactly one`);
  }
  const descent = input.edges.filter(edge => DESCENT_EDGE_KINDS.has(edge.kind));
  if (descent.length > 0) {
    unmet.push(`descent edges present: ${[...new Set(descent.map(e => e.kind))].sort().join(',')}`);
  }
  unmet.push(...censusFailures(input.attempts));
  return unmet.length === 0
    ? { result: 'pass', detail: null }
    : { result: 'fail', detail: unmet.join('; ') };
}

/**
 * §9.4 C7 as (17.5.8) restates it: "one trajectory level AND a complete native-subagent census",
 * over C7's own literal text — "exactly one `subagent_trajectories` level and its link source is
 * `explicit`". Three conjuncts, and they do NOT all resolve the same way:
 *
 * - census and level count are decidable here and FAIL the row when unmet;
 * - `linkSource === 'explicit'` is decidable but is a property of how F8 was CALLED, not of the
 *   trial. This pin has no link map independent of the parent's own tool results, so the merge
 *   derives them and reports `tool_result` (`trajectory-merge.ts:635,887`). Supplying those same
 *   derived links back as `subagentLinks` would relabel them `explicit` while proving nothing —
 *   circular, and precisely the self-attestation this gate exists to refuse.
 *
 * So an unmet link-source conjunct makes the row UNAVAILABLE, never `pass` (a lie about a conjunct
 * nobody satisfied) and never `fail` (which would refuse every coder-review trial for a gap Gate 6
 * owns). The measured value is carried in the detail so the shortfall is legible.
 */
function evaluateC7(input: TerminalCheckInput): EvaluatedChecks[string] {
  const unmet = censusFailures(input.attempts);
  if (input.atif === null) unmet.push('no ATIF trajectory was published');
  else if (input.atif.subagentLevels !== 1) {
    unmet.push(`the ATIF tree has ${input.atif.subagentLevels} subagent_trajectories levels, not one`);
  }
  if (unmet.length > 0) return { result: 'fail', detail: unmet.join('; ') };
  if (input.atif!.linkSource !== 'explicit') {
    return {
      result: 'unavailable',
      detail: `census complete and one subagent level, but the link source is `
        + `${input.atif!.linkSource}, not explicit`,
    };
  }
  return { result: 'pass', detail: null };
}

/**
 * Only the rows this pin can actually decide are returned. Every §9.4 id left out is recorded
 * UNAVAILABLE by `buildCompositeManifest`, never `pass`.
 */
export function evaluateTerminalChecks(input: TerminalCheckInput): EvaluatedChecks {
  // §9.4 G1 requires `state = 'completed'` before any row is meaningful, and §9.4 is titled a
  // SUCCESS checklist. Scoring a cancelled or timed-out trial against it would convert its shipped
  // terminal classification into a code-41 refusal for a predicate it never asserted.
  if (input.terminalState !== 'completed') return {};
  if (input.mode === 'direct') return { D2: evaluateD2(input) };
  if (input.mode === 'coder-review') return { C7: evaluateC7(input) };
  return {};
}

/**
 * §9.5's grader-admission rule, in the only direction F8 can enforce: a checklist carrying a row
 * that was EVALUATED and FAILED is `terminal_predicate_unmet`. An `unavailable` row is not a
 * failure — it is a row this pin did not decide, and treating it as one would refuse every trial.
 */
export function assertTerminalPredicate(predicate: CompositeManifestPredicate): void {
  const unmet = predicate.checks
    .filter(check => check.result === 'fail')
    .map(check => ({ check_id: check.check_id, detail: check.detail ?? '' }));
  if (unmet.length > 0) throw new TerminalPredicateError(unmet);
}
