// input:  journals carrying native-subagent census events under Agent/Task calls
// output: OC-11 option (ii) derivation, census-refusal and publication proofs
// pos:    §17 (17.5) G4-SA8-SA12 native-subagent accounting suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. Every case runs the production `mergeTrajectory` over on-disk journals written by the
// shared fixtures; nothing test-supplied stands in for production composition. The census events
// are INPUT DATA in the exact shape `adapter.ts` emits (`event-types.ts` `subagent_activity`).
//
// TWO journal shapes appear here, deliberately. `censusEvents` is the MINIMAL shape (a call, its
// census events, its result). `interleavedSubagentEvents` is the FULL PRODUCTION shape, in which
// the subagent's own `assistant_text` and `tool_result` events also land between the `Agent`/`Task`
// call and that call's result, exactly as the adapter emits them (proved by
// `tests/agent-adapter/claude-subagent-activity.test.ts`, which asserts a subagent line still
// reaches `onAssistantMessage`/`onToolUse`). The minimal shape alone would let an ATIF grouping
// defect through, so the derivation is asserted against BOTH.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isNativeSubagentCall,
  mergeTrajectory,
  TrajectoryMergeError,
  type TrajectoryMergeReason,
} from '../../../src/domain/agent-run/trajectory-merge.js';
import {
  accountingEvents, corruptJournalBytes, removeFragment, writeJournal,
  type EventSpec, type FixtureJournal,
} from './trajectory-merge-fixtures.js';
import {
  attemptIdOf, managerTreeEdges, managerTreeSpecs, writeDagFixture,
  type AttemptSpec, type DagFixture,
} from './atif-dag-fixtures.js';

/** The refusal is named against the shipped union member, never against a message string. */
const UNDERIVABLE = 'aggregate_metrics_underivable' satisfies TrajectoryMergeReason;
const MALFORMED = 'malformed_fragment' satisfies TrajectoryMergeReason;
const MISSING_CHILD = 'missing_child_fragment' satisfies TrajectoryMergeReason;

const AGENT_SERVER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-subagent-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface CensusSpec {
  callId: string;
  /** The literal the model emitted. `Agent` and `Task` are two CLI aliases for one tool. */
  toolName?: string;
  assistantLines?: number;
  toolResultLines?: number;
  subagentType?: string | null;
  agentSlot?: EventSpec['agentSlot'];
}

/** One `Agent`/`Task` call and the census events its subagent produced, in wire order: the call,
 *  then the subagent's lines, then the call's own result. */
function censusEvents(spec: CensusSpec): EventSpec[] {
  const agentSlot = spec.agentSlot ?? 'parent';
  const shared = { ts: '2026-08-01T00:00:02.000Z', step: null, agentSlot } as const;
  const activity = (kind: 'assistant' | 'tool_result') => ({
    ...shared,
    event: {
      type: 'subagent_activity', parentToolUseId: spec.callId,
      subagentType: spec.subagentType === undefined ? 'explore' : spec.subagentType, kind,
    },
  });
  return [
    { ...shared, event: {
      type: 'tool_use', toolUseId: spec.callId, name: spec.toolName ?? 'Agent',
      input: { prompt: 'go' },
    } },
    ...Array.from({ length: spec.assistantLines ?? 0 }, () => activity('assistant')),
    ...Array.from({ length: spec.toolResultLines ?? 0 }, () => activity('tool_result')),
    { ...shared, event: {
      type: 'tool_result', toolUseId: spec.callId, ok: true, content: 'subagent done',
    } },
  ];
}

function writeParentJournal(root: string, events: EventSpec[]): FixtureJournal {
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  return writeJournal(root, {
    threadId: null, agentSlot: 'parent', roleHash: '2'.repeat(64),
    events: [
      ...events,
      ...accountingEvents({
        ts: '2026-08-01T00:00:04.000Z', step: null, agentSlot: 'parent',
        prompt: 800, completion: 80, cached: 200, cost: 0.08, turns: 1,
      }),
    ],
  });
}

function publishParent(root: string, events: EventSpec[]): any {
  writeParentJournal(root, events);
  const outputPath = path.join(root, 'trajectory.json');
  mergeTrajectory({ trajectoryRoot: root, outputPath });
  return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
}

function refusalOf(run: () => unknown): TrajectoryMergeReason | 'no-refusal' {
  try {
    run();
    return 'no-refusal';
  } catch (error) {
    if (error instanceof TrajectoryMergeError) return error.reason;
    throw error;
  }
}

describe('G4-SA12 — the census key is Agent OR Task', () => {
  it('exports the census predicate, and it matches both aliases and nothing else', () => {
    expect(isNativeSubagentCall({ type: 'tool_use', toolUseId: 'a', name: 'Agent', input: {} }))
      .toBe(true);
    expect(isNativeSubagentCall({ type: 'tool_use', toolUseId: 'a', name: 'Task', input: {} }))
      .toBe(true);
    expect(isNativeSubagentCall({ type: 'tool_use', toolUseId: 'a', name: 'Bash', input: {} }))
      .toBe(false);
    expect(isNativeSubagentCall({ type: 'tool_result', toolUseId: 'a', ok: true, content: 'Agent' }))
      .toBe(false);
  });

  it('derives an identical census from the Task alias and from Agent', () => {
    const viaAgent = publishParent(makeRoot(), censusEvents({
      callId: 'call-1', toolName: 'Agent', assistantLines: 3, toolResultLines: 2,
    }));
    const viaTask = publishParent(makeRoot(), censusEvents({
      callId: 'call-1', toolName: 'Task', assistantLines: 3, toolResultLines: 2,
    }));
    expect(viaTask.final_metrics).toEqual(viaAgent.final_metrics);
    expect(viaTask.final_metrics.extra.subagent_turns).toBe(3);
  });

  // A census keyed on 'Agent' alone passes vacuously here: it sees no Agent call, so it never
  // notices that the Task call's subagent went unattributed.
  it('refuses a Task call with an empty census, exactly as it refuses an Agent call', () => {
    expect(refusalOf(() => publishParent(makeRoot(), censusEvents({
      callId: 'call-1', toolName: 'Task',
    })))).toBe(UNDERIVABLE);
    expect(refusalOf(() => publishParent(makeRoot(), censusEvents({
      callId: 'call-1', toolName: 'Agent',
    })))).toBe(UNDERIVABLE);
  });
});

describe('G4-SA10 — a zero census refuses to guess', () => {
  it('raises aggregate_metrics_underivable and publishes nothing', () => {
    const root = makeRoot();
    writeParentJournal(root, censusEvents({ callId: 'call-1' }));
    const outputPath = path.join(root, 'trajectory.json');
    let raised: unknown;
    try {
      mergeTrajectory({ trajectoryRoot: root, outputPath });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(TrajectoryMergeError);
    expect((raised as TrajectoryMergeError).reason).toBe(UNDERIVABLE);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('does not confuse another call id for the missing one', () => {
    const events = [
      ...censusEvents({ callId: 'call-1', assistantLines: 2 }),
      ...censusEvents({ callId: 'call-2' }),
    ];
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(UNDERIVABLE);
  });

  it('leaves a journal with no Agent/Task call alone', () => {
    const trajectory = publishParent(makeRoot(), [
      { ts: '2026-08-01T00:00:02.000Z', step: null, agentSlot: 'parent', event: {
        type: 'tool_use', toolUseId: 'bash-1', name: 'Bash', input: { command: 'true' },
      } },
      { ts: '2026-08-01T00:00:03.000Z', step: null, agentSlot: 'parent', event: {
        type: 'tool_result', toolUseId: 'bash-1', ok: true, content: 'ok',
      } },
    ]);
    expect(trajectory.final_metrics.extra.subagent_turns).toBe(0);
  });
});

describe('G4-SA8 — the derived total is distinct from the parent step total', () => {
  it('counts one turn per assistant-kind census event and leaves total_steps alone', () => {
    const trajectory = publishParent(makeRoot(), censusEvents({
      callId: 'call-1', assistantLines: 3, toolResultLines: 2,
    }));
    expect(trajectory.final_metrics.total_steps).toBe(1);
    expect(trajectory.final_metrics.extra.subagent_turns).toBe(3);
  });

  it('never counts a tool_result-kind census event as a turn', () => {
    const trajectory = publishParent(makeRoot(), censusEvents({
      callId: 'call-1', assistantLines: 0, toolResultLines: 4,
    }));
    expect(trajectory.final_metrics.extra.subagent_turns).toBe(0);
    expect(trajectory.final_metrics.total_steps).toBe(1);
  });
});

describe('G4-SA9 — turn_progress stays unconsumed', () => {
  it('publishes identical metrics with and without turn_progress events', () => {
    const base = censusEvents({ callId: 'call-1', assistantLines: 2 });
    const withProgress: EventSpec[] = [
      ...base,
      { ts: '2026-08-01T00:00:03.000Z', step: null, agentSlot: 'parent', event: {
        type: 'turn_progress', numTurns: 97,
      } },
      { ts: '2026-08-01T00:00:03.500Z', step: null, agentSlot: 'parent', event: {
        type: 'turn_progress', numTurns: 98,
      } },
    ];
    const plain = publishParent(makeRoot(), base);
    const noisy = publishParent(makeRoot(), withProgress);
    expect(noisy.final_metrics).toEqual(plain.final_metrics);
    expect(noisy.final_metrics.extra.subagent_turns).toBe(2);
  });
});

describe('G4-SA11 — publication', () => {
  it('passes Harbor 0.20.0 authoritative validation with census events present', () => {
    const root = makeRoot();
    writeParentJournal(root, censusEvents({
      callId: 'call-1', assistantLines: 2, toolResultLines: 1,
    }));
    const outputPath = path.join(root, 'trajectory.json');
    mergeTrajectory({ trajectoryRoot: root, outputPath });
    const result = spawnSync('python3', ['scripts/validate-atif.py', '--trajectory-file', '-'], {
      cwd: AGENT_SERVER_ROOT, encoding: 'utf8', input: fs.readFileSync(outputPath),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });
});

/**
 * The FULL production wire shape for one native-subagent call, in the order the adapter journals
 * it: the `Agent`/`Task` call, then the subagent's own output (its text and its tool results, which
 * D-ADDITIVE keeps flowing to the existing handlers) interleaved with the census events, then the
 * call's own result. Mirrors `agent-run-e2e-fixture.ts`'s `FAKE_CLAUDE_SUBAGENT` lines.
 */
function interleavedSubagentEvents(callId: string, toolName = 'Task'): EventSpec[] {
  const shared = { ts: '2026-08-01T00:00:02.000Z', step: null, agentSlot: 'parent' } as const;
  const activity = (kind: 'assistant' | 'tool_result') => ({
    ...shared,
    event: {
      type: 'subagent_activity', parentToolUseId: callId, subagentType: 'explore', kind,
    },
  });
  return [
    { ...shared, event: { type: 'tool_use', toolUseId: callId, name: toolName, input: { prompt: 'go' } } },
    { ...shared, event: { type: 'assistant_text', text: 'subagent speaking' } },
    activity('assistant'),
    { ...shared, event: { type: 'tool_result', toolUseId: 'sub-call-1', ok: true, content: 'sub ok' } },
    activity('tool_result'),
    { ...shared, event: { type: 'tool_result', toolUseId: callId, ok: true, content: 'agent done' } },
  ];
}

describe('the production wire shape publishes', () => {
  it('derives the census from a journal the adapter would really write', () => {
    const trajectory = publishParent(makeRoot(), interleavedSubagentEvents('toolu_agent_1'));
    expect(trajectory.final_metrics.extra.subagent_turns).toBe(1);
    expect(trajectory.final_metrics.total_steps).toBe(1);
    // The subagent's own text is still carried, through the existing members and not the census.
    const carried = JSON.stringify(trajectory.steps);
    expect(carried).toContain('subagent speaking');
  });

  // PINS THE ATTESTATION GATE ITSELF. This is an ORDINARY tool call — no census attests it — with
  // content interleaved before its result. Absorbing that would be a real loosening of
  // `unpaired_tool_result`, so the grouper must still break, orphan the result and refuse. Delete
  // the `openSubagentCalls.size === 0` guard and this test publishes instead of refusing.
  it('keeps unpaired_tool_result strict when no census attests the open call', () => {
    const shared = { ts: '2026-08-01T00:00:02.000Z', step: null, agentSlot: 'parent' } as const;
    const events: EventSpec[] = [
      { ...shared, event: { type: 'tool_use', toolUseId: 'bash-1', name: 'Bash', input: {} } },
      { ...shared, event: { type: 'assistant_text', text: 'interleaved, unattested' } },
      { ...shared, event: { type: 'tool_result', toolUseId: 'bash-1', ok: true, content: 'ok' } },
    ];
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(MALFORMED);
  });

  // PINS THE OTHER HALF OF THE GATE: absorption must STOP at the attested call's own result. Here
  // the span closes cleanly, so a LATER orphaned `tool_result` lies outside it and must still be
  // caught. Make `openSubagentCalls.delete(result.toolUseId)` a no-op and the span never closes,
  // this orphan is swallowed, and the journal publishes instead of refusing.
  it('stops absorbing at the attested call result, so a later orphan still refuses', () => {
    const shared = { ts: '2026-08-01T00:00:03.000Z', step: null, agentSlot: 'parent' } as const;
    const events: EventSpec[] = [
      ...interleavedSubagentEvents('toolu_agent_1'),
      { ...shared, event: { type: 'tool_use', toolUseId: 'bash-1', name: 'Bash', input: {} } },
      { ...shared, event: { type: 'tool_result', toolUseId: 'bash-1', ok: true, content: 'ok' } },
      { ...shared, event: {
        type: 'tool_result', toolUseId: 'never-called', ok: true, content: 'orphan',
      } },
    ];
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(MALFORMED);
  });

  it('still refuses the production shape when the census is empty', () => {
    const events = interleavedSubagentEvents('toolu_agent_1')
      .filter(spec => (spec.event as { type: string }).type !== 'subagent_activity');
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(UNDERIVABLE);
  });
});

// --- F9: the attested span is BOUNDED (the absorption ends at the call's own result or refuses) ---

const SHARED = { ts: '2026-08-01T00:00:02.000Z', step: null, agentSlot: 'parent' } as const;

function use(toolUseId: string, name: string): EventSpec {
  return { ...SHARED, event: { type: 'tool_use', toolUseId, name, input: {} } };
}

function result(toolUseId: string): EventSpec {
  return { ...SHARED, event: { type: 'tool_result', toolUseId, ok: true, content: 'ok' } };
}

/** One census event, i.e. the attestation that opens the absorption span for `callId`. */
function census(callId: string, kind: 'assistant' | 'tool_result' = 'assistant'): EventSpec {
  return { ...SHARED, event: {
    type: 'subagent_activity', parentToolUseId: callId, subagentType: 'explore', kind,
  } };
}

describe('F9 — an attested span left open at fragment end refuses instead of absorbing', () => {
  // THE DEFECT ITSELF. An `Agent`/`Task` call that never closes used to absorb the rest of the
  // fragment AS RAW RECORDS, so the absorbed `tool_use` events never re-entered `collectToolUses`
  // and `duplicate_tool_call_id` (`atif.ts:158`) never saw the duplicate. A journal the base
  // REFUSED then published. Remove the fragment-end bound and this test publishes 1 step carrying
  // `tool_call_ids=[toolu_agent_1, bash-1, bash-1]`.
  it('refuses a duplicate tool_use id inside an UNCLOSED attested span', () => {
    const events: EventSpec[] = [
      use('toolu_agent_1', 'Task'),
      census('toolu_agent_1'),
      use('bash-1', 'Bash'),
      use('bash-1', 'Bash'),
      result('bash-1'),
      // NO tool_result for toolu_agent_1 — the cut-short-trial case.
    ];
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(MALFORMED);
  });

  // The control that proves the guard, not the bound, is what the row above is about: the same
  // duplicate with no attested span anywhere refuses at the base and must keep refusing.
  it('refuses the same duplicate with no attested span at all', () => {
    const events: EventSpec[] = [use('bash-1', 'Bash'), use('bash-1', 'Bash'), result('bash-1')];
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(MALFORMED);
  });

  // THE BOUND ON ITS OWN, with nothing else wrong. Absorption may only run to the attested call's
  // own result; reaching the end of the fragment with the span still open means the journal never
  // said where the subagent's output stopped, so §9.6 A2 refuses rather than guessing a boundary.
  it('refuses an unclosed attested span even when nothing else is malformed', () => {
    const events: EventSpec[] = [use('toolu_agent_1', 'Task'), census('toolu_agent_1')];
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(MALFORMED);
  });

  // G-C `unpaired_tool_result` (`atif.ts:181`) under an unclosed span: the orphan used to be
  // absorbed to fragment end and published. It must refuse.
  it('refuses an unpaired tool_result an unclosed span would have swallowed', () => {
    const events: EventSpec[] = [
      use('toolu_agent_1', 'Task'), census('toolu_agent_1'), result('never-called'),
    ];
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(MALFORMED);
  });

  // G-B `duplicate_tool_result` (`atif.ts:163`) is NOT masked by absorption at either revision:
  // absorbed results still land in `resultIds`. Pinned inside a CLOSED span so the bound cannot be
  // what produces the refusal — delete `resultIds`' duplicate check and this publishes.
  it('still catches a duplicate tool_result absorbed inside a closed attested span', () => {
    const events: EventSpec[] = [
      use('toolu_agent_1', 'Task'),
      census('toolu_agent_1'),
      use('bash-1', 'Bash'),
      result('bash-1'),
      result('bash-1'),
      result('toolu_agent_1'),
    ];
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(MALFORMED);
  });

  // done_when (7): the accounting half reads `fragment.events` directly, never the groups. Both
  // journals carry the SAME accounting events and the same one assistant-kind census event, so
  // identical `final_metrics` is required; their ATIF step counts differ, so grouping demonstrably
  // did see the difference. Make any accounting reader consume `groupEvents` and this fails.
  it('keeps accounting independent of how much the attested span absorbs', () => {
    const bare = publishParent(makeRoot(), [
      use('toolu_agent_1', 'Task'), census('toolu_agent_1'), result('toolu_agent_1'),
    ]);
    const absorbing = publishParent(makeRoot(), [
      use('toolu_agent_1', 'Task'),
      census('toolu_agent_1'),
      { ...SHARED, event: { type: 'assistant_text', text: 'subagent speaking' } },
      use('sub-1', 'Bash'),
      result('sub-1'),
      result('toolu_agent_1'),
      { ...SHARED, event: { type: 'assistant_text', text: 'parent resumes' } },
    ]);
    expect(absorbing.final_metrics).toEqual(bare.final_metrics);
    expect(absorbing.steps.length).not.toBe(bare.steps.length);
    // The absorbed records landed inside the span's own step, not in steps of their own.
    expect(JSON.stringify(absorbing.steps[0])).toContain('subagent speaking');
  });
});

describe('G4-N24 — the census is validated against the call structure in BOTH directions', () => {
  // `assertSubagentCensus` walked calls -> attestation only, so a census naming a call the fragment
  // never made contributed a turn to a parent that does not exist: a fail-OPEN inside a
  // fail-CLOSED design. It rides the census function's own existing refusal.
  it('refuses a census event naming a call the fragment never made', () => {
    const events: EventSpec[] = [
      use('toolu_agent_1', 'Task'),
      census('toolu_agent_1'),
      census('toolu_agent_ghost'),
      result('toolu_agent_1'),
    ];
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(UNDERIVABLE);
  });

  it('refuses an orphan census even when it is the only census in the fragment', () => {
    const events: EventSpec[] = [
      use('bash-1', 'Bash'), result('bash-1'), census('toolu_agent_ghost'),
    ];
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(UNDERIVABLE);
  });

  // THE OTHER DIRECTION, so the check cannot be satisfied by refusing everything: a census whose
  // call IS present still derives its turns, for both aliases and for a tool_result-kind event.
  it('still derives the turns of a census whose call the fragment did make', () => {
    const trajectory = publishParent(makeRoot(), censusEvents({
      callId: 'call-1', toolName: 'Task', assistantLines: 3, toolResultLines: 2,
    }));
    expect(trajectory.final_metrics.extra.subagent_turns).toBe(3);
  });
});

// --- the wave-3 recursive DAG walk (plan:274) ---

function treeWithCensus(root: string, census: {
  parent?: CensusSpec; deep?: CensusSpec;
}): DagFixture {
  const specs: AttemptSpec[] = managerTreeSpecs().map(spec => {
    if (spec.threadId === null && census.parent) {
      return { ...spec, extraEvents: censusEvents({ ...census.parent, agentSlot: 'parent' }) };
    }
    if (spec.threadId === 'gg1' && census.deep) {
      return {
        ...spec,
        extraEvents: censusEvents({ ...census.deep, agentSlot: 'benchmark-coder' }),
      };
    }
    return spec;
  });
  return writeDagFixture(root, specs, managerTreeEdges());
}

function publishDag(fixture: DagFixture): any {
  const outputPath = path.join(fixture.root, 'trajectory.json');
  mergeTrajectory({ trajectoryRoot: fixture.root, outputPath, attemptDag: fixture.dag });
  return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
}

function nestingDepth(trajectory: any): number {
  const children = trajectory.subagent_trajectories ?? [];
  if (children.length === 0) return 0;
  return 1 + Math.max(...children.map(nestingDepth));
}

describe('the derivation holds through the recursive DAG walk', () => {
  it('sums the census across the whole tree, including a depth-3 attempt', () => {
    const fixture = treeWithCensus(makeRoot(), {
      parent: { callId: 'p-call', assistantLines: 2, toolResultLines: 1 },
      deep: { callId: 'gg1-call', toolName: 'Task', assistantLines: 5 },
    });
    const trajectory = publishDag(fixture);
    expect(nestingDepth(trajectory)).toBeGreaterThanOrEqual(3);
    expect(trajectory.final_metrics.extra.subagent_turns).toBe(7);
    expect(trajectory.final_metrics.total_steps).toBe(fixture.totals.steps);
  });

  it('refuses when the depth-3 attempt carries an empty census', () => {
    const fixture = treeWithCensus(makeRoot(), { deep: { callId: 'gg1-call' } });
    expect(refusalOf(() => publishDag(fixture))).toBe(UNDERIVABLE);
  });

  it('still raises malformed_fragment when census events are present', () => {
    const fixture = treeWithCensus(makeRoot(), {
      parent: { callId: 'p-call', assistantLines: 2 },
      deep: { callId: 'gg1-call', assistantLines: 1 },
    });
    corruptJournalBytes(fixture.journals.get(attemptIdOf('gg1'))!);
    expect(refusalOf(() => publishDag(fixture))).toBe(MALFORMED);
  });

  it('still raises missing_child_fragment for an orphan node when census events are present', () => {
    const fixture = treeWithCensus(makeRoot(), {
      parent: { callId: 'p-call', assistantLines: 2 },
      deep: { callId: 'gg1-call', assistantLines: 1 },
    });
    removeFragment(fixture.journals.get(attemptIdOf('gg1'))!);
    expect(refusalOf(() => publishDag(fixture))).toBe(MISSING_CHILD);
  });
});
