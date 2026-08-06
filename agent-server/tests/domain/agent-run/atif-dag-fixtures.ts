// input:  a temp root, manager-shaped attempts and their §9.2 authoritative edges
// output: on-disk lifecycle pairs plus the attempt DAG the recursive merge walks
// pos:    Attempt-DAG fixtures for the recursive ATIF merge
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. The attempt ids these fixtures declare are minted by the PRODUCTION `mintAttemptId`
// (`attempt-record.ts:259`), never by a restatement of its grammar, so the fragment↔node join the
// merge performs is proved against the same string §9.2 invariant 4 pairs with the lifecycle stem.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  mintAttemptId, type AttemptEdge, type AttemptRecord,
} from '../../../src/domain/benchmark/attempt-record.js';
import type { AttemptDag } from '../../../src/domain/agent-run/trajectory-merge.js';
import {
  MODEL_HASH, ROOT_RUN_ID, accountingEvents, mcpResult, writeJournal,
  type EventSpec, type FixtureJournal,
} from './trajectory-merge-fixtures.js';

const TRIAL_ID = 'trial-w3';

export interface AttemptSpec {
  /** `null` marks the parent process attempt; anything else is a thread attempt. */
  readonly threadId: string | null;
  readonly role: EventSpec['agentSlot'];
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly taskAncestry: readonly string[];
  readonly prompt: number;
  readonly completion: number;
  readonly cached: number;
  readonly cost: number;
  readonly turns: number;
  /** Emitted before the accounting events; lets a node carry its own `thread_run` call. */
  readonly extraEvents?: readonly EventSpec[];
}

export interface DagFixture {
  readonly root: string;
  readonly journals: ReadonlyMap<string, FixtureJournal>;
  readonly dag: AttemptDag;
  readonly totals: {
    prompt: number; completion: number; cached: number; cost: number; steps: number;
  };
}

export function attemptIdOf(threadId: string | null): string {
  return mintAttemptId(ROOT_RUN_ID, threadId);
}

function roleHash(role: string): string {
  return createHash('sha256').update(`w3:${role}:role`).digest('hex');
}

function specEvents(spec: AttemptSpec): EventSpec[] {
  const at = `2026-08-01T00:00:0${Math.min(spec.turns, 9)}.000Z`;
  return [
    { ts: at, step: 1, agentSlot: spec.role, event: { type: 'assistant_text', text: `${spec.role} works` } },
    ...(spec.extraEvents ?? []),
    ...accountingEvents({
      ts: at, step: 1, agentSlot: spec.role,
      prompt: spec.prompt, completion: spec.completion, cached: spec.cached,
      cost: spec.cost, turns: spec.turns,
    }),
  ];
}

/**
 * D-NULL3 (`attempt-record.ts:276-283`): `thread_id === null ⟺ root_thread_id === null ⟺
 * template === null`. Constructed here rather than defaulted so a fixture can never quietly
 * fabricate thread-scoped identity for the parent process.
 */
function attemptRecord(
  spec: AttemptSpec, journal: FixtureJournal, edges: readonly AttemptEdge[], ordinal: number,
): AttemptRecord {
  const attemptId = attemptIdOf(spec.threadId);
  const journalBytes = fs.readFileSync(journal.journalPath);
  const terminal = JSON.parse(fs.readFileSync(journal.terminalPath, 'utf8'));
  return {
    trial_id: TRIAL_ID, root_run_id: ROOT_RUN_ID,
    task_id: spec.taskId, parent_task_id: spec.parentTaskId,
    dispatch_generation: null, attempt_id: attemptId, attempt_ordinal: ordinal,
    thread_id: spec.threadId, parent_thread_id: null,
    root_thread_id: spec.threadId === null ? null : ROOT_RUN_ID,
    task_ancestry: [...spec.taskAncestry],
    template: spec.threadId === null ? null : 'benchmark-coder-review',
    role: spec.role, stage: null,
    backend: 'claude', provider: 'anthropic',
    requested_model: 'claude-sonnet-4-5', reported_model: 'claude-sonnet-4-5-20250929',
    model_execution_identity_hash: MODEL_HASH,
    role_tool_surface_hash: roleHash(spec.role),
    bundle_manifest_hash: '3'.repeat(64),
    terminal_state: 'completed', terminal_reason: 'ok', disposition: 'none', superseded_by: null,
    artifact_path: null, artifact_sha256: null,
    journal_path: path.basename(journal.journalPath),
    journal_sha256: createHash('sha256').update(journalBytes).digest('hex'),
    event_count: terminal.event_count,
    terminal_manifest_path: path.basename(journal.terminalPath),
    terminal_manifest_sha256: createHash('sha256')
      .update(fs.readFileSync(journal.terminalPath)).digest('hex'),
    edges: edges.filter(edge => edge.from.ref === 'attempt' && edge.from.id === attemptId),
    started_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-08-01T00:00:10.000Z',
    steps: spec.turns, cost_usd: spec.cost,
    tokens: {
      input: spec.prompt, output: spec.completion, cache_read: spec.cached, cache_creation: null,
    },
    provider_requests: null,
  };
}

export function writeDagFixture(
  root: string, specs: readonly AttemptSpec[], edges: readonly AttemptEdge[],
): DagFixture {
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const journals = new Map<string, FixtureJournal>();
  const nodes: AttemptRecord[] = [];
  specs.forEach((spec, index) => {
    const journal = writeJournal(root, {
      threadId: spec.threadId, agentSlot: spec.role,
      roleHash: roleHash(spec.role), events: specEvents(spec),
    });
    journals.set(attemptIdOf(spec.threadId), journal);
    nodes.push(attemptRecord(spec, journal, edges, index + 1));
  });
  return {
    root,
    journals,
    dag: {
      nodes,
      edges: [...edges],
      roots: { parent_attempt_id: attemptIdOf(null) },
      identity: {
        model_execution_identity_hash: Object.fromEntries(
          specs.map(spec => [spec.role, MODEL_HASH]),
        ),
      },
    },
    totals: specs.reduce((total, spec) => ({
      prompt: total.prompt + spec.prompt,
      completion: total.completion + spec.completion,
      cached: total.cached + spec.cached,
      cost: total.cost + spec.cost,
      steps: total.steps + spec.turns,
    }), { prompt: 0, completion: 0, cached: 0, cost: 0, steps: 0 }),
  };
}

function attemptRef(threadId: string | null): AttemptEdge['from'] {
  return { ref: 'attempt', id: attemptIdOf(threadId) };
}

/**
 * A manager tree four attempt levels deep. Depth 3 is `gg1`, so a builder that stops after one
 * level of `subagent_trajectories` — and equally one that stops after two — publishes a tree that
 * is missing a node. `c1` carries a real `thread_run` call so the recursion is also forced to hand
 * a NON-ROOT node its own link map.
 *
 *   run-run-001 (parent) ─decompose→ task-1 ─dispatch→ thread-c1  (benchmark-coder)
 *                        └─spawn──────────────────────→ thread-c2 (benchmark-fixer)
 *   thread-c1            ─decompose→ task-2 ─dispatch→ thread-g1  (benchmark-reviewer)
 *   thread-g1            ─spawn────────────────────────→ thread-gg1 (benchmark-coder)
 *
 * Per-attempt costs are pairwise distinct so a sum that visits only the root and its direct
 * children lands on a different number rather than coincidentally on the right one.
 */
export const MANAGER_TREE_CALL_ID = 'c1-call';

export function managerTreeSpecs(): AttemptSpec[] {
  return [
    {
      threadId: null, role: 'parent', taskId: 'task-1', parentTaskId: null,
      taskAncestry: ['task-1'], prompt: 1_000, completion: 100, cached: 10, cost: 0.1, turns: 1,
    },
    {
      threadId: 'c1', role: 'benchmark-coder', taskId: 'task-1', parentTaskId: null,
      taskAncestry: ['task-1'], prompt: 200, completion: 20, cached: 2, cost: 0.02, turns: 2,
      extraEvents: [
        { ts: '2026-08-01T00:00:03.000Z', step: 1, agentSlot: 'benchmark-coder', event: {
          type: 'tool_use', toolUseId: MANAGER_TREE_CALL_ID,
          name: 'mcp__cortex-benchmark-thread__thread_run', input: { handoff: 'g1' },
        } },
        { ts: '2026-08-01T00:00:04.000Z', step: 1, agentSlot: 'benchmark-coder', event: {
          type: 'tool_result', toolUseId: MANAGER_TREE_CALL_ID, ok: true, content: mcpResult('g1'),
        } },
      ],
    },
    {
      threadId: 'c2', role: 'benchmark-fixer', taskId: 'task-3', parentTaskId: 'task-1',
      taskAncestry: ['task-1', 'task-3'], prompt: 400, completion: 40, cached: 4, cost: 0.04, turns: 3,
    },
    {
      threadId: 'g1', role: 'benchmark-reviewer', taskId: 'task-2', parentTaskId: 'task-1',
      taskAncestry: ['task-1', 'task-2'], prompt: 40, completion: 4, cached: 1, cost: 0.004, turns: 4,
    },
    {
      threadId: 'gg1', role: 'benchmark-coder', taskId: 'task-2', parentTaskId: 'task-1',
      taskAncestry: ['task-1', 'task-2'], prompt: 8, completion: 2, cached: 1, cost: 0.008, turns: 5,
    },
  ];
}

/** §9.2 edge order: `(kind_ordinal, from, to)` — `spawn` 1, `decompose` 2, `dispatch` 4. */
export function managerTreeEdges(): AttemptEdge[] {
  return [
    { kind: 'spawn', from: attemptRef(null), to: attemptRef('c2') },
    { kind: 'spawn', from: attemptRef('g1'), to: attemptRef('gg1') },
    { kind: 'decompose', from: attemptRef(null), to: { ref: 'task', id: 'task-1' } },
    { kind: 'decompose', from: attemptRef('c1'), to: { ref: 'task', id: 'task-2' } },
    { kind: 'dispatch', from: { ref: 'task', id: 'task-1' }, to: attemptRef('c1') },
    { kind: 'dispatch', from: { ref: 'task', id: 'task-2' }, to: attemptRef('g1') },
  ];
}

export function writeManagerTreeFixture(root: string): DagFixture {
  return writeDagFixture(root, managerTreeSpecs(), managerTreeEdges());
}

/** A `coder-review` shape: parent plus exactly one thread level (§9.4 C7). */
export function writeCoderReviewFixture(root: string): DagFixture {
  const callA = 'call-a';
  const callB = 'call-b';
  return writeDagFixture(root, [
    {
      threadId: null, role: 'parent', taskId: 'task-1', parentTaskId: null,
      taskAncestry: ['task-1'], prompt: 900, completion: 90, cached: 9, cost: 0.09, turns: 1,
      extraEvents: [
        { ts: '2026-08-01T00:00:02.000Z', step: 1, agentSlot: 'parent', event: {
          type: 'tool_use', toolUseId: callA,
          name: 'mcp__cortex-benchmark-thread__thread_run', input: { handoff: 'a' },
        } },
        { ts: '2026-08-01T00:00:02.500Z', step: 1, agentSlot: 'parent', event: {
          type: 'tool_result', toolUseId: callA, ok: true, content: mcpResult('a'),
        } },
        { ts: '2026-08-01T00:00:03.000Z', step: 1, agentSlot: 'parent', event: {
          type: 'tool_use', toolUseId: callB,
          name: 'mcp__cortex-benchmark-thread__thread_run', input: { handoff: 'b' },
        } },
        { ts: '2026-08-01T00:00:03.500Z', step: 1, agentSlot: 'parent', event: {
          type: 'tool_result', toolUseId: callB, ok: true, content: mcpResult('b'),
        } },
      ],
    },
    {
      threadId: 'a', role: 'benchmark-coder', taskId: 'task-1', parentTaskId: null,
      taskAncestry: ['task-1'], prompt: 300, completion: 30, cached: 3, cost: 0.03, turns: 2,
    },
    {
      threadId: 'b', role: 'benchmark-reviewer', taskId: 'task-1', parentTaskId: null,
      taskAncestry: ['task-1'], prompt: 500, completion: 50, cached: 5, cost: 0.05, turns: 3,
    },
  ], [
    { kind: 'spawn', from: attemptRef(null), to: attemptRef('a') },
    { kind: 'spawn', from: attemptRef(null), to: attemptRef('b') },
  ]);
}
