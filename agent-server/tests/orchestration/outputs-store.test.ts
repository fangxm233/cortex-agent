import '../_test-home.js'; // MUST be first — repoints CORTEX_HOME before paths bind

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { WORKSPACE_DIR } from '../../src/core/paths.js';
import { writeTextIntoOutputs } from '../../src/orchestration/outputs-store.js';

function diskPath(relPath: string): string {
  assert.ok(relPath.startsWith('workspace/'));
  return path.join(WORKSPACE_DIR, relPath.slice('workspace/'.length));
}

test('writeTextIntoOutputs preserves Unicode display names, subdirectories, and UTF-8 byte sizes', async () => {
  const text = 'Résumé — 漢字\n';
  const fileName = 'résumé-报告.html';
  const stored = await writeTextIntoOutputs({
    sessionId: 'direct-text', text, fileName, subdir: 'views',
  });

  assert.equal(stored.name, fileName);
  assert.equal(stored.size, Buffer.byteLength(text, 'utf8'));
  assert.equal(path.basename(path.dirname(diskPath(stored.relPath))), 'views');
  assert.match(path.basename(diskPath(stored.relPath)), /^[A-Za-z0-9._-]+$/);
  assert.equal(await fs.readFile(diskPath(stored.relPath), 'utf8'), text);
});

test('writeTextIntoOutputs chooses a suffixed name on collision and keeps both texts', async () => {
  const first = await writeTextIntoOutputs({
    sessionId: 'direct-collision', text: 'first', fileName: 'report.txt', subdir: 'views',
  });
  const second = await writeTextIntoOutputs({
    sessionId: 'direct-collision', text: 'second', fileName: 'report.txt', subdir: 'views',
  });

  assert.equal(path.basename(diskPath(first.relPath)), 'report.txt');
  assert.equal(path.basename(diskPath(second.relPath)), 'report_1.txt');
  assert.equal(await fs.readFile(diskPath(first.relPath), 'utf8'), 'first');
  assert.equal(await fs.readFile(diskPath(second.relPath), 'utf8'), 'second');
});

test('writeTextIntoOutputs propagates reservation directory failures', async () => {
  const sessionPath = path.join(WORKSPACE_DIR, 'outputs', 'direct-write-failure');
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, 'not a directory');

  await assert.rejects(
    () => writeTextIntoOutputs({
      sessionId: 'direct-write-failure', text: 'content', fileName: 'report.txt',
    }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'EEXIST');
      return true;
    },
  );
});
