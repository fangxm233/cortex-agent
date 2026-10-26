import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';
import { anchorFromBackup, migrateTurnBackupsToAnchors, removeTurnBackups, retireTurnBackups } from '../../src/store/turn-anchor-migration.js';
import type { TurnRecord } from '../../src/store/session-registry-journal.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'turn-anchor-migration-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function jsonl(rows: object[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
}

function turn(turnIndex: number, backupPath: string | null): TurnRecord {
  return {
    turnIndex, userMessageTs: `m${turnIndex}`, userMessageText: 't', statusMessageTs: null,
    responseMessageTimestamps: [], executionId: null, backupPath,
    status: 'completed', createdAt: 'T', updatedAt: 'T',
  };
}

test('a backup stands for an anchor after its last entry in the live transcript', async () => {
  const live = path.join(dir, 'abc.jsonl');
  const backup = `${live}.turn-2.bak`;
  writeFileSync(backup, jsonl([{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1' }, { type: 'cost-state' }]));
  assert.deepEqual(await anchorFromBackup(backup), { file: live, after: 'a1' });
  assert.equal(await anchorFromBackup(`${live}.turn-3.bak`), null, 'missing backup');
  assert.equal(await anchorFromBackup(live), null, 'not a turn backup name');
});

test('the migration anchors backed-up turns, keeps backupPath, and skips anchored ones', async () => {
  const live = path.join(dir, 'pi.jsonl');
  writeFileSync(`${live}.turn-1.bak`, jsonl([{ type: 'session', id: 's' }, { type: 'message', id: 'e1' }]));
  const registryFile = path.join(dir, 'session-registry.jsonl');
  const seed = new SessionRegistryRepo(registryFile);
  const kept = { file: live, before: 'x9' };
  await seed.batch(async (ops) => {
    await ops.setConversation('web:a', { sessionId: 'a', backend: 'pi', selection: null, updatedAt: 'T' });
    await ops.beginTurn('web:a', turn(0, null));
    await ops.beginTurn('web:a', turn(1, `${live}.turn-1.bak`));
    await ops.beginTurn('web:a', turn(2, `${live}.turn-2.bak`));
    await ops.beginTurn('web:a', { ...turn(3, `${live}.turn-1.bak`), anchor: kept });
  });
  await seed.flush();

  assert.deepEqual(await migrateTurnBackupsToAnchors(dir), { converted: 1, missing: 1 });
  const turns = (await new SessionRegistryRepo(registryFile).readConversation('web:a'))!.turns;
  assert.deepEqual(turns.map((t) => t.anchor), [undefined, { file: live, after: 'e1' }, undefined, kept]);
  assert.equal(turns[1].backupPath, `${live}.turn-1.bak`);
});

test('turn backups are removed from every backup dir, leaving transcripts and other files', async () => {
  const pi = path.join(dir, 'sessions-pi');
  const claude = path.join(dir, 'claude-projects');
  mkdirSync(path.join(claude, '-home-x'), { recursive: true });
  mkdirSync(pi, { recursive: true });
  const kept = [path.join(pi, 'ts_s.jsonl'), path.join(claude, '-home-x', 'u.jsonl'), path.join(pi, 'notes.bak')];
  const removed = [path.join(pi, 'ts_s.jsonl.turn-1.bak'), path.join(claude, '-home-x', 'u.jsonl.turn-12.bak')];
  for (const file of [...kept, ...removed]) writeFileSync(file, 'x');

  const report = await removeTurnBackups([pi, claude, path.join(dir, 'absent')]);
  assert.deepEqual(report, { removed: 2, failed: 0 });
  for (const file of kept) assert.ok(existsSync(file), file);
  for (const file of removed) assert.ok(!existsSync(file), file);
});

test('retiring backups anchors turns before it deletes the backups', async () => {
  const storeDir = path.join(dir, 'data');
  const projectDir = path.join(storeDir, 'claude', 'projects', '-home-x');
  mkdirSync(projectDir, { recursive: true });
  const live = path.join(projectDir, 'u.jsonl');
  const backup = `${live}.turn-1.bak`;
  writeFileSync(backup, jsonl([{ type: 'user', uuid: 'u1' }]));
  const registryFile = path.join(storeDir, 'session-registry.jsonl');
  const seed = new SessionRegistryRepo(registryFile);
  await seed.batch(async (ops) => {
    await ops.setConversation('web:a', { sessionId: 'a', backend: 'claude', selection: null, updatedAt: 'T' });
    await ops.beginTurn('web:a', turn(1, backup));
  });
  await seed.flush();

  await retireTurnBackups(dir, storeDir);
  const turns = (await new SessionRegistryRepo(registryFile).readConversation('web:a'))!.turns;
  assert.deepEqual(turns[0].anchor, { file: live, after: 'u1' });
  assert.ok(!existsSync(backup));
});
