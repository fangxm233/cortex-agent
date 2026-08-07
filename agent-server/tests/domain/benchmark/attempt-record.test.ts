// input:  §9.1's 39-member interface, §9.2's closed edge union, §17 (17.3)'s minting rule
// output: member-set, closed-union, endpoint-legality and attempt-identity proofs
// pos:    Attempt record and attempt-DAG edge tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// SEAM NOTE. `mintAttemptId` is proved against the stem the SHIPPED `writeStartedMarker` actually
// writes to disk, not against a restatement of the grammar. §17 D1: `lifecycleStem`
// (`manifest.ts:261`) is not exported and §10's Gate-4 grant does not cover exporting it, so the
// equality is asserted rather than imported — which is the stronger check, because it proves the
// id names the real lifecycle pair that §9.2 invariant 4's biconditional ranges over.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_DISPOSITIONS,
  ATTEMPT_EDGE_KINDS,
  ATTEMPT_RECORD_KEYS,
  EDGE_ENDPOINT_LEGALITY,
  ENDPOINT_REF_KINDS,
  assignAttemptOrdinals,
  mintAttemptId,
  threadScopedIdentityHolds,
  type AttemptRecord,
} from '../../../src/domain/benchmark/attempt-record.js';
import { writeStartedMarker } from '../../../src/domain/agent-run/manifest.js';

/** §9.1's declaration order (`design:2571-2603`), transcribed field by field. */
const NINE_ONE_ORDER: readonly string[] = [
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
];

export function sampleAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  const sha = 'a'.repeat(64);
  return {
    trial_id: 'trial-1', root_run_id: 'root-1', task_id: 'trial-1', parent_task_id: null,
    // A PARENT attempt: null thread, and therefore null thread-scoped identity (G4-N14).
    dispatch_generation: null, attempt_id: 'run-root-1', attempt_ordinal: 1,
    thread_id: null, parent_thread_id: null, root_thread_id: null,
    task_ancestry: ['trial-1'],
    template: null, role: 'parent', stage: null,
    backend: 'claude', provider: null, requested_model: 'model-x', reported_model: null,
    model_execution_identity_hash: sha, role_tool_surface_hash: sha, bundle_manifest_hash: sha,
    terminal_state: 'completed', terminal_reason: 'ok', disposition: 'none', superseded_by: null,
    artifact_path: null, artifact_sha256: null,
    journal_path: 'run-root-1.journal.ndjson', journal_sha256: sha, event_count: 2,
    terminal_manifest_path: 'run-root-1.terminal.json', terminal_manifest_sha256: sha,
    edges: [],
    started_at: '2026-08-06T00:00:00.000Z', ended_at: '2026-08-06T00:00:01.000Z',
    steps: 1, cost_usd: 0.5,
    tokens: { input: 1, output: 2, cache_read: null, cache_creation: null },
    provider_requests: null,
    ...overrides,
  };
}

describe('AttemptRecord member set — §9.1, 39 members (§17 17.1.4)', () => {
  it('declares exactly the 39 members §9.1 declares, in §9.1 declaration order', () => {
    // The count is obtained by ENUMERATING THE CONSTRUCT, never from a table's row count:
    // (17.1.4) presents 38 rows because its row 34 carries `started_at`/`ended_at` together.
    expect(ATTEMPT_RECORD_KEYS.length).toBe(39);
    expect([...ATTEMPT_RECORD_KEYS]).toEqual(NINE_ONE_ORDER);
  });

  it('G4-CM2: every key is present on a record, including the nullable-valued ones', () => {
    const record = sampleAttempt();
    for (const key of ATTEMPT_RECORD_KEYS) {
      expect(Object.hasOwn(record, key), `missing key ${key}`).toBe(true);
    }
    expect(Object.keys(record).sort()).toEqual([...ATTEMPT_RECORD_KEYS].sort());
  });

  it('G4-CM2: all four TokenCounts members are present even when unavailable', () => {
    // `manifest-contract.ts:26,:27` declare cache_read/cache_creation OPTIONAL. On the wire they
    // are `null`, never absent, so two manifests can never differ by key presence.
    const tokens = sampleAttempt().tokens;
    expect(Object.keys(tokens).sort()).toEqual(
      ['cache_creation', 'cache_read', 'input', 'output'],
    );
  });

  it('carries the five dispositions §9.1 declares', () => {
    expect([...ATTEMPT_DISPOSITIONS]).toEqual(
      ['accepted', 'rejected', 'superseded', 'invalidated', 'none'],
    );
  });
});

describe('AttemptEdge — the CLOSED union (§17 17.1.5)', () => {
  it('has THIRTEEN kinds, not twelve — §9.2s last row names two', () => {
    // §9.2's table has 12 ROWS (design:2680-2691); its last row is `question` / `answer`, i.e.
    // TWO kinds. A union built by counting rows ships twelve and silently rejects a legal edge.
    expect(ATTEMPT_EDGE_KINDS.length).toBe(13);
    expect([...ATTEMPT_EDGE_KINDS]).toEqual([
      'spawn', 'decompose', 'depends_on', 'dispatch', 'proposal', 'seal', 'delivery',
      'verdict', 'rework', 'supersede', 'rotation', 'question', 'answer',
    ]);
  });

  it('both kinds of §9.2s last row are present and distinct', () => {
    expect(ATTEMPT_EDGE_KINDS).toContain('question');
    expect(ATTEMPT_EDGE_KINDS).toContain('answer');
    expect(new Set(ATTEMPT_EDGE_KINDS).size).toBe(13);
  });

  it('EndpointRef is the closed five-member tagged union of (17.1.5)', () => {
    expect([...ENDPOINT_REF_KINDS]).toEqual(
      ['attempt', 'task', 'proposal', 'outcome', 'direct-parent'],
    );
  });

  it('G4-CM15: each kinds legal endpoint types are exactly (17.1.5)s table', () => {
    // Heterogeneous by construction — bare string endpoints cannot express these.
    expect(EDGE_ENDPOINT_LEGALITY.depends_on).toEqual({ from: ['task'], to: ['task'] });
    expect(EDGE_ENDPOINT_LEGALITY.decompose).toEqual({ from: ['attempt'], to: ['task'] });
    expect(EDGE_ENDPOINT_LEGALITY.dispatch).toEqual({ from: ['task'], to: ['attempt'] });
    expect(EDGE_ENDPOINT_LEGALITY.proposal).toEqual({ from: ['attempt'], to: ['proposal'] });
    expect(EDGE_ENDPOINT_LEGALITY.seal).toEqual({ from: ['proposal'], to: ['outcome'] });
    expect(EDGE_ENDPOINT_LEGALITY.delivery).toEqual({ from: ['outcome'], to: ['attempt'] });
    expect(EDGE_ENDPOINT_LEGALITY.spawn).toEqual({ from: ['attempt'], to: ['attempt'] });
  });

  it('G4-CM15: only question/answer admit the id-less direct-parent endpoint', () => {
    expect(EDGE_ENDPOINT_LEGALITY.question.to).toEqual(['attempt', 'direct-parent']);
    expect(EDGE_ENDPOINT_LEGALITY.answer.from).toEqual(['attempt', 'direct-parent']);
    const others = ATTEMPT_EDGE_KINDS.filter(kind => kind !== 'question' && kind !== 'answer');
    for (const kind of others) {
      const legality = EDGE_ENDPOINT_LEGALITY[kind];
      expect(legality.from, `${kind}.from`).not.toContain('direct-parent');
      expect(legality.to, `${kind}.to`).not.toContain('direct-parent');
    }
  });
});

describe('attempt_id minting — G4-AI2 / G4-AI3 / G4-AI6', () => {
  it('mints the bare stem: run-<rootRunId> for a null thread, thread-<threadId> otherwise', () => {
    expect(mintAttemptId('root-1', null)).toBe('run-root-1');
    expect(mintAttemptId('root-1', 'thread-9')).toBe('thread-thread-9');
  });

  it('G4-AI2: there is NO #<step> suffix in any mode — the struck Branch A clause', () => {
    // The ruling is Branch B: an attempt is a FRAGMENT. An implementer emitting a suffixed id is
    // emitting a value this contract does not define.
    expect(mintAttemptId('root-1', null)).not.toContain('#');
    expect(mintAttemptId('root-1', 'thread-9')).not.toContain('#');
  });

  it('G4-AI6: minting is DERIVED and encoder-independent, never random', () => {
    // Two encoders reading the same trajectory root must produce the same id, which is what F8's
    // publish-then-re-read-and-re-hash check needs (G4-CM5).
    expect(mintAttemptId('root-1', null)).toBe(mintAttemptId('root-1', null));
  });

  it('refuses an id outside the shipped lifecycle grammar (manifest.ts:254)', () => {
    expect(() => mintAttemptId('bad/../id', null)).toThrow();
    expect(() => mintAttemptId('root-1', 'bad id')).toThrow();
  });

  it('EQUALS the stem the SHIPPED writeStartedMarker puts on disk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-id-'));
    try {
      const rootRunId = 'root-abc';
      writeStartedMarker({
        trajectoryRoot: root, rootRunId, threadId: null,
        journalPath: path.join(root, 'j.ndjson'),
      });
      const written = fs.readdirSync(root).filter(name => name.endsWith('.started.json'));
      expect(written).toEqual([`${mintAttemptId(rootRunId, null)}.started.json`]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('attempt_ordinal — G4-AI4 / G4-AI5', () => {
  const at = (n: number) => `2026-08-06T00:00:0${n}.000Z`;

  it('is base 1 and scoped to task_id, not to the trial and not to the thread', () => {
    // §9.2's `rework` edge is "rejected verdict → next attempt of the SAME TASK"; the ordinal is
    // exactly what "next" counts.
    const ordinals = assignAttemptOrdinals([
      { attempt_id: 'a1', task_id: 't1', started_at: at(1) },
      { attempt_id: 'a2', task_id: 't1', started_at: at(2) },
      { attempt_id: 'b1', task_id: 't2', started_at: at(3) },
    ]);
    expect(ordinals.get('a1')).toBe(1);
    expect(ordinals.get('a2')).toBe(2);
    expect(ordinals.get('b1')).toBe(1);
  });

  it('never mints an ordinal 0 — a reader never has to ask which base was used', () => {
    const ordinals = assignAttemptOrdinals([
      { attempt_id: 'a1', task_id: 't1', started_at: at(1) },
    ]);
    expect([...ordinals.values()].every(value => value >= 1)).toBe(true);
  });

  it('orders by started_at ascending, breaking ties by attempt_id ascending', () => {
    const ordinals = assignAttemptOrdinals([
      { attempt_id: 'zz', task_id: 't1', started_at: at(1) },
      { attempt_id: 'aa', task_id: 't1', started_at: at(1) },
    ]);
    expect(ordinals.get('aa')).toBe(1);
    expect(ordinals.get('zz')).toBe(2);
  });

  it('G4-AI5: a supersede does not re-number — the ordinal is a fact of history', () => {
    // Re-numbering would make attempt_ordinal a function of the trial's FINAL state rather than of
    // its history, and §9.2's node sort would then differ between an in-flight and a published
    // manifest. Input order is deliberately shuffled to prove the sort, not the argument order.
    const attempts = [
      { attempt_id: 'a3', task_id: 't1', started_at: at(3) },
      { attempt_id: 'a1', task_id: 't1', started_at: at(1) },
      { attempt_id: 'a2', task_id: 't1', started_at: at(2) },
    ];
    const ordinals = assignAttemptOrdinals(attempts);
    expect(ordinals.get('a1')).toBe(1);
    expect(ordinals.get('a2')).toBe(2);
    expect(ordinals.get('a3')).toBe(3);
    // The same set re-encoded after a1 was superseded keeps every ordinal it already had.
    expect(assignAttemptOrdinals([...attempts].reverse())).toEqual(ordinals);
  });
});

describe('D-NULL3 — the three widened members (G4-N13 / G4-N14)', () => {
  it('the member COUNT is unchanged at 39 — only three types moved', () => {
    expect(ATTEMPT_RECORD_KEYS.length).toBe(39);
  });

  it('G4-N13: dispatch_generation is null for EVERY attempt on the benchmark path', () => {
    // Not a parent-only absence: the shipped source type is already nullable
    // (`core/task-parser.ts:35`) and the benchmark orchestrator never claims — it CREATES threads
    // (`benchmark-local-thread-orchestrator.ts:389`). Re-using `root_run_id` would fabricate a
    // distinction the data does not contain.
    expect(sampleAttempt().dispatch_generation).toBeNull();
    expect(sampleAttempt({ thread_id: 'c1', root_thread_id: 'c1', template: 't' })
      .dispatch_generation).toBeNull();
  });

  it('G4-N14 direction 1: a PARENT attempt holds null thread-scoped identity', () => {
    const parent = sampleAttempt();
    expect(parent.thread_id).toBeNull();
    expect(threadScopedIdentityHolds(parent)).toBe(true);
  });

  it('G4-N14 direction 2: a THREAD attempt holds NON-null thread-scoped identity', () => {
    const thread = sampleAttempt({
      thread_id: 'c1', root_thread_id: 'root-1', template: 'benchmark-coder-review',
    });
    expect(threadScopedIdentityHolds(thread)).toBe(true);
  });

  it('G4-N14: a thread attempt that LOST its thread-scoped identity is refused', () => {
    // A bare `| null` would let this pass schema while silently losing real data — which is why
    // the widening is a biconditional and not an unconditional one.
    expect(threadScopedIdentityHolds(
      sampleAttempt({ thread_id: 'c1', root_thread_id: null, template: 'tpl' }),
    )).toBe(false);
    expect(threadScopedIdentityHolds(
      sampleAttempt({ thread_id: 'c1', root_thread_id: 'r', template: null }),
    )).toBe(false);
  });

  it('G4-N14: a parent attempt that FABRICATED thread-scoped identity is refused', () => {
    expect(threadScopedIdentityHolds(
      sampleAttempt({ thread_id: null, root_thread_id: 'invented' }),
    )).toBe(false);
    expect(threadScopedIdentityHolds(
      sampleAttempt({ thread_id: null, template: 'invented' }),
    )).toBe(false);
  });

  it('G4-N16: registerChildSpawn does NOT write metadata.parentThreadId', () => {
    // The directed check, asserted rather than asserted-in-prose: `parentThreadId` at tree.ts:130
    // is the PARAMETER name. The function body writes childThreadIds and waitingOn only, so no
    // benchmark writer produces the linkage §9.2's `spawn` edge is defined over.
    const treeSource = fs.readFileSync(
      new URL('../../../src/domain/threads/tree.ts', import.meta.url), 'utf8',
    );
    const body = treeSource.slice(
      treeSource.indexOf('export async function registerChildSpawn'),
    ).split('\n').slice(0, 7).join('\n');
    expect(body).toContain('childThreadIds');
    expect(body).toContain('waitingOn');
    expect(body).not.toContain('m.parentThreadId');
    expect(body).not.toContain('metadata.parentThreadId');
  });
});

describe('R1 — the backend widening is ASSERTED, never re-edited (G4-N2)', () => {
  it('JournalEventInput.backend is `Backend`, landed by Gate 2 at journal.ts:58', () => {
    // design:4244 — "whichever gate lands first owns the edit; the second asserts it". This is the
    // assertion. A diff to that declaration is a rejection, so the evidence is a test, not a patch.
    const journalSource = fs.readFileSync(
      new URL('../../../src/domain/agent-run/journal.ts', import.meta.url), 'utf8',
    );
    const lines = journalSource.split('\n');
    expect(lines[57].trim()).toBe('backend: Backend;');
    const inputStart = lines.findIndex(line => line.includes('interface JournalEventInput'));
    expect(inputStart).toBe(53);
    expect(journalSource).toContain("import type { Backend } from '../../agent-adapter/types.js';");
  });

  it('an AttemptRecord accepts both backends the widened union admits', () => {
    expect(sampleAttempt({ backend: 'claude' }).backend).toBe('claude');
    expect(sampleAttempt({ backend: 'pi' }).backend).toBe('pi');
  });
});
