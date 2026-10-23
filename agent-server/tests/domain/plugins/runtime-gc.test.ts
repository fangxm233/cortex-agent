import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import {
  _resetSweepThrottle, markInUse, sweepStaleClaudeMcpFiles, sweepStaleRuntimeDirs,
} from '../../../src/domain/plugins/runtime-gc.js';

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

function file(target: string, ageDays: number): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{}\n');
  const when = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(target, when, when);
  return target;
}

test('removes Claude MCP and proxy configs untouched for a week, and only those', () => {
  const runtime = path.dirname(backendDir());
  const hash = (char: string) => char.repeat(64);
  const staleConfig = file(path.join(runtime, 'claude-mcp', `${hash('a')}.json`), 8);
  const freshConfig = file(path.join(runtime, 'claude-mcp', `${hash('b')}.json`), 1);
  const staleTemp = file(path.join(runtime, 'claude-mcp', `${hash('c')}.json.tmp.123.456.abc`), 8);
  const staleProxy = file(path.join(runtime, 'claude-mcp-proxies', `${hash('d')}.json`), 8);
  const freshProxy = file(path.join(runtime, 'claude-mcp-proxies', `${hash('e')}.json`), 1);
  const foreign = file(path.join(runtime, 'claude-mcp', 'notes.json'), 30);
  const staleDir = dir(path.join(runtime, 'claude-mcp', `${hash('f')}.json`), 30);

  const removed = sweepStaleClaudeMcpFiles(runtime);

  assert.deepEqual(removed.sort(), [staleConfig, staleTemp, staleProxy].sort());
  for (const kept of [freshConfig, freshProxy, foreign, staleDir]) assert.ok(fs.existsSync(kept), kept);
  assert.deepEqual(sweepStaleClaudeMcpFiles(runtime), [], 'second sweep within the hour is skipped');
});
