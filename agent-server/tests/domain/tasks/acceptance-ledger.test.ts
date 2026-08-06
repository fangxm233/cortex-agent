// input:  Vitest, the shipped acceptance ledger and a temp project node
// output: D-10 widening, preserved history and the unchanged shipped delivery semantics
// pos:    Acceptance ledger verdict and delivery contract tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, it } from 'vitest';

import { PROJECTS_DIR } from '../../../src/core/paths.js';
import {
  ledgerPath, pendingDeliveries, readLedger, recordDelivered, recordVerdict,
  type LedgerEntry, type LedgerVerdict,
} from '../../../src/domain/tasks/acceptance-ledger.js';

let counter = 0;
let project = '';
const PARENT = 'p001';
const CHILD = 'c001';

beforeEach(() => {
  project = `_test_ledger_${++counter}`;
  fs.mkdirSync(path.join(PROJECTS_DIR, project), { recursive: true });
});

function writeLedgerFile(children: Record<string, LedgerEntry>): void {
  const target = ledgerPath(project, PARENT);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ parent: PARENT, project, children }, null, 2));
}

function supersededEntry(): LedgerEntry {
  return {
    child: CHILD,
    kind: 'completed',
    delivered_at: '2026-08-06T00:00:00.000Z',
    verdict: 'superseded',
    verdict_at: '2026-08-06T00:00:01.000Z',
    verdict_note: 'replaced by the rerun',
    rework_round: 2,
    superseded_by: 'c002',
  };
}

it('D-10 — `superseded` is a fourth verdict and `superseded_by` rides with it', () => {
  // Type-level: the union admits it (checked by `tsc --noEmit`, which covers tests/).
  const verdicts: LedgerVerdict[] = ['pending', 'accepted', 'rejected', 'superseded'];
  assert.equal(verdicts.length, 4);

  writeLedgerFile({ [CHILD]: supersededEntry() });
  const entry = readLedger(project, PARENT).children[CHILD];
  assert.equal(entry.verdict, 'superseded');
  assert.equal(entry.superseded_by, 'c002');
  // A superseded child is not outstanding — §9.4 M-4 counts `pending`, and M-3 admits `superseded`.
  assert.deepEqual(pendingDeliveries(project, PARENT), []);
});

it('D-10 — `superseded_by` is ALWAYS PRESENT, defaulting to null on a fresh delivery', async () => {
  assert.equal(await recordDelivered(project, PARENT, CHILD, 'completed'), true);
  const entry = readLedger(project, PARENT).children[CHILD];
  assert.equal(Object.hasOwn(entry, 'superseded_by'), true);
  assert.equal(entry.superseded_by, null);
  recordVerdict(project, PARENT, 'c-absent', 'accepted');
  assert.equal(readLedger(project, PARENT).children['c-absent'].superseded_by, null);
});

it('D-10 — `superseded_by` survives re-delivery and a later verdict, as `rework_round` does', async () => {
  writeLedgerFile({ [CHILD]: supersededEntry() });

  assert.equal(await recordDelivered(project, PARENT, CHILD, 'completed'), true);
  const redelivered = readLedger(project, PARENT).children[CHILD];
  assert.equal(redelivered.superseded_by, 'c002', 'the supersession history was dropped');
  assert.equal(redelivered.rework_round, 2);
  assert.equal(redelivered.verdict, 'pending');

  recordVerdict(project, PARENT, CHILD, 'accepted');
  const judged = readLedger(project, PARENT).children[CHILD];
  assert.equal(judged.superseded_by, 'c002');
  assert.equal(judged.verdict, 'accepted');
});

it('the shipped delivery semantics are UNCHANGED — accepted refuses, rejected re-opens', async () => {
  assert.equal(await recordDelivered(project, PARENT, CHILD, 'completed'), true);
  recordVerdict(project, PARENT, CHILD, 'accepted');
  assert.equal(await recordDelivered(project, PARENT, CHILD, 'completed'), false);

  const other = 'c003';
  assert.equal(await recordDelivered(project, PARENT, other, 'blocked'), true);
  recordVerdict(project, PARENT, other, 'rejected', 'again');
  assert.equal(readLedger(project, PARENT).children[other].rework_round, 1);
  assert.equal(await recordDelivered(project, PARENT, other, 'completed'), true);
  const reopened = readLedger(project, PARENT).children[other];
  assert.equal(reopened.verdict, 'pending');
  assert.equal(reopened.rework_round, 1);
  assert.equal(reopened.verdict_note, 'again');
});

it('G4-N6 — `readLedger`\'s fail-open is RECORDED, not repaired, by this increment', () => {
  const target = ledgerPath(project, PARENT);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'not json at all');
  assert.deepEqual(readLedger(project, PARENT), { parent: PARENT, project, children: {} });
});
