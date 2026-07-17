// input:  Node test runner + core/task-node path helpers + domain/tasks/acceptance-ledger
// output: task-keyed artifact path / ensureTaskArtifact idempotency / ledger verdict lifecycle tests
// pos:    Verify DR-0017 W1 foundations: task-keyed manager artifacts + acceptance ledger
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { managerNodeDir, taskArtifactPath, ensureTaskArtifact } from '../src/core/task-node.js';
import {
  ledgerPath,
  readLedger,
  recordDelivered,
  recordVerdict,
  pendingDeliveries,
} from '../src/domain/tasks/acceptance-ledger.js';

const projectDirs: string[] = [];

afterAll(() => {
  for (const d of projectDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function trackProject(name: string): string {
  const dir = path.join(PROJECTS_DIR, name);
  projectDirs.push(dir);
  return dir;
}

// --- path helpers ---

test('managerNodeDir / taskArtifactPath / ledgerPath live under the project context dir', () => {
  trackProject('_tn_pa');
  assert.equal(managerNodeDir('_tn_pa', 'ab12'), path.join(PROJECTS_DIR, '_tn_pa', 'manager', 'ab12'));
  assert.equal(taskArtifactPath('_tn_pa', 'ab12'), path.join(PROJECTS_DIR, '_tn_pa', 'manager', 'ab12', 'artifact.md'));
  assert.equal(ledgerPath('_tn_pa', 'ab12'), path.join(PROJECTS_DIR, '_tn_pa', 'manager', 'ab12', 'ledger.json'));
});

test('ensureTaskArtifact creates dir+file once and never truncates existing content', () => {
  trackProject('_tn_pb');
  const p = ensureTaskArtifact('_tn_pb', 'cd34');
  assert.ok(fs.existsSync(p), 'artifact file created');
  fs.writeFileSync(p, 'checkpoint v1');
  const again = ensureTaskArtifact('_tn_pb', 'cd34');
  assert.equal(again, p);
  assert.equal(fs.readFileSync(p, 'utf8'), 'checkpoint v1', 'existing checkpoint must survive re-ensure (rotation rehydration)');
});

// --- ledger lifecycle ---

test('readLedger returns an empty ledger when the file is missing', () => {
  trackProject('_tn_pc');
  assert.deepEqual(readLedger('_tn_pc', 'ef56').children, {});
});

test('recordDelivered creates a pending entry and allows re-delivery while pending', async () => {
  trackProject('_tn_pd');
  assert.equal(await recordDelivered('_tn_pd', 'aa11', 'bb22', 'completed'), true);
  const e = readLedger('_tn_pd', 'aa11').children['bb22'];
  assert.equal(e.verdict, 'pending');
  assert.equal(e.kind, 'completed');
  assert.equal(e.rework_round, 0);
  assert.ok(e.delivered_at, 'delivered_at stamped');
  assert.equal(await recordDelivered('_tn_pd', 'aa11', 'bb22', 'completed'), true,
    'pending entry → re-delivery to a new manager incarnation stays allowed');
});

test('accepted verdict blocks re-delivery; rejected re-opens with a rework_round bump', async () => {
  trackProject('_tn_pe');
  await recordDelivered('_tn_pe', 'aa33', 'bb44', 'completed');
  await recordVerdict('_tn_pe', 'aa33', 'bb44', 'accepted', 'deliverable checks out');
  assert.equal(readLedger('_tn_pe', 'aa33').children['bb44'].verdict, 'accepted');
  assert.equal(await recordDelivered('_tn_pe', 'aa33', 'bb44', 'completed'), false,
    'accepted child must never re-deliver (cross-incarnation dedupe)');

  await recordDelivered('_tn_pe', 'aa33', 'cc55', 'completed');
  await recordVerdict('_tn_pe', 'aa33', 'cc55', 'rejected', 'tests fail');
  const rejected = readLedger('_tn_pe', 'aa33').children['cc55'];
  assert.equal(rejected.verdict, 'rejected');
  assert.equal(rejected.rework_round, 1);
  assert.equal(await recordDelivered('_tn_pe', 'aa33', 'cc55', 'completed'), true,
    'rejected child re-delivers after rework');
  const reopened = readLedger('_tn_pe', 'aa33').children['cc55'];
  assert.equal(reopened.verdict, 'pending', 're-delivery re-opens the verdict');
  assert.equal(reopened.rework_round, 1, 'rework count survives re-delivery');
});

test('pendingDeliveries lists only pending entries', async () => {
  trackProject('_tn_pf');
  await recordDelivered('_tn_pf', 'aa66', 'p1', 'completed');
  await recordDelivered('_tn_pf', 'aa66', 'p2', 'blocked');
  await recordVerdict('_tn_pf', 'aa66', 'p1', 'accepted');
  assert.deepEqual(pendingDeliveries('_tn_pf', 'aa66').map((e) => e.child), ['p2']);
});

test('corrupt ledger file degrades to empty and is replaced by the next write', async () => {
  trackProject('_tn_pg');
  const lp = ledgerPath('_tn_pg', 'aa77');
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  fs.writeFileSync(lp, '{not json');
  assert.deepEqual(readLedger('_tn_pg', 'aa77').children, {});
  assert.equal(await recordDelivered('_tn_pg', 'aa77', 'xx88', 'completed'), true);
  assert.equal(readLedger('_tn_pg', 'aa77').children['xx88'].verdict, 'pending');
});
