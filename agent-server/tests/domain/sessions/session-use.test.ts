// input:  the SessionUseTracker over a real SessionRegistryRepo
// output: use-count lease semantics (moved out of the store in the session-registry refactor)
// pos:    domain/sessions — verifies acquire/refuse/nest/release and the retention protected set

import '../../_test-home.js';
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo } from '../../../src/store/session-registry-repo.js';
import { SessionUseTracker } from '../../../src/domain/sessions/session-use.js';

let tmpDir = '';
let testId = 0;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-use-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function registerOpts(id: string) {
  return {
    sessionId: id,
    channel: `web:${id}`,
    backend: 'claude',
    kind: 'local' as const,
    projectId: 'proj',
    label: 'label',
  };
}

async function makeRepo() {
  const filePath = path.join(tmpDir, `session-registry-${testId++}.jsonl`);
  return new SessionRegistryRepo(filePath);
}

test('acquireSessionUse refuses an unknown session', async () => {
  const use = new SessionUseTracker(await makeRepo());
  assert.equal(await use.acquireSessionUse('nope'), null);
  assert.deepEqual([...use.activeSessionUseIds()], []);
});

test('acquireSessionUse refuses a session pending deletion', async () => {
  const repo = await makeRepo();
  const use = new SessionUseTracker(repo);
  await repo.registerSession('cortex-pending', registerOpts('sess-pending'));
  await repo.updateSession('cortex-pending', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);

  assert.equal(await use.acquireSessionUse('sess-pending'), null);
  assert.deepEqual([...use.activeSessionUseIds()], []);
});

test('acquireSessionUse bumps lastUsedAt on a live session', async () => {
  const repo = await makeRepo();
  const use = new SessionUseTracker(repo);
  await repo.registerSession('cortex-live', registerOpts('sess-live'));
  await repo.updateSession('cortex-live', { lastUsedAt: '2020-01-01T00:00:00.000Z' });

  const release = await use.acquireSessionUse('sess-live');
  assert.ok(release);
  const bumped = await repo.getById('sess-live');
  assert.notEqual(bumped?.lastUsedAt, '2020-01-01T00:00:00.000Z');
  release?.();
});

test('nested acquires stack and release is idempotent', async () => {
  const repo = await makeRepo();
  const use = new SessionUseTracker(repo);
  await repo.registerSession('cortex-nest', registerOpts('sess-nest'));

  const first = await use.acquireSessionUse('sess-nest');
  const second = await use.acquireSessionUse('sess-nest');
  assert.ok(first && second);
  assert.deepEqual([...use.activeSessionUseIds()], ['sess-nest']);

  // Releasing one lease (twice — idempotent) leaves the other holding the count.
  first?.();
  first?.();
  assert.deepEqual([...use.activeSessionUseIds()], ['sess-nest']);

  second?.();
  assert.deepEqual([...use.activeSessionUseIds()], []);
});

test('retention skips in-use sessions via the protected set', async () => {
  const repo = await makeRepo();
  const use = new SessionUseTracker(repo);
  await repo.registerSession('cortex-held', registerOpts('sess-held'));
  await repo.registerSession('cortex-idle', registerOpts('sess-idle'));
  await repo.updateSession('cortex-held', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.updateSession('cortex-idle', { lastUsedAt: '2020-01-01T00:00:00.000Z' });

  const release = await use.acquireSessionUse('sess-held');
  assert.ok(release);

  // A future cutoff makes BOTH sessions stale by time — only the protected set spares the held one.
  // (acquire also bumped sess-held's lastUsedAt to now, so a real-time cutoff would not tell the two
  // apart; the future cutoff isolates the protection.) Mirrors runSessionRetentionSweep's union.
  const pending = await repo.beginDeleteExpired(new Date('2100-01-01T00:00:00.000Z'), [...use.activeSessionUseIds()]);
  assert.deepEqual(pending.map((entry) => entry.session.sessionId), ['sess-idle']);

  release?.();
  const afterRelease = await repo.beginDeleteExpired(new Date('2100-01-01T00:00:00.000Z'), [...use.activeSessionUseIds()]);
  assert.deepEqual(afterRelease.map((entry) => entry.session.sessionId), ['sess-held']);
});

test('withSessionUse runs fn while leased and returns null for a refused lease', async () => {
  const repo = await makeRepo();
  const use = new SessionUseTracker(repo);
  await repo.registerSession('cortex-with', registerOpts('sess-with'));

  const observed = await use.withSessionUse('sess-with', async () => [...use.activeSessionUseIds()]);
  assert.deepEqual(observed, ['sess-with']);
  // Lease released after fn resolves.
  assert.deepEqual([...use.activeSessionUseIds()], []);

  assert.equal(await use.withSessionUse('missing', async () => 'ran'), null);
});
