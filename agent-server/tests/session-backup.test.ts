// input:  backup helpers and temporary transcripts
// output: async backup, restore, and cleanup regressions
// pos:    Verifies backend transcript snapshot utilities
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  backupSessionFile,
  restoreSessionFile,
  cleanupBackupsForFile,
} from '../src/domain/sessions/session-backup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `cortex-test-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function piSessionJsonl(sessionId: string): string {
  const header = { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: '/home/test' };
  const entry = { type: 'message', id: 'abc12345', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } };
  return JSON.stringify(header) + '\n' + JSON.stringify(entry) + '\n';
}

// ---------------------------------------------------------------------------
// 1. backupSessionFile / restoreSessionFile
// ---------------------------------------------------------------------------

test('backupSessionFile: creates .turn-N.bak alongside original', async () => {
  const dir = tmpDir();
  try {
    const filePath = path.join(dir, '2026-04-30_s-1.jsonl');
    writeFileSync(filePath, 'content', 'utf8');

    const backupPath = await backupSessionFile(filePath, 3);
    assert.ok(backupPath, 'backup should be created');
    assert.equal(backupPath, `${filePath}.turn-3.bak`);
    assert.ok(existsSync(backupPath), 'backup file should exist');
    assert.equal(readFileSync(backupPath, 'utf8'), 'content');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
});

test('backupSessionFile: returns null if file does not exist', async () => {
  const dir = tmpDir();
  try {
    const backupPath = await backupSessionFile(path.join(dir, 'nonexistent.jsonl'), 0);
    assert.equal(backupPath, null);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
});

test('restoreSessionFile: copies backup over original', async () => {
  const dir = tmpDir();
  try {
    const filePath = path.join(dir, '2026-04-30_s-1.jsonl');
    writeFileSync(filePath, 'original content', 'utf8');
    const backupPath = await backupSessionFile(filePath, 1);
    assert.ok(backupPath);

    // Overwrite original to simulate changes
    writeFileSync(filePath, 'modified content', 'utf8');

    const restored = await restoreSessionFile(filePath, 1);
    assert.equal(restored, true);
    assert.equal(readFileSync(filePath, 'utf8'), 'original content');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
});

test('restoreSessionFile: returns false if backup does not exist', async () => {
  const dir = tmpDir();
  try {
    const filePath = path.join(dir, 'session.jsonl');
    writeFileSync(filePath, 'content', 'utf8');
    const restored = await restoreSessionFile(filePath, 99);
    assert.equal(restored, false);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
});

// ---------------------------------------------------------------------------
// 2. cleanupBackupsForFile
// ---------------------------------------------------------------------------

test('cleanupBackupsForFile: removes backups after given turn index', async () => {
  const dir = tmpDir();
  try {
    const filePath = path.join(dir, '2026-04-30_s-1.jsonl');
    writeFileSync(filePath, 'content', 'utf8');

    // Create backups for turns 0, 1, 2, 3
    await backupSessionFile(filePath, 0);
    await backupSessionFile(filePath, 1);
    await backupSessionFile(filePath, 2);
    await backupSessionFile(filePath, 3);

    assert.ok(existsSync(`${filePath}.turn-0.bak`));
    assert.ok(existsSync(`${filePath}.turn-1.bak`));
    assert.ok(existsSync(`${filePath}.turn-2.bak`));
    assert.ok(existsSync(`${filePath}.turn-3.bak`));

    // Cleanup after turn 1 — should remove turns 2 and 3
    cleanupBackupsForFile(filePath, 1);

    assert.ok(existsSync(`${filePath}.turn-0.bak`), 'turn 0 should remain');
    assert.ok(existsSync(`${filePath}.turn-1.bak`), 'turn 1 should remain');
    assert.ok(!existsSync(`${filePath}.turn-2.bak`), 'turn 2 should be removed');
    assert.ok(!existsSync(`${filePath}.turn-3.bak`), 'turn 3 should be removed');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
});

test('cleanupBackupsForFile: no-op when no backups exist', () => {
  const dir = tmpDir();
  try {
    const filePath = path.join(dir, '2026-04-30_s-1.jsonl');
    writeFileSync(filePath, 'content', 'utf8');
    // Should not throw
    cleanupBackupsForFile(filePath, 0);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
});

test('backup/restore cycle preserves binary-identical content', async () => {
  const dir = tmpDir();
  try {
    const filePath = path.join(dir, 'session.jsonl');
    const original = piSessionJsonl('test-session-id');
    writeFileSync(filePath, original, 'utf8');

    await backupSessionFile(filePath, 0);
    writeFileSync(filePath, 'garbage', 'utf8');
    await restoreSessionFile(filePath, 0);

    assert.equal(readFileSync(filePath, 'utf8'), original);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
});
