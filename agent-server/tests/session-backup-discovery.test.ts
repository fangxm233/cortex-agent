// input:  isolated PI files and backup filesystem calls
// output: discovery latency and async-copy regressions
// pos:    Proves lookup skips unrelated transcript bodies
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import './_test-home.js';
import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

const ioProbe = vi.hoisted(() => ({ jsonlReads: 0, syncCopies: 0 }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      const filePath = String(args[0]);
      if (filePath.endsWith('.jsonl')) {
        ioProbe.jsonlReads++;
        const until = performance.now() + 10;
        while (performance.now() < until) { /* deterministic old-path cost */ }
      }
      return (actual.readFileSync as (...inner: unknown[]) => unknown)(...args);
    },
    copyFileSync: (...args: unknown[]) => {
      ioProbe.syncCopies++;
      return (actual.copyFileSync as (...inner: unknown[]) => unknown)(...args);
    },
  };
});

const {
  backupSessionFile,
  findPISessionFile,
} = await import('../src/domain/sessions/session-backup.js');

const sessionDir = path.join(process.env.CORTEX_HOME!, 'logs', 'sessions-pi');

beforeEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
  mkdirSync(sessionDir, { recursive: true });
  ioProbe.jsonlReads = 0;
  ioProbe.syncCopies = 0;
});

function writeDecoys(count: number): void {
  for (let index = 0; index < count; index++) {
    const filename = `2026-08-01T00-00-${String(index).padStart(3, '0')}Z_decoy-${index}.jsonl`;
    writeFileSync(path.join(sessionDir, filename), '{"type":"session","id":"not-the-target"}\nbody\n');
  }
}

test('PI lookup ignores hundreds of unrelated bodies and backs up the exact filename match', async () => {
  writeDecoys(240);
  const sessionId = '01234567-89ab-7cde-8fab-0123456789ab';
  const target = path.join(sessionDir, `2026-08-01T01-02-03Z_${sessionId}.jsonl`);
  const content = `{"type":"session","id":"${sessionId}"}\nturn\n`;
  writeFileSync(target, content);

  const found = await findPISessionFile(sessionId);
  assert.equal(found, target);
  assert.equal(ioProbe.jsonlReads, 0, 'filename lookup must not open target or decoy transcript bodies');

  const backup = await backupSessionFile(found!, 4);
  assert.equal(backup, `${target}.turn-4.bak`);
  assert.equal(readFileSync(backup!, 'utf8'), content);
  assert.equal(ioProbe.syncCopies, 0, 'turn backup must not use copyFileSync');
  assert.ok(existsSync(target), 'source transcript remains intact');
});

test('PI lookup deterministically prefers the canonical direct-id filename', async () => {
  const sessionId = 'z-session-id';
  const prefixed = path.join(sessionDir, `2026-04-30T19-42-39Z_${sessionId}.jsonl`);
  const canonical = path.join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(prefixed, 'older-prefixed-copy');
  writeFileSync(canonical, 'canonical-copy');

  const found = await findPISessionFile(sessionId);

  assert.equal(found, canonical);
  assert.equal(ioProbe.jsonlReads, 0);
});

test('PI lookup chooses the newest timestamp when only prefixed duplicates exist', async () => {
  const sessionId = 'prefixed-session-id';
  const older = path.join(sessionDir, `2026-07-01T00-00-00Z_${sessionId}.jsonl`);
  const newer = path.join(sessionDir, `2026-08-01T00-00-00Z_${sessionId}.jsonl`);
  writeFileSync(newer, 'newer-copy');
  writeFileSync(older, 'older-copy');

  assert.equal(await findPISessionFile(sessionId), newer);
  assert.equal(ioProbe.jsonlReads, 0);
});

test('PI lookup latency does not inherit per-body cost from a large decoy directory', async () => {
  writeDecoys(240);

  const started = performance.now();
  const found = await findPISessionFile('missing-session-id');
  const elapsedMs = performance.now() - started;

  assert.equal(found, null);
  assert.equal(ioProbe.jsonlReads, 0, 'missing lookup must still avoid every decoy body');
  assert.ok(elapsedMs < 1_000, `filename-only lookup took ${elapsedMs.toFixed(1)} ms`);
});
