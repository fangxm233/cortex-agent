// input:  Vitest, threadStore singleton, isolated CORTEX_HOME
// output: regression tests for ThreadRepo cleanup archival
// pos:    verifies terminal threads are archived to JSONL, not discarded
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { threadStore } from '../../src/store/thread-repo.js';
import { STORE_DIR, DATA_DIR } from '../../src/core/paths.js';
import type { ThreadRecord } from '../../src/core/types/thread-types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_FILE = path.join(STORE_DIR, 'archive', 'threads-archive.jsonl');

function makeThread(id: string, status: ThreadRecord['status'], workspacePath: string): ThreadRecord {
  const now = new Date().toISOString();
  return {
    id, templateName: 'tmpl', status, channel: 'C1', projectId: 'proj',
    platformThreadId: null, userMessage: 'm', userMessageTs: now,
    workspacePath, artifactPath: workspacePath ? path.join(workspacePath, 'artifact.md') : '',
    agents: {}, activeAgent: '', activeStage: null, currentStepIndex: 0, steps: [],
    iterationCounts: {}, totalCostUsd: 0,
    createdAt: now, updatedAt: now, endedAt: now, error: null, abortReason: null,
    metadata: null,
  };
}

/** Backdate a record in the in-memory map (set() stamps updatedAt, so mutate the live object). */
function backdateThread(id: string, daysAgo: number): void {
  const rec = threadStore.get(id);
  assert.ok(rec, `backdate: missing thread ${id}`);
  rec!.updatedAt = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
}

function readArchiveIds(): string[] {
  if (!fs.existsSync(ARCHIVE_FILE)) return [];
  return fs.readFileSync(ARCHIVE_FILE, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l).id);
}

test('cleanup - old terminal thread is archived to JSONL and removed; workspace dir deleted', async () => {
  const wsOld = path.join(DATA_DIR, 'tmp', 'threads', 'thr_arch0001');
  fs.mkdirSync(wsOld, { recursive: true });
  fs.writeFileSync(path.join(wsOld, 'artifact.md'), 'x');
  const wsKeep = path.join(DATA_DIR, 'tmp', 'threads', 'thr_arch0002');
  fs.mkdirSync(wsKeep, { recursive: true });

  await threadStore.set(makeThread('thr_arch0001', 'completed', wsOld));
  backdateThread('thr_arch0001', 8);
  await threadStore.set(makeThread('thr_arch0002', 'completed', wsKeep));

  await threadStore.cleanup();

  // Old terminal thread: gone from the store, present in the archive, workspace removed
  assert.equal(threadStore.get('thr_arch0001'), null);
  assert.ok(readArchiveIds().includes('thr_arch0001'), 'archived record must land in the JSONL archive');
  assert.ok(!fs.existsSync(wsOld), 'workspace dir of an archived thread is still cleaned up');

  // Recent terminal thread untouched
  assert.ok(threadStore.get('thr_arch0002'));
  assert.ok(!readArchiveIds().includes('thr_arch0002'));

  // Persisted store no longer contains the archived record
  const onDisk = JSON.parse(fs.readFileSync(path.join(STORE_DIR, 'threads.json'), 'utf8'));
  assert.ok(!('thr_arch0001' in onDisk));
  assert.ok('thr_arch0002' in onDisk);
});

test('cleanup - archived record round-trips with full content (no field loss)', async () => {
  const ws = path.join(DATA_DIR, 'tmp', 'threads', 'thr_arch0003');
  fs.mkdirSync(ws, { recursive: true });
  const rec = makeThread('thr_arch0003', 'failed', ws);
  rec.error = 'boom';
  rec.totalCostUsd = 1.25;
  await threadStore.set(rec);
  backdateThread('thr_arch0003', 9);

  await threadStore.cleanup();

  const line = fs.readFileSync(ARCHIVE_FILE, 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).find((r) => r.id === 'thr_arch0003');
  assert.ok(line, 'record must be in the archive');
  assert.equal(line.error, 'boom');
  assert.equal(line.totalCostUsd, 1.25);
  assert.equal(line.status, 'failed');
});

test('cleanup - successive runs append to the archive, never overwrite', async () => {
  const before = readArchiveIds();
  const ws = path.join(DATA_DIR, 'tmp', 'threads', 'thr_arch0004');
  fs.mkdirSync(ws, { recursive: true });
  await threadStore.set(makeThread('thr_arch0004', 'cancelled', ws));
  backdateThread('thr_arch0004', 8);

  await threadStore.cleanup();

  const after = readArchiveIds();
  assert.deepEqual(after.slice(0, before.length), before, 'previous archive lines must survive');
  assert.ok(after.includes('thr_arch0004'));
});
