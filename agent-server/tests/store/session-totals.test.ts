// input:  execution-shaped rows and the archive carry repo
// output: coverage of the session-totals fold rule and its exactly-once carry
// pos:    store session-totals specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyForTotals, emptyTotalsAcc, foldExecution, toSessionTotals,
  type ExecutionLike,
} from '../../src/store/session-totals.js';
import { SessionTotalsCarryRepo } from '../../src/store/session-totals-repo.js';

function run(over: Partial<ExecutionLike> & {
  sessionId?: string | null; ownerSessionId?: string | null; threadId?: string | null;
  endedAt?: string | null; numTurns?: number | null; costUsd?: number | null; durationS?: number | null;
} = {}): ExecutionLike {
  return {
    session: { sessionId: over.sessionId ?? null, ownerSessionId: over.ownerSessionId ?? null },
    thread: over.threadId ? { threadId: over.threadId, agentSlotId: null } : null,
    runtime: {
      startedAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:10:00.000Z',
      endedAt: over.endedAt === undefined ? '2026-05-01T00:10:00.000Z' : over.endedAt,
    },
    metrics: {
      costUsd: over.costUsd ?? null,
      numTurns: over.numTurns ?? null,
      durationS: over.durationS ?? null,
    },
  };
}

function fold(records: ExecutionLike[], carriedThrough?: string | null) {
  const acc = new Map<string, ReturnType<typeof emptyTotalsAcc>>();
  for (const record of records) foldExecution(acc, record, carriedThrough);
  return acc;
}

// ── classification ──

test('classifyForTotals: own run, subagent child, thread run, unfinished run', () => {
  assert.deepEqual(classifyForTotals(run({ sessionId: 's1' })), { sessionId: 's1', role: 'own' });
  assert.deepEqual(
    classifyForTotals(run({ sessionId: null, ownerSessionId: 's1' })),
    { sessionId: 's1', role: 'subagent' },
  );
  // A thread runs beside its parent and is accounted for in the thread views.
  assert.equal(classifyForTotals(run({ sessionId: 's1', threadId: 'thr_x' })), null);
  // An in-flight turn has no final numbers; counting it would make totals jump around mid-turn.
  assert.equal(classifyForTotals(run({ sessionId: 's1', endedAt: null })), null);
  // No session at all (a legacy child with no owner link) belongs to nobody.
  assert.equal(classifyForTotals(run({})), null);
});

// ── the fold rule ──

test('totals sum a session’s own finished runs', () => {
  const acc = fold([
    run({ sessionId: 's1', numTurns: 300, costUsd: 32.5, durationS: 4477 }),
    run({ sessionId: 's1', numTurns: 12, costUsd: 1.5, durationS: 63 }),
    run({ sessionId: 's2', numTurns: 4, costUsd: 0.25, durationS: 10 }),
  ]);
  assert.deepEqual(toSessionTotals(acc.get('s1')), {
    runs: 2, turns: 312, activeMs: 4540_000, costUsd: 34, subagentCostUsd: null,
  });
  assert.deepEqual(toSessionTotals(acc.get('s2')), {
    runs: 1, turns: 4, activeMs: 10_000, costUsd: 0.25, subagentCostUsd: null,
  });
});

test('a subagent child adds COST to its owner, but never turns or time', () => {
  // A child runs INSIDE the parent turn: adding its duration would double-count wall time, and its
  // turns are not rounds of the conversation. Its money, though, is real and additive.
  const acc = fold([
    run({ sessionId: 's1', numTurns: 300, costUsd: 32.51, durationS: 4477 }),
    run({ ownerSessionId: 's1', numTurns: 52, costUsd: 1.95, durationS: 300 }),
    run({ ownerSessionId: 's1', numTurns: 47, costUsd: 1.55, durationS: 250 }),
  ]);
  const totals = toSessionTotals(acc.get('s1'))!;
  assert.equal(totals.runs, 1, 'children are not runs of the conversation');
  assert.equal(totals.turns, 300, 'children do not inflate the turn count');
  assert.equal(totals.activeMs, 4477_000, 'children do not extend wall time');
  assert.equal(Number(totals.costUsd!.toFixed(2)), 36.01, 'parent + both children');
  assert.equal(Number(totals.subagentCostUsd!.toFixed(2)), 3.5);
});

test('a session whose only spend was a child still reports totals', () => {
  const acc = fold([run({ ownerSessionId: 's1', costUsd: 0.44 })]);
  assert.deepEqual(toSessionTotals(acc.get('s1')), {
    runs: 0, turns: 0, activeMs: 0, costUsd: 0.44, subagentCostUsd: 0.44,
  });
});

test('missing cost stays unknown instead of collapsing to $0.00', () => {
  const acc = fold([run({ sessionId: 's1', numTurns: 3 })]);
  const totals = toSessionTotals(acc.get('s1'))!;
  assert.equal(totals.costUsd, null, 'no run reported a cost ⇒ — , not a confident zero');
  assert.equal(totals.runs, 1);
  // A run that DID report zero is a different statement.
  const zero = fold([run({ sessionId: 's1', numTurns: 3, costUsd: 0 })]);
  assert.equal(toSessionTotals(zero.get('s1'))!.costUsd, 0);
});

test('a session that never finished a run has no totals at all', () => {
  const acc = fold([run({ sessionId: 's1', endedAt: null, numTurns: 4 })]);
  assert.equal(toSessionTotals(acc.get('s1')), null);
  assert.equal(toSessionTotals(undefined), null);
});

test('records already carried (ended before the watermark) are not folded twice', () => {
  const records = [
    run({ sessionId: 's1', endedAt: '2026-04-01T00:00:00.000Z', numTurns: 5, costUsd: 1 }),
    run({ sessionId: 's1', endedAt: '2026-06-01T00:00:00.000Z', numTurns: 7, costUsd: 2 }),
  ];
  const all = toSessionTotals(fold(records).get('s1'))!;
  assert.equal(all.turns, 12);
  // With a watermark between them, the older record is the carry's business, not the live pass's.
  const live = toSessionTotals(fold(records, '2026-05-01T00:00:00.000Z').get('s1'))!;
  assert.equal(live.turns, 7);
  assert.equal(live.runs, 1);
  assert.equal(live.costUsd, 2);
});

// ── the persisted carry ──

let tmpDir: string;
let carryPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-totals-'));
  carryPath = path.join(tmpDir, 'session-totals.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('carry: folding archived records accumulates per session and advances the watermark', async () => {
  const repo = new SessionTotalsCarryRepo(carryPath);
  await repo.fold([
    run({ sessionId: 's1', numTurns: 5, costUsd: 1, durationS: 30 }),
    run({ ownerSessionId: 's1', costUsd: 0.5 }),
    run({ sessionId: 's2', numTurns: 2, costUsd: 0.25, durationS: 10 }),
  ], '2026-05-01T00:00:00.000Z');

  const first = await repo.read();
  assert.equal(first.carriedThrough, '2026-05-01T00:00:00.000Z');
  assert.deepEqual(toSessionTotals(first.sessions['s1']), {
    runs: 1, turns: 5, activeMs: 30_000, costUsd: 1.5, subagentCostUsd: 0.5,
  });

  // A second sweep adds to the same session and moves the watermark forward.
  await repo.fold([run({ sessionId: 's1', numTurns: 3, costUsd: 2, durationS: 20 })], '2026-06-01T00:00:00.000Z');
  const second = await repo.read();
  assert.equal(second.carriedThrough, '2026-06-01T00:00:00.000Z');
  assert.deepEqual(toSessionTotals(second.sessions['s1']), {
    runs: 2, turns: 8, activeMs: 50_000, costUsd: 3.5, subagentCostUsd: 0.5,
  });
  assert.deepEqual(toSessionTotals(second.sessions['s2']), {
    runs: 1, turns: 2, activeMs: 10_000, costUsd: 0.25, subagentCostUsd: null,
  });
});

test('carry: the watermark never moves backwards', async () => {
  const repo = new SessionTotalsCarryRepo(carryPath);
  await repo.fold([run({ sessionId: 's1', numTurns: 1 })], '2026-06-01T00:00:00.000Z');
  await repo.fold([run({ sessionId: 's1', numTurns: 1 })], '2026-05-01T00:00:00.000Z');
  assert.equal((await repo.read()).carriedThrough, '2026-06-01T00:00:00.000Z');
});

test('carry: a deleted session is forgotten, and garbage entries are dropped on read', async () => {
  const repo = new SessionTotalsCarryRepo(carryPath);
  await repo.fold([
    run({ sessionId: 's1', numTurns: 1, costUsd: 1 }),
    run({ sessionId: 's2', numTurns: 1, costUsd: 1 }),
  ], '2026-05-01T00:00:00.000Z');
  await repo.forget(['s1']);
  const after = await repo.read();
  assert.equal(after.sessions['s1'], undefined);
  assert.ok(after.sessions['s2']);

  await fs.writeFile(carryPath, JSON.stringify({
    carriedThrough: 7, sessions: { good: { runs: 2 }, bad: 'nope' },
  }), 'utf8');
  const reloaded = new SessionTotalsCarryRepo(carryPath);
  const data = await reloaded.read();
  assert.equal(data.carriedThrough, null, 'a non-string watermark is not trusted');
  assert.equal(data.sessions['bad'], undefined);
  assert.deepEqual(data.sessions['good'], {
    runs: 2, turns: 0, activeMs: 0, cost: 0, costSamples: 0, subCost: 0, subSamples: 0,
  });
});

test('carry: an empty batch never creates the file', async () => {
  const repo = new SessionTotalsCarryRepo(carryPath);
  await repo.fold([], '2026-05-01T00:00:00.000Z');
  await assert.rejects(fs.access(carryPath), 'a sweep that archived nothing must not write');
});
