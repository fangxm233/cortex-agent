import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runCli } from '../src/entry/cli.js';
import type { AuthStatusSnapshot } from '../src/domain/auth/auth-status.js';

const AUTH_SNAPSHOT: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [{
    backend: 'claude', provider: 'anthropic', label: 'Anthropic', capabilities: ['oauth'],
    authType: 'oauth', state: 'logged-in', source: 'credentials.json', expiresAt: null,
    refreshExpiresAt: null, inUse: true, credentials: [{
      authType: 'oauth', state: 'logged-in', source: 'credentials.json', expiresAt: null,
      refreshExpiresAt: null, manageable: true,
    }],
  }],
  piRuntime: { available: false, version: null, entry: null, error: 'pi executable not found' },
};

// ─── runCli (async) ─────────────────────────────────────────────

test('runCli with unknown command returns error', async () => {
  const result = await runCli(['unknown-subcommand']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.length > 0);
});

test('runCli auth status --json serializes the exact snapshot without a wrapper', async () => {
  let calls = 0;
  const result = await runCli(['auth', 'status', '--json'], {
    getAuthStatus: async () => { calls += 1; return AUTH_SNAPSHOT; },
  });

  assert.equal(calls, 1);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), AUTH_SNAPSHOT);
  assert.equal(result.stdout, JSON.stringify(AUTH_SNAPSHOT, null, 2));
  assert.equal(result.stderr, '');
});
