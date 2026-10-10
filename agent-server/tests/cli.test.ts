import { test, vi } from 'vitest';
const fork = vi.hoisted(() => vi.fn());
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), fork }));
vi.mock('fs', async original => {
  const fs = await original<typeof import('fs')>();
  return { ...fs, existsSync: (file: string) => file.endsWith('/daemon.js') || fs.existsSync(file) };
});
import assert from 'node:assert/strict';
import { main, runCli } from '../src/entry/cli.js';
import { DATA_DIR } from '../src/core/paths.js';
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

test('normal CLI daemon fork hides the window without changing lifecycle or environment', () => {
  const argv = process.argv;
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test exit'); });
  process.argv = [process.execPath, 'cli.js', 'daemon'];
  try {
    assert.throws(() => main(), /test exit/);
    assert.equal(exit.mock.calls[0][0], 0);
    assert.equal(fork.mock.calls.length, 1);
    const [entry, args, options] = fork.mock.calls[0];
    assert.ok(entry.endsWith('/daemon.js'));
    assert.deepEqual(args, []);
    assert.equal(options.windowsHide, true); // Fail before a full inherited-env diff.
    assert.deepEqual(options, {
      cwd: DATA_DIR, windowsHide: true, detached: true, stdio: 'ignore', env: { ...process.env },
    });
  } finally {
    process.argv = argv;
    exit.mockRestore();
  }
});

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
