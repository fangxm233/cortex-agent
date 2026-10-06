import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { _resetSweepThrottle, markInUse, sweepStaleRuntimeDirs } from '../../../src/domain/plugins/runtime-gc.js';

const DAY = 24 * 60 * 60 * 1000;
const roots: string[] = [];

afterEach(() => {
  _resetSweepThrottle();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function dir(target: string, ageDays: number): string {
  fs.mkdirSync(path.join(target, 'inner'), { recursive: true });
  const when = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(target, when, when);
  return target;
}

function backendDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-runtime-gc-'));
  roots.push(root);
  return path.join(root, 'claude');
}

test('removes only owned, unused directories untouched for a week', () => {
  const backend = backendDir();
  const stale = dir(path.join(backend, 'plugin_old_abc'), 8);
  const used = dir(path.join(backend, 'plugin_used_abc'), 8);
  const fresh = dir(path.join(backend, 'plugin_fresh_abc'), 1);
  const foreign = dir(path.join(backend, 'notes'), 30);
  const staleSnapshot = dir(path.join(backend, 'skill-snapshots', 'skill_old_abc'), 8);
  const outside = dir(path.join(path.dirname(backend), 'outside'), 30);
  fs.symlinkSync(outside, path.join(backend, 'plugin_link_abc'), 'dir');

  const removed = sweepStaleRuntimeDirs(backend, new Set([used]));

  assert.deepEqual(removed.sort(), [stale, staleSnapshot].sort());
  for (const kept of [used, fresh, foreign, outside, path.join(backend, 'skill-snapshots')]) {
    assert.ok(fs.existsSync(kept), kept);
  }
  assert.ok(fs.lstatSync(path.join(backend, 'plugin_link_abc')).isSymbolicLink());
});

test('a reused directory is marked live, and sweeps are throttled per backend dir', () => {
  const backend = backendDir();
  const reused = dir(path.join(backend, 'plugin_reused_abc'), 8);
  markInUse(reused);
  assert.deepEqual(sweepStaleRuntimeDirs(backend, new Set()), []);

  const stale = dir(path.join(backend, 'plugin_later_abc'), 8);
  assert.deepEqual(sweepStaleRuntimeDirs(backend, new Set()), [], 'second sweep within the hour is skipped');
  assert.deepEqual(sweepStaleRuntimeDirs(backend, new Set(), Date.now() + 2 * 60 * 60 * 1000), [stale]);
});
