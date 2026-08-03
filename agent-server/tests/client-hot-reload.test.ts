// input:  Node test runner, client-hot-reload updateClientReleaseLocal
// output: local-client release-update branch coverage (DI deps)
// pos:    release-mode local cortex-client auto-update (mirror of remote path)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  updateClientReleaseLocal,
  buildRemoteNpmUpdateCommand,
  type LocalUpdateDeps,
} from '../src/domain/remote/client-hot-reload.js';
import { resolveNpmGlobalPrefix } from '../src/core/utils.js';

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

test('npmUpdate throws: error captured, client still restarted on the old binary', async () => {
  const { deps, calls } = makeDeps({
    installed: '2026.5.30',
    npmUpdate: async () => {
      calls.push('npmUpdate');
      throw new Error('EACCES: permission denied, mkdir /usr/lib/node_modules');
    },
  });
  const res = await updateClientReleaseLocal('local', '2026.6.1', deps);
  assert.equal(res.updated, false);
  assert.equal(res.restarted, true);
  assert.match(res.error ?? '', /EACCES/);
  // A failed update must not leave the device with a killed client.
  assert.deepEqual(calls, ['getInstalledVersion', 'kill', 'npmUpdate', 'restart']);
});

test('npm prefix resolves from the installed cortex-client binary, not npm defaults', () => {
  const files = new Set([
    '/home/u/.npm-global/bin/cortex-client',
    '/home/u/.npm-global/lib/node_modules',
  ]);
  const prefix = resolveNpmGlobalPrefix('cortex-client', {
    pathEnv: '/usr/local/bin:/home/u/.npm-global/bin:/usr/bin',
    override: '',
    exists: (p) => files.has(p),
  });
  assert.equal(prefix, '/home/u/.npm-global');

  // Nothing on PATH → null, callers fall back to a bare `-g`.
  assert.equal(
    resolveNpmGlobalPrefix('cortex-client', { pathEnv: '/usr/bin', override: '', exists: () => false }),
    null,
  );

  // Explicit override wins.
  assert.equal(
    resolveNpmGlobalPrefix('cortex', { pathEnv: '/usr/bin', override: '/opt/npm', exists: () => false }),
    '/opt/npm',
  );
});

test('remote update command derives the prefix on the remote host (posix only)', () => {
  const posix = buildRemoteNpmUpdateCommand({ cortexPath: '/home/u', gpuCount: 0, ssh: 'u@h' });
  assert.match(posix, /command -v cortex-client/);
  assert.match(posix, /npm update -g --prefix "\$p" @cortex-agent\/client/);

  const win = buildRemoteNpmUpdateCommand({ cortexPath: 'C:/u', gpuCount: 0, ssh: 'u@w', win: true });
  assert.equal(win, 'npm update -g @cortex-agent/client 2>&1');
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
