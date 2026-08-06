// input:  §8.6's four states, S1-S4 operands, V1-V4 rules and the shipped acceptance ledger
// output: seal conjunction, invalidation, fail-closed store, append-only rows and edge projection
// pos:    Proposal → seal state machine contract tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, it, vi } from 'vitest';

const atomic = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('@core/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/atomic-write.js')>();
  return {
    ...actual,
    atomicWriteSync: (target: string, data: string | Buffer) => {
      atomic.paths.push(target);
      return actual.atomicWriteSync(target, data as string);
    },
  };
});

import { PROJECTS_DIR } from '../../../src/core/paths.js';
import { managerNodeDir } from '../../../src/core/task-node.js';
import { parseTasksFile } from '../../../src/core/task-parser.js';
import type { ThreadStatus } from '../../../src/core/types/thread-types.js';
import { isTerminalStatus } from '../../../src/domain/threads/tree.js';
import {
  buildTerminalManifest, terminalManifestProblem, type TerminalState,
} from '../../../src/domain/agent-run/manifest-contract.js';
import {
  ATTEMPT_EDGE_KINDS, EDGE_ENDPOINT_LEGALITY,
} from '../../../src/domain/benchmark/attempt-record.js';
import { VERDICT_BY_VARIANT } from '../../../src/domain/benchmark/variant-proposal.js';
import { BENCHMARK_FAILURES } from '../../../src/domain/benchmark/resolved-policy.js';
import {
  ledgerPath, readLedger, recordDelivered, recordVerdict,
} from '../../../src/domain/tasks/acceptance-ledger.js';
import {
  applyAttemptTerminal,
  attemptSeal,
  cancelTrialProposals,
  eligibleOutcome,
  evaluateSeal,
  INVALIDATION_RULES,
  outstandingProposals,
  PROPOSAL_ROW_KEYS,
  PROPOSAL_STATES,
  ProposalSealError,
  proposalStoreEdges,
  proposalStorePath,
  readProposalStore,
  recordProposal,
  SEAL_PRECONDITIONS,
  type ProposalKey,
  type SealOperands,
  type SealPrecondition,
} from '../../../src/domain/benchmark/proposal-seal.js';

// ── fixtures ────────────────────────────────────────────────────────────────

let projectCounter = 0;
let project = '';
const TASK = 'aa11';

beforeEach(() => {
  atomic.paths.length = 0;
  project = `_test_proposal_seal_${++projectCounter}`;
  fs.mkdirSync(path.join(PROJECTS_DIR, project), { recursive: true });
});

function key(attemptId: string, generation = 'gen-1', taskId = TASK): ProposalKey {
  return { task_id: taskId, dispatch_generation: generation, attempt_id: attemptId };
}

/** Operands with every precondition satisfied except those named. S1's two halves are separately
 *  reachable: `S1-manifest` breaks only the terminal-manifest half. */
function sealOperands(unmet: readonly (SealPrecondition | 'S1-manifest')[] = []): SealOperands {
  const broken = new Set<string>(unmet);
  return {
    threadStatus: broken.has('S1') ? 'running' : 'completed',
    terminalManifestState: broken.has('S1-manifest') ? 'running' : 'completed',
    supervisor: broken.has('S2') ? { quiescent: false, descendants: 2 } : { quiescent: true, descendants: 0 },
    storesFlushed: !broken.has('S3'),
    journalClosed: !broken.has('S3'),
    trajectoryLifecycle: { ok: !broken.has('S4') },
  };
}

/** Whether the SHIPPED terminal-manifest validator faults on this `state` value. Built through
 *  `buildTerminalManifest` so the answer comes from `manifest-contract.ts`'s own union, not from a
 *  list restated in this test. */
function shippedAcceptsManifestState(state: string): boolean {
  const sha = 'a'.repeat(64);
  const manifest = buildTerminalManifest({
    trajectoryRoot: '/trial', rootRunId: 'run-1', threadId: null,
    state: state as TerminalState,
    startedAt: '2026-08-06T00:00:00.000Z', endedAt: '2026-08-06T00:00:01.000Z',
    journalPath: '/trial/journal.jsonl', journalSha256: sha, eventCount: 1,
    supervisor: { quiescent: true, descendants: 0 },
    steps: 1, costUsd: null, tokens: { input: 1, output: 1 },
    modelExecutionIdentityHash: sha, roleToolSurfaceHash: sha, bundleManifestHash: sha,
    terminalReason: 'ok',
  });
  return terminalManifestProblem(manifest) !== 'state';
}

/** Whether the SHIPPED manifest validator faults on this value used as a lifecycle timestamp.
 *  Same technique as `shippedAcceptsManifestState`: the answer comes from `manifest-contract.ts`'s
 *  own `isTimestamp`, never from a pattern restated in this test. */
function shippedAcceptsTimestamp(value: string): boolean {
  const sha = 'a'.repeat(64);
  const manifest = buildTerminalManifest({
    trajectoryRoot: '/trial', rootRunId: 'run-1', threadId: null,
    state: 'completed',
    startedAt: value, endedAt: '2026-08-06T00:00:01.000Z',
    journalPath: '/trial/journal.jsonl', journalSha256: sha, eventCount: 1,
    supervisor: { quiescent: true, descendants: 0 },
    steps: 1, costUsd: null, tokens: { input: 1, output: 1 },
    modelExecutionIdentityHash: sha, roleToolSurfaceHash: sha, bundleManifestHash: sha,
    terminalReason: 'ok',
  });
  return terminalManifestProblem(manifest) !== 'started_at';
}

/** Writes a store file by hand so a CORRUPT row can be presented to the fail-closed reader. */
function writeStoreFile(rows: readonly Record<string, unknown>[]): void {
  const target = proposalStorePath(project, TASK);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ task_id: TASK, project, proposals: rows }, null, 2));
}

function validRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: TASK, dispatch_generation: 'gen-1', attempt_id: 'attempt-1',
    intent: 'complete', note: null, state: 'proposed', unmet: [], invalidated_by: null,
    proposed_at: '2026-08-06T00:00:00.000Z', settled_at: null,
    ...overrides,
  };
}

function storeReadable(): boolean {
  try {
    readProposalStore(project, TASK);
    return true;
  } catch (error) {
    assert.equal(error instanceof ProposalSealError && error.code === 42, true);
    return false;
  }
}

function seedProposal(attemptId = 'attempt-1', note: string | null = 'note'): void {
  recordProposal(project, { key: key(attemptId), intent: 'complete', note });
}

function sealed(attemptId = 'attempt-1') {
  return attemptSeal(project, key(attemptId), {
    currentAttemptId: attemptId, operands: sealOperands(),
  });
}

// ── §8.6 the four states ────────────────────────────────────────────────────

it('states — `none` is the ABSENCE of a row, and the persisted union is the other three', () => {
  assert.deepEqual([...PROPOSAL_STATES], ['proposed', 'sealed', 'invalidated']);
  assert.equal((PROPOSAL_STATES as readonly string[]).includes('none'), false);
  assert.deepEqual(readProposalStore(project, TASK).proposals, []);
  assert.equal(eligibleOutcome(project, key('attempt-1')), null);
});

it('states — `proposed` leaves the task\'s authoritative status UNCHANGED', () => {
  const tasksPath = path.join(PROJECTS_DIR, project, 'TASKS.yaml');
  fs.writeFileSync(tasksPath, `tasks:
  - id: ${TASK}
    text: "seed"
    why: "baseline"
    done-when: "exists"
    priority: medium
    status: open
    template: coder-review
    plan: ""
`);
  const before = fs.readFileSync(tasksPath, 'utf8');

  seedProposal();

  // The model does not get to see its own proposal as a result.
  assert.equal(fs.readFileSync(tasksPath, 'utf8'), before);
  assert.equal(parseTasksFile(fs.readFileSync(tasksPath, 'utf8'), project)[0].status, 'open');
  assert.equal(readProposalStore(project, TASK).proposals[0].state, 'proposed');
  assert.equal(eligibleOutcome(project, key('attempt-1')), null);
  // ...and no delivery authority was created either.
  assert.equal(fs.existsSync(ledgerPath(project, TASK)), false);
});

// ── §8.6 S1-S4 ──────────────────────────────────────────────────────────────

it('S1 — the restated terminal sets EQUAL the shipped unions they restate', () => {
  const statuses: readonly ThreadStatus[] = [
    'running', 'waiting', 'rate_limited', 'completed', 'failed', 'cancelled', 'aborted',
  ];
  for (const status of statuses) {
    const evaluation = evaluateSeal({ ...sealOperands(), threadStatus: status });
    const s1Held = evaluation.sealed === true;
    assert.equal(s1Held, isTerminalStatus(status), `S1 disagrees with tree.ts for ${status}`);
  }
  // The manifest half, cross-checked against the SHIPPED validator rather than against a comment:
  // a state the module accepts must be a state `terminalManifestProblem` does not fault on.
  for (const state of ['completed', 'failed', 'cancelled', 'timeout', 'running', 'aborted', 'ok', '']) {
    const moduleAccepts = evaluateSeal({ ...sealOperands(), terminalManifestState: state }).sealed;
    assert.equal(moduleAccepts, shippedAcceptsManifestState(state),
      `S1's manifest half disagrees with manifest-contract.ts for ${state || '<empty>'}`);
  }
});

it('S1 dropped — a non-terminal thread status refuses and `unmet` names exactly S1', () => {
  assert.deepEqual(evaluateSeal(sealOperands(['S1'])), { sealed: false, unmet: ['S1'] });
  seedProposal();
  const row = attemptSeal(project, key('attempt-1'), {
    currentAttemptId: 'attempt-1', operands: sealOperands(['S1']),
  });
  assert.equal(row.state, 'proposed');
  assert.deepEqual([...row.unmet], ['S1']);
  assert.equal(row.settled_at, null);
  assert.equal(eligibleOutcome(project, key('attempt-1')), null);
});

it('S2 dropped — a non-quiescent supervisor, live descendants, or a manifest that does not carry it', () => {
  assert.deepEqual(evaluateSeal(sealOperands(['S2'])), { sealed: false, unmet: ['S2'] });
  for (const supervisor of [
    { quiescent: false, descendants: 0 },
    { quiescent: true, descendants: 1 },
    null,
  ]) {
    assert.deepEqual(evaluateSeal({ ...sealOperands(), supervisor }), {
      sealed: false, unmet: ['S2'],
    });
  }
  seedProposal();
  const row = attemptSeal(project, key('attempt-1'), {
    currentAttemptId: 'attempt-1', operands: sealOperands(['S2']),
  });
  assert.equal(row.state, 'proposed');
  assert.deepEqual([...row.unmet], ['S2']);
});

it('S3 dropped — an unflushed store or an open journal refuses', () => {
  assert.deepEqual(evaluateSeal(sealOperands(['S3'])), { sealed: false, unmet: ['S3'] });
  assert.deepEqual(evaluateSeal({ ...sealOperands(), storesFlushed: false }), {
    sealed: false, unmet: ['S3'],
  });
  assert.deepEqual(evaluateSeal({ ...sealOperands(), journalClosed: false }), {
    sealed: false, unmet: ['S3'],
  });
  seedProposal();
  const row = attemptSeal(project, key('attempt-1'), {
    currentAttemptId: 'attempt-1', operands: sealOperands(['S3']),
  });
  assert.equal(row.state, 'proposed');
  assert.deepEqual([...row.unmet], ['S3']);
});

it('S4 dropped — a trajectory whose lifecycle validation is not ok refuses', () => {
  assert.deepEqual(evaluateSeal(sealOperands(['S4'])), { sealed: false, unmet: ['S4'] });
  seedProposal();
  const row = attemptSeal(project, key('attempt-1'), {
    currentAttemptId: 'attempt-1', operands: sealOperands(['S4']),
  });
  assert.equal(row.state, 'proposed');
  assert.deepEqual([...row.unmet], ['S4']);
});

it('the seal is the CONJUNCTION — all 16 subsets, `unmet` naming exactly the failing ones', () => {
  const all: readonly SealPrecondition[] = ['S1', 'S2', 'S3', 'S4'];
  for (let mask = 0; mask < 16; mask++) {
    const broken = all.filter((_, index) => (mask & (1 << index)) !== 0);
    const evaluation = evaluateSeal(sealOperands(broken));
    if (broken.length === 0) {
      assert.deepEqual(evaluation, { sealed: true }, 'all four held but the seal was refused');
      continue;
    }
    assert.deepEqual(evaluation, { sealed: false, unmet: broken },
      `subset ${broken.join('+')} did not refuse with exactly its own names`);
  }
  assert.deepEqual([...SEAL_PRECONDITIONS], ['S1', 'S2', 'S3', 'S4']);
});

it('S1∧S2∧S3∧S4 — the seal writes `sealed`, an empty `unmet` and a `settled_at`', () => {
  seedProposal();
  const row = sealed();
  assert.equal(row.state, 'sealed');
  assert.deepEqual([...row.unmet], []);
  assert.notEqual(row.settled_at, null);
  assert.equal(row.invalidated_by, null);
  assert.deepEqual(readProposalStore(project, TASK).proposals[0], row);
});

// ── §8.6 expiry with the attempt ────────────────────────────────────────────

it('a proposal that never reaches all four EXPIRES WITH ITS ATTEMPT and is not carried forward', () => {
  seedProposal('attempt-1');
  attemptSeal(project, key('attempt-1'), {
    currentAttemptId: 'attempt-1', operands: sealOperands(['S3']),
  });
  applyAttemptTerminal(project, TASK, 'attempt-1', 'failed');

  // The next attempt starts from `none`: the earlier conclusion is NOT inherited.
  assert.equal(eligibleOutcome(project, key('attempt-2')), null);
  assert.equal(
    readProposalStore(project, TASK).proposals.find(r => r.attempt_id === 'attempt-2'),
    undefined,
  );
  // Sealing the new attempt without its own proposal is refused, not granted from attempt-1's row.
  assert.throws(
    () => attemptSeal(project, key('attempt-2'), {
      currentAttemptId: 'attempt-2', operands: sealOperands(),
    }),
    (error: unknown) => error instanceof ProposalSealError && error.detail === 'proposal_absent',
  );
  // A later attempt may legitimately reach a different conclusion.
  recordProposal(project, { key: key('attempt-2'), intent: 'block', note: null });
  const row = attemptSeal(project, key('attempt-2'), {
    currentAttemptId: 'attempt-2', operands: sealOperands(),
  });
  assert.equal(row.state, 'sealed');
  assert.equal(row.intent, 'block');
});

// ── §8.6 V1-V4 ──────────────────────────────────────────────────────────────

it('V1 — failed/cancelled/timeout/aborted invalidate every proposal the attempt recorded', () => {
  for (const terminal of ['failed', 'cancelled', 'timeout', 'aborted'] as const) {
    const attempt = `attempt-${terminal}`;
    seedProposal(attempt);
    const [row] = applyAttemptTerminal(project, TASK, attempt, terminal);
    assert.equal(row.state, 'invalidated', `${terminal} did not invalidate`);
    assert.equal(row.invalidated_by, 'V1');
    assert.notEqual(row.settled_at, null);
  }
  // `completed` is not an invalidating terminal.
  seedProposal('attempt-ok');
  assert.deepEqual(applyAttemptTerminal(project, TASK, 'attempt-ok', 'completed'), []);
  assert.equal(
    readProposalStore(project, TASK).proposals.find(r => r.attempt_id === 'attempt-ok')!.state,
    'proposed',
  );
});

it('V1 — a failed attempt cannot seal even though S1-S4 all hold (S1 admits `failed`)', () => {
  seedProposal('attempt-1');
  applyAttemptTerminal(project, TASK, 'attempt-1', 'failed');
  // S1 is satisfied by a `failed` terminal — the conjunction alone would seal here.
  assert.deepEqual(evaluateSeal({ ...sealOperands(), threadStatus: 'failed', terminalManifestState: 'failed' }),
    { sealed: true });
  assert.throws(
    () => attemptSeal(project, key('attempt-1'), {
      currentAttemptId: 'attempt-1', operands: sealOperands(),
    }),
    (error: unknown) => error instanceof ProposalSealError
      && error.detail === 'proposal_invalidated'
      && error.code === 37,
  );
  assert.equal(eligibleOutcome(project, key('attempt-1')), null);
});

it('V2 — a proposal whose attempt is no longer current is invalidated ON SIGHT (D-9)', () => {
  seedProposal('attempt-1');
  const row = attemptSeal(project, key('attempt-1'), {
    currentAttemptId: 'attempt-2', operands: sealOperands(),
  });
  assert.equal(row.state, 'invalidated');
  assert.equal(row.invalidated_by, 'V2');
  assert.deepEqual([...row.unmet], []); // S1-S4 held; the cause is not a precondition
  assert.equal(eligibleOutcome(project, key('attempt-1')), null);
});

it('V3 — trial cancellation invalidates every outstanding proposal, and nothing seals after it', () => {
  seedProposal('attempt-1');
  seedProposal('attempt-2');
  const invalidated = cancelTrialProposals(project, TASK);
  assert.deepEqual(invalidated.map(r => r.attempt_id), ['attempt-1', 'attempt-2']);
  for (const row of invalidated) {
    assert.equal(row.state, 'invalidated');
    assert.equal(row.invalidated_by, 'V3');
  }
  // Nothing can seal during finalisation, S1-S4 notwithstanding.
  for (const attempt of ['attempt-1', 'attempt-2']) {
    assert.throws(
      () => attemptSeal(project, key(attempt), {
        currentAttemptId: attempt, operands: sealOperands(),
      }),
      (error: unknown) => error instanceof ProposalSealError && error.code === 37,
    );
  }
  assert.deepEqual(outstandingProposals(project, TASK), []);
});

it('V3 — a proposal already sealed before cancellation is not re-opened by it', () => {
  seedProposal('attempt-1');
  sealed('attempt-1');
  assert.deepEqual(cancelTrialProposals(project, TASK), []);
  assert.equal(readProposalStore(project, TASK).proposals[0].state, 'sealed');
});

it('V4 — an invalidated proposal is RECORDED, not discarded; `invalidated_by` names the rule', () => {
  seedProposal('attempt-1');
  const proposed = readProposalStore(project, TASK).proposals[0];
  assert.equal(proposed.invalidated_by, null); // null while `proposed`

  applyAttemptTerminal(project, TASK, 'attempt-1', 'cancelled');
  const rows = readProposalStore(project, TASK).proposals;
  assert.equal(rows.length, 1, 'the row was discarded instead of transitioned');
  assert.equal(rows[0].state, 'invalidated');
  assert.equal(rows[0].invalidated_by, 'V1');
  assert.equal(rows[0].proposed_at, proposed.proposed_at); // same row, not a replacement
  assert.equal(rows[0].intent, proposed.intent);
  assert.equal(rows[0].note, proposed.note);

  // ...and null while `sealed` too.
  seedProposal('attempt-2');
  assert.equal(sealed('attempt-2').invalidated_by, null);
  assert.deepEqual([...INVALIDATION_RULES], ['V1', 'V2', 'V3']);
  assert.equal((INVALIDATION_RULES as readonly string[]).includes('V4'), false);
});

it('V4 — invalidation CARRIES the last refused seal\'s findings, it does not erase them', () => {
  seedProposal('attempt-1');
  attemptSeal(project, key('attempt-1'), {
    currentAttemptId: 'attempt-1', operands: sealOperands(['S2', 'S3']),
  });
  const [invalidated] = applyAttemptTerminal(project, TASK, 'attempt-1', 'failed');
  // `unmet` is "empty when sealed; the failing preconditions otherwise" — an invalidated row that
  // was refused for S2 and S3 still says so.
  assert.deepEqual([...invalidated.unmet], ['S2', 'S3']);
  assert.equal(invalidated.state, 'invalidated');
  assert.equal(invalidated.invalidated_by, 'V1');
  assert.deepEqual([...readProposalStore(project, TASK).proposals[0].unmet], ['S2', 'S3']);

  // A row no seal was ever attempted for carries no findings, because none ever failed.
  seedProposal('attempt-2');
  const [never] = applyAttemptTerminal(project, TASK, 'attempt-2', 'failed');
  assert.deepEqual([...never.unmet], []);
});

// ── (17.2.3) the persisted row ──────────────────────────────────────────────

it('the persisted row is exactly (17.2.3)\'s TEN fields — enumerated, not row-counted', () => {
  assert.deepEqual([...PROPOSAL_ROW_KEYS], [
    'task_id', 'dispatch_generation', 'attempt_id', 'intent', 'note',
    'state', 'unmet', 'invalidated_by', 'proposed_at', 'settled_at',
  ]);
  assert.equal(PROPOSAL_ROW_KEYS.length, 10);
  seedProposal();
  const onDisk = JSON.parse(fs.readFileSync(proposalStorePath(project, TASK), 'utf8'));
  assert.deepEqual(Object.keys(onDisk.proposals[0]), [...PROPOSAL_ROW_KEYS]);
});

it('the row invariants — `unmet` empty iff sealed, `settled_at` non-null iff state != proposed', () => {
  const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  seedProposal('attempt-1');
  seedProposal('attempt-2');
  seedProposal('attempt-3');
  attemptSeal(project, key('attempt-1'), {
    currentAttemptId: 'attempt-1', operands: sealOperands(['S2', 'S4']),
  });
  sealed('attempt-2');
  applyAttemptTerminal(project, TASK, 'attempt-3', 'failed');

  for (const row of readProposalStore(project, TASK).proposals) {
    assert.match(row.proposed_at, stamp);
    assert.equal(row.settled_at !== null, row.state !== 'proposed', `settled_at wrong for ${row.state}`);
    if (row.settled_at !== null) assert.match(row.settled_at, stamp);
    // `unmet` is EMPTY when sealed, the failing preconditions otherwise.
    if (row.state === 'sealed') assert.deepEqual([...row.unmet], []);
  }
  const refused = readProposalStore(project, TASK).proposals[0];
  assert.deepEqual([...refused.unmet], ['S2', 'S4']);
  assert.deepEqual([...readProposalStore(project, TASK).proposals[1].unmet], []);
});

// ── G4-SM3 path and atomicity ───────────────────────────────────────────────

it('G4-SM3 — same directory and same atomic write as the ledger, a DIFFERENT file', () => {
  assert.equal(
    proposalStorePath(project, TASK),
    path.join(managerNodeDir(project, TASK), 'proposals.json'),
  );
  assert.equal(
    path.dirname(proposalStorePath(project, TASK)),
    path.dirname(ledgerPath(project, TASK)),
  );
  assert.notEqual(proposalStorePath(project, TASK), ledgerPath(project, TASK));

  seedProposal();
  assert.deepEqual(atomic.paths, [proposalStorePath(project, TASK)]);
  assert.deepEqual(fs.readdirSync(managerNodeDir(project, TASK)), ['proposals.json']);
});

// ── G4-SM4 fail CLOSED ──────────────────────────────────────────────────────

it('G4-SM4 — a corrupt store raises the SHIPPED code 42, never an empty store', () => {
  const target = proposalStorePath(project, TASK);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{ not json');
  assert.throws(
    () => readProposalStore(project, TASK),
    (error: unknown) => error instanceof ProposalSealError
      && error.code === 42
      && error.reason === 'ledger_unreadable'
      && error.detail === 'store_unreadable',
  );
  // The code is the shipped one; nothing new was allocated.
  const shipped = BENCHMARK_FAILURES.find(f => f.code === 42)!;
  assert.equal(shipped.reason, 'ledger_unreadable');
  assert.equal(BENCHMARK_FAILURES.filter(f => f.code === 42).length, 1);
});

it('G4-SM4 — an unreadable store (a directory in its place) raises 42, and so does a bad shape', () => {
  const target = proposalStorePath(project, TASK);
  fs.mkdirSync(target, { recursive: true });
  assert.throws(
    () => readProposalStore(project, TASK),
    (error: unknown) => error instanceof ProposalSealError && error.code === 42,
  );
  fs.rmSync(target, { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ proposals: 'not-an-array' }));
  assert.throws(
    () => readProposalStore(project, TASK),
    (error: unknown) => error instanceof ProposalSealError && error.code === 42,
  );
});

it('G4-SM4 — a row timestamp outside the SHIPPED grammar is a corrupt store, not a lenient read', () => {
  // (17.2.3) types both row timestamps as TIMESTAMP_PATTERN, so `typeof === "string"` is not the
  // contract. The restated pattern is checked against the shipped validator, never against itself.
  for (const candidate of [
    '2026-08-06T00:00:00.000Z',
    '2026-08-06T00:00:00Z',
    '2026-08-06T00:00:00.000+00:00',
    '2026-08-06',
    'not-a-time',
    '',
  ]) {
    writeStoreFile([validRow({ proposed_at: candidate })]);
    assert.equal(storeReadable(), shippedAcceptsTimestamp(candidate),
      `proposed_at grammar disagrees with manifest-contract.ts for ${candidate || '<empty>'}`);
  }
  // ...and the nullable one: null is legal, a malformed string is not.
  writeStoreFile([validRow({ state: 'sealed', settled_at: '2026-08-06T00:00:00.000Z' })]);
  assert.equal(storeReadable(), true);
  writeStoreFile([validRow({ state: 'sealed', settled_at: '2026-08-06' })]);
  assert.equal(storeReadable(), false);
  // Every timestamp this module WRITES satisfies the grammar it enforces on read.
  fs.rmSync(proposalStorePath(project, TASK));
  seedProposal();
  sealed();
  assert.equal(storeReadable(), true);
});

it('G4-SM4 — a MISSING store is the absence of a row, not a read error', () => {
  assert.equal(fs.existsSync(proposalStorePath(project, TASK)), false);
  assert.deepEqual(readProposalStore(project, TASK).proposals, []);
});

it('G4-N6 — the shipped ledger\'s fail-open is RECORDED, not repaired, by this increment', () => {
  const target = ledgerPath(project, TASK);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{ not json');
  assert.deepEqual(readLedger(project, TASK), { parent: TASK, project, children: {} });
});

// ── G4-SM5 append-only per attempt ──────────────────────────────────────────

it('G4-SM5 — the row count over a trial equals the number of attempts that ever proposed', () => {
  seedProposal('attempt-1');
  applyAttemptTerminal(project, TASK, 'attempt-1', 'failed');
  seedProposal('attempt-2');
  attemptSeal(project, key('attempt-2'), {
    currentAttemptId: 'attempt-3', operands: sealOperands(),
  });
  seedProposal('attempt-3');
  sealed('attempt-3');

  const rows = readProposalStore(project, TASK).proposals;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.attempt_id), ['attempt-1', 'attempt-2', 'attempt-3']);
  assert.deepEqual(rows.map(r => r.state), ['invalidated', 'invalidated', 'sealed']);
  assert.equal(new Set(rows.map(r => r.attempt_id)).size, 3, 'an attempt_id was re-used');
});

it('G4-SM5 — re-proposing on a live attempt transitions the SAME row, never appends a second', () => {
  seedProposal('attempt-1', 'first');
  const again = recordProposal(project, {
    key: key('attempt-1'), intent: 'block', note: 'second',
  });
  const rows = readProposalStore(project, TASK).proposals;
  assert.equal(rows.length, 1);
  assert.equal(again.intent, 'block');
  assert.equal(again.note, 'second');
  assert.equal(again.proposed_at, rows[0].proposed_at);
});

it('G4-SM5 — a settled row is never re-opened by a later proposal', () => {
  seedProposal('attempt-1');
  sealed('attempt-1');
  assert.throws(
    () => recordProposal(project, { key: key('attempt-1'), intent: 'block', note: null }),
    (error: unknown) => error instanceof ProposalSealError && error.detail === 'proposal_already_sealed',
  );
  seedProposal('attempt-2');
  applyAttemptTerminal(project, TASK, 'attempt-2', 'aborted');
  assert.throws(
    () => recordProposal(project, { key: key('attempt-2'), intent: 'block', note: null }),
    (error: unknown) => error instanceof ProposalSealError && error.code === 37,
  );
  assert.equal(readProposalStore(project, TASK).proposals.length, 2);
});

// ── G4-SM6 the two edge kinds ───────────────────────────────────────────────

it('G4-SM6 — a `proposal` edge for every row and a `seal` edge for every sealed row', () => {
  seedProposal('attempt-1');
  applyAttemptTerminal(project, TASK, 'attempt-1', 'failed');
  seedProposal('attempt-2');
  sealed('attempt-2');

  const edges = proposalStoreEdges(readProposalStore(project, TASK).proposals);
  assert.deepEqual(edges.map(e => e.kind), ['proposal', 'proposal', 'seal']);
  assert.deepEqual(edges[0], {
    kind: 'proposal',
    from: { ref: 'attempt', id: 'attempt-1' },
    to: { ref: 'proposal', id: 'proposal-attempt-1' },
  });
  assert.deepEqual(edges[2], {
    kind: 'seal',
    from: { ref: 'proposal', id: 'proposal-attempt-2' },
    to: { ref: 'outcome', id: 'outcome-attempt-2' },
  });
  // The union is CONSUMED, never extended: both kinds are already members, and there are 13.
  assert.equal(ATTEMPT_EDGE_KINDS.length, 13);
  for (const edge of edges) {
    assert.equal((ATTEMPT_EDGE_KINDS as readonly string[]).includes(edge.kind), true);
    const legality = EDGE_ENDPOINT_LEGALITY[edge.kind];
    assert.equal(legality.from.includes(edge.from.ref), true);
    assert.equal(legality.to.includes(edge.to.ref), true);
  }
});

// ── G4-SM7 no substring anywhere on the seal path ───────────────────────────

it('G4-SM7 — a `note` that looks like a verdict marker changes NOTHING', () => {
  const marker = VERDICT_BY_VARIANT['audit-retry'].marker;
  const note = `${marker} ${VERDICT_BY_VARIANT['reviewer-fix'].marker} complete sealed accepted`;
  recordProposal(project, { key: key('attempt-1'), intent: 'block', note });

  // The marker does not seal an unsealable proposal...
  const refused = attemptSeal(project, key('attempt-1'), {
    currentAttemptId: 'attempt-1', operands: sealOperands(['S3']),
  });
  assert.equal(refused.state, 'proposed');
  assert.deepEqual([...refused.unmet], ['S3']);

  // ...and it does not change the intent, the cause, or the outcome once the facts do seal it.
  const row = sealed('attempt-1');
  assert.equal(row.state, 'sealed');
  assert.equal(row.intent, 'block');
  assert.equal(row.note, note); // carried opaquely, byte for byte
  assert.equal(eligibleOutcome(project, key('attempt-1'))!.intent, 'block');

  // The same structural facts with an empty note produce the same state.
  recordProposal(project, { key: key('attempt-2'), intent: 'block', note: null });
  assert.equal(sealed('attempt-2').state, row.state);
});

// ── §8.6 the callback rule ──────────────────────────────────────────────────

it('callback (a) — a callback arriving BEFORE the seal consumes nothing', async () => {
  seedProposal('attempt-1');
  assert.equal(eligibleOutcome(project, key('attempt-1')), null);
  attemptSeal(project, key('attempt-1'), {
    currentAttemptId: 'attempt-1', operands: sealOperands(['S4']),
  });
  assert.equal(eligibleOutcome(project, key('attempt-1')), null);
  assert.deepEqual(outstandingProposals(project, TASK).map(r => r.attempt_id), ['attempt-1']);
});

it('callback (b) — a callback arriving AFTER the seal consumes the outcome exactly once', async () => {
  seedProposal('attempt-1');
  sealed('attempt-1');
  const outcome = eligibleOutcome(project, key('attempt-1'));
  assert.deepEqual(outcome, {
    task_id: TASK, dispatch_generation: 'gen-1', attempt_id: 'attempt-1',
    intent: 'complete', note: 'note',
  });
  // Eligibility is what the seal produces; the shipped ledger governs the delivery count.
  assert.equal(await recordDelivered(project, 'parent-1', TASK, 'completed'), true);
  recordVerdict(project, 'parent-1', TASK, 'accepted');
  assert.equal(await recordDelivered(project, 'parent-1', TASK, 'completed'), false);
  assert.deepEqual(outstandingProposals(project, TASK), []);
});

it('callback (c) — re-delivery is governed by the shipped acceptance ledger', async () => {
  seedProposal('attempt-1');
  sealed('attempt-1');
  assert.notEqual(eligibleOutcome(project, key('attempt-1')), null);

  assert.equal(await recordDelivered(project, 'parent-1', TASK, 'completed'), true);
  recordVerdict(project, 'parent-1', TASK, 'rejected', 'rework it');
  const rejected = readLedger(project, 'parent-1').children[TASK];
  assert.equal(rejected.verdict, 'rejected');
  assert.equal(rejected.rework_round, 1);

  // A rejected child re-opens to `pending` with its rework_round preserved (`:65-73`).
  assert.equal(await recordDelivered(project, 'parent-1', TASK, 'completed'), true);
  const reopened = readLedger(project, 'parent-1').children[TASK];
  assert.equal(reopened.verdict, 'pending');
  assert.equal(reopened.rework_round, 1);

  // Delivery stays at-least-once BY DESIGN — the seal makes it eligible, not exactly-once.
  assert.equal(await recordDelivered(project, 'parent-1', TASK, 'completed'), true);
  assert.notEqual(eligibleOutcome(project, key('attempt-1')), null);
});

// ── §9.4 M-12 ───────────────────────────────────────────────────────────────

it('M-12 — `no outstanding proposal` is assertable: every row is sealed or invalidated', () => {
  seedProposal('attempt-1');
  seedProposal('attempt-2');
  assert.deepEqual(outstandingProposals(project, TASK).map(r => r.attempt_id),
    ['attempt-1', 'attempt-2']);
  sealed('attempt-1');
  assert.deepEqual(outstandingProposals(project, TASK).map(r => r.attempt_id), ['attempt-2']);
  applyAttemptTerminal(project, TASK, 'attempt-2', 'timeout');
  assert.deepEqual(outstandingProposals(project, TASK), []);
  const rows = readProposalStore(project, TASK).proposals;
  assert.equal(rows.every(r => r.state === 'sealed' || r.state === 'invalidated'), true);
});
