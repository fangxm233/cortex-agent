// input:  Node test runner, client-hot-reload updateClientReleaseLocal
// output: local-client release-update branch coverage (DI deps)
// pos:    release-mode local cortex-client auto-update (mirror of remote path)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  updateClientReleaseLocal,
  type LocalUpdateDeps,
} from '../src/domain/remote/client-hot-reload.js';

// A deps factory that records call order and lets each op be overridden.
function makeDeps(overrides: Partial<LocalUpdateDeps> & { installed?: string | null } = {}) {
  const calls: string[] = [];
  const deps: LocalUpdateDeps = {
    getInstalledVersion: () => {
      calls.push('getInstalledVersion');
      return overrides.installed ?? null;
    },
    kill: async () => {
      calls.push('kill');
      return true;
    },
    npmUpdate: async () => {
      calls.push('npmUpdate');
      return 'updated 1 package';
    },
    restart: async () => {
      calls.push('restart');
      return true;
    },
    ...overrides,
  };
  return { deps, calls };
}

test('already at latest: no kill/update/restart, not marked updated', async () => {
  const { deps, calls } = makeDeps({ installed: '2026.6.1' });
  const res = await updateClientReleaseLocal('local', '2026.6.1', deps);
  assert.equal(res.updated, false);
  assert.equal(res.restarted, false);
  assert.equal(res.oldVersion, '2026.6.1');
  assert.equal(res.newVersion, '2026.6.1');
  assert.equal(res.error, undefined);
  assert.deepEqual(calls, ['getInstalledVersion']);
});

test('new version: kill -> npmUpdate -> restart in order, updated+restarted true', async () => {
  const { deps, calls } = makeDeps({ installed: '2026.5.30' });
  const res = await updateClientReleaseLocal('local', '2026.6.1', deps);
  assert.equal(res.updated, true);
  assert.equal(res.restarted, true);
  assert.equal(res.oldVersion, '2026.5.30');
  assert.equal(res.newVersion, '2026.6.1');
  assert.equal(res.error, undefined);
  assert.deepEqual(calls, ['getInstalledVersion', 'kill', 'npmUpdate', 'restart']);
});

test('installed version unknown (null): still updates, oldVersion "?"', async () => {
  const { deps, calls } = makeDeps({ installed: null });
  const res = await updateClientReleaseLocal('local', '2026.6.1', deps);
  assert.equal(res.updated, true);
  assert.equal(res.oldVersion, '?');
  assert.deepEqual(calls, ['getInstalledVersion', 'kill', 'npmUpdate', 'restart']);
});

test('npmUpdate throws: error captured, restart not attempted, updated false', async () => {
  const { deps, calls } = makeDeps({
    installed: '2026.5.30',
    npmUpdate: async () => {
      calls.push('npmUpdate');
      throw new Error('npm registry unreachable');
    },
  });
  const res = await updateClientReleaseLocal('local', '2026.6.1', deps);
  assert.equal(res.updated, false);
  assert.equal(res.restarted, false);
  assert.match(res.error ?? '', /npm registry unreachable/);
  assert.deepEqual(calls, ['getInstalledVersion', 'kill', 'npmUpdate']);
});

test('restart fails: updated true but restarted false', async () => {
  const { deps } = makeDeps({
    installed: '2026.5.30',
    restart: async () => false,
  });
  const res = await updateClientReleaseLocal('local', '2026.6.1', deps);
  assert.equal(res.updated, true);
  assert.equal(res.restarted, false);
  assert.equal(res.error, undefined);
});
