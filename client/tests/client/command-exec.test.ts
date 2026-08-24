// input:  node:test, command execution module, temporary filesystem
// output: timeout and cross-platform process-tree termination tests
// pos:    Verifies bounded remote command execution
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execBash, killCommandTree, type KillCommandTreeDeps } from '../../src/command-exec.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('execBash timeout', () => {
  it('returns at the deadline and kills descendants that hold output pipes', { skip: process.platform === 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-command-timeout-'));
    const marker = join(dir, 'descendant-survived');
    const startedAt = Date.now();

    try {
      const result = await execBash(`(sleep 2; touch ${JSON.stringify(marker)}) & wait`, 150);
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.exitCode, 124);
      assert.match(result.stderr, /timed out after 0\.15s/);
      assert.ok(elapsedMs < 1_000, `timeout returned after ${elapsedMs}ms`);
      await delay(2_100);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('killCommandTree', () => {
  it('kills a POSIX process group with SIGKILL', () => {
    const calls: unknown[][] = [];
    const deps: KillCommandTreeDeps = {
      kill: (...args: unknown[]) => { calls.push(args); return true; },
      execFileSync: () => Buffer.alloc(0),
    };

    killCommandTree(321, 'linux', deps);

    assert.deepEqual(calls, [[-321, 'SIGKILL']]);
  });

  it('uses taskkill tree mode on Windows', () => {
    const calls: unknown[][] = [];
    const deps: KillCommandTreeDeps = {
      kill: () => true,
      execFileSync: (...args: unknown[]) => { calls.push(args); return Buffer.alloc(0); },
    };

    killCommandTree(654, 'win32', deps);

    assert.deepEqual(calls, [['taskkill', ['/PID', '654', '/T', '/F'], { stdio: 'ignore', windowsHide: true }]]);
  });
});
