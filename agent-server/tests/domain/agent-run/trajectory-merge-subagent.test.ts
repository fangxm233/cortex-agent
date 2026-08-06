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

  it('keeps unpaired_tool_result strict when no census attests the open call', () => {
    const events = interleavedSubagentEvents('toolu_agent_1')
      .filter(spec => (spec.event as { type: string }).type !== 'subagent_activity');
    // Without attestation the census refuses first, so drop the call and keep only the orphan
    // result: an unattested interleaving must still be malformed, exactly as it is today.
    const orphan: EventSpec[] = events.filter(spec => {
      const event = spec.event as { type: string; toolUseId?: string };
      return !(event.type === 'tool_use' && event.toolUseId === 'toolu_agent_1');
    });
    expect(refusalOf(() => publishParent(makeRoot(), orphan))).toBe(MALFORMED);
  });

  it('still refuses the production shape when the census is empty', () => {
    const events = interleavedSubagentEvents('toolu_agent_1')
      .filter(spec => (spec.event as { type: string }).type !== 'subagent_activity');
    expect(refusalOf(() => publishParent(makeRoot(), events))).toBe(UNDERIVABLE);
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
