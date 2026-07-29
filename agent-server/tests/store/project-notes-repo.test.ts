// input:  ProjectNotesRepository, temp files, deterministic clock/id
// output: Markdown round-trip, CRUD, safety and concurrency regressions
// pos:    Tests the per-project private notes persistence layer
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ProjectNotesRepository,
  parseNotesMarkdown,
  serializeNotesMarkdown,
  type ProjectNote,
} from '../../src/store/project-notes-repo.js';

const ACTIVE: ProjectNote = {
  id: 'note-active',
  text: 'Run the friction ablation',
  completed: false,
  createdAt: '2026-07-29T10:00:00.000Z',
  updatedAt: '2026-07-29T10:00:00.000Z',
  completedAt: null,
};

const COMPLETED: ProjectNote = {
  id: 'note-done',
  text: 'Fix the dashboard port',
  completed: true,
  createdAt: '2026-07-28T10:00:00.000Z',
  updatedAt: '2026-07-29T09:00:00.000Z',
  completedAt: '2026-07-29T09:00:00.000Z',
};

function tempNotesPath(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cortex-notes-'));
  return path.join(dir, 'NOTES.md');
}

function deterministicRepo(): ProjectNotesRepository {
  let tick = 0;
  return new ProjectNotesRepository({
    now: () => new Date(Date.UTC(2026, 6, 29, 10, tick++)).toISOString(),
    id: () => `note-${tick}`,
  });
}

test('notes markdown round-trips stable metadata and keeps completed notes last', () => {
  const md = serializeNotesMarkdown([COMPLETED, ACTIVE]);
  assert.match(md, /^# Notes/m);
  assert.match(md, /<!-- cortex-project-notes:v1 -->/);
  assert.ok(md.indexOf('## Active') < md.indexOf('## Completed'));
  assert.ok(md.indexOf(ACTIVE.text) < md.indexOf(COMPLETED.text));
  assert.deepEqual(parseNotesMarkdown(md), [ACTIVE, COMPLETED]);
});

test('missing file lists empty and first add creates canonical NOTES.md', async () => {
  const file = tempNotesPath();
  const repo = deterministicRepo();
  assert.deepEqual(await repo.list(file), []);
  const created = await repo.add(file, '  Ask for calibration data  ');
  assert.equal(created.text, 'Ask for calibration data');
  assert.equal(created.completed, false);
  assert.equal((await repo.list(file))[0]?.id, created.id);
  assert.match(fs.readFileSync(file, 'utf8'), /- \[ \] Ask for calibration data/);
});

test('CRUD edits, completes, reopens, deletes and clears completed notes', async () => {
  const file = tempNotesPath();
  const repo = deterministicRepo();
  const first = await repo.add(file, 'First note');
  const second = await repo.add(file, 'Second note');
  const edited = await repo.update(file, first.id, 'Edited first note');
  assert.equal(edited.text, 'Edited first note');

  const done = await repo.setCompleted(file, second.id, true);
  assert.equal(done.completed, true);
  assert.ok(done.completedAt);
  assert.deepEqual((await repo.list(file)).map((n) => [n.id, n.completed]), [
    [first.id, false],
    [second.id, true],
  ]);

  const reopened = await repo.setCompleted(file, second.id, false);
  assert.equal(reopened.completedAt, null);
  assert.equal(await repo.delete(file, first.id), true);
  await repo.setCompleted(file, second.id, true);
  assert.equal(await repo.clearCompleted(file), 1);
  assert.deepEqual(await repo.list(file), []);
});

test('repeating a completion state preserves stable timestamps', async () => {
  const file = tempNotesPath();
  const repo = deterministicRepo();
  const created = await repo.add(file, 'Retry-safe completion');

  const completed = await repo.setCompleted(file, created.id, true);
  const repeatedCompleted = await repo.setCompleted(file, created.id, true);
  assert.deepEqual(repeatedCompleted, completed);

  const reopened = await repo.setCompleted(file, created.id, false);
  const repeatedReopened = await repo.setCompleted(file, created.id, false);
  assert.deepEqual(repeatedReopened, reopened);
});

test('unknown note ids fail without changing the file', async () => {
  const file = tempNotesPath();
  const repo = deterministicRepo();
  await repo.add(file, 'Keep me');
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(() => repo.update(file, 'missing', 'Nope'), (err: any) => err.code === 'not-found');
  await assert.rejects(() => repo.setCompleted(file, 'missing', true), (err: any) => err.code === 'not-found');
  await assert.rejects(() => repo.delete(file, 'missing'), (err: any) => err.code === 'not-found');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('non-canonical and symlink NOTES.md are rejected rather than overwritten', async () => {
  const repo = deterministicRepo();
  const nonCanonical = tempNotesPath();
  fs.writeFileSync(nonCanonical, '# My unrelated notes\n', 'utf8');
  await assert.rejects(() => repo.list(nonCanonical), (err: any) => err.code === 'invalid-notes-file');
  await assert.rejects(() => repo.add(nonCanonical, 'Do not overwrite'), (err: any) => err.code === 'invalid-notes-file');
  assert.equal(fs.readFileSync(nonCanonical, 'utf8'), '# My unrelated notes\n');

  const target = tempNotesPath();
  fs.writeFileSync(target, serializeNotesMarkdown([ACTIVE]), 'utf8');
  const link = path.join(path.dirname(tempNotesPath()), 'NOTES.md');
  fs.symlinkSync(target, link);
  await assert.rejects(() => repo.list(link), (err: any) => err.code === 'invalid-notes-file');
});

test('concurrent adds are serialized without lost updates', async () => {
  const file = tempNotesPath();
  const repo = new ProjectNotesRepository();
  await Promise.all(Array.from({ length: 20 }, (_, i) => repo.add(file, `note ${i}`)));
  const notes = await repo.list(file);
  assert.equal(notes.length, 20);
  assert.equal(new Set(notes.map((n) => n.id)).size, 20);
  assert.equal(new Set(notes.map((n) => n.text)).size, 20);
});
