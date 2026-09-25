import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '../../../src/core/paths.js';
import { REBUILD_PROGRESS_FILE } from '../../../src/core/rebuild-progress.js';
import { handleSystemDaemonStatus } from '../../../src/domain/ui-service/query/system.js';
import type { RebuildProgress } from '../../../src/core/rebuild-progress.js';

// STORE_DIR is this process's isolated test home (tests/_vitest-setup.ts), so writing the pid and
// progress files here is how the query's inputs are staged.
const DAEMON_PID_FILE = path.join(STORE_DIR, 'daemon.pid');

function progress(over: Partial<RebuildProgress> = {}): RebuildProgress {
  return {
    status: 'running',
    reason: 'src change: core/foo.ts',
    current: 'web',
    steps: [
      { name: 'server', status: 'done', detail: null, startedAt: null, endedAt: null },
      { name: 'web', status: 'running', detail: null, startedAt: null, endedAt: null },
    ],
    startedAt: '2026-09-21T06:00:00.000Z',
    updatedAt: '2026-09-21T06:00:05.000Z',
    endedAt: null,
    detail: null,
    daemonPid: process.pid,
    ...over,
  };
}

function publish(record: RebuildProgress): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(REBUILD_PROGRESS_FILE, JSON.stringify(record), 'utf8');
}

function claimDaemonPid(pid: number): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(DAEMON_PID_FILE, String(pid), 'utf8');
}

afterEach(() => {
  rmSync(REBUILD_PROGRESS_FILE, { force: true });
  rmSync(DAEMON_PID_FILE, { force: true });
});

test('no published record reads as no rebuild', async () => {
  const status = await handleSystemDaemonStatus({});
  assert.equal(status.rebuild, null);
});

test('a running pipeline is reported while its own supervisor is alive', async () => {
  // This test process stands in for the daemon: a live pid the query can verify.
  claimDaemonPid(process.pid);
  publish(progress());

  const status = await handleSystemDaemonStatus({});
  assert.equal(status.rebuild?.status, 'running');
  assert.equal(status.rebuild?.current, 'web');
});

test('a running record from a supervisor that is gone is dropped, not shown forever', async () => {
  claimDaemonPid(process.pid);
  publish(progress({ daemonPid: process.pid + 1 }));

  const status = await handleSystemDaemonStatus({});
  assert.equal(status.rebuild, null, 'a rebuild nobody is running is not a rebuild');
});

test('a finished record survives its supervisor — "the last rebuild did X" stays true', async () => {
  claimDaemonPid(process.pid);
  publish(progress({
    status: 'succeeded',
    current: null,
    endedAt: '2026-09-21T06:00:12.000Z',
    daemonPid: process.pid + 1,
  }));

  const status = await handleSystemDaemonStatus({});
  assert.equal(status.rebuild?.status, 'succeeded');
});
