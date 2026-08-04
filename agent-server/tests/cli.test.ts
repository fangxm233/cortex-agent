// input:  CLI source, subprocess entry, and auth fixtures
// output: routing, output framing, and size-limit assertions
// pos:    Cortex CLI dispatcher and binary regression coverage
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runCli } from '../src/entry/cli.js';
import { getLocale, setLocale } from '../src/core/i18n.js';
import type { AuthStatusSnapshot } from '../src/domain/auth/auth-status.js';

const CLI_SOURCE = fileURLToPath(new URL('../src/entry/cli.ts', import.meta.url));

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

test('top-level CLI stays within the code-standard file limit', () => {
  const lineCount = readFileSync(CLI_SOURCE, 'utf8').trimEnd().split('\n').length;
  assert.ok(lineCount <= 800, `entry/cli.ts has ${lineCount} lines`);
});

test('runCli --help returns help text', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Cortex/);
  assert.equal(result.stderr, '');
});

test('runCli with unknown command returns error', async () => {
  const result = await runCli(['unknown-subcommand']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.length > 0);
});

test('runCli auth status uses the shared bilingual summary', async (t) => {
  const previousLocale = getLocale();
  t.onTestFinished(() => setLocale(previousLocale));
  setLocale('zh');

  let calls = 0;
  const result = await runCli(['auth', 'status'], {
    getAuthStatus: async () => { calls += 1; return AUTH_SNAPSHOT; },
  });

  assert.equal(calls, 1);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /认证状态/);
  assert.match(result.stdout, /Anthropic.*已登录/s);
  assert.equal(result.stderr, '');
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

test('real auth status JSON CLI emits exactly one trailing newline', () => {
  const isolatedHome = process.env.CORTEX_HOME!;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI_SOURCE, 'auth', 'status', '--json'],
    { encoding: 'utf8', env: {
      CORTEX_HOME: isolatedHome,
      CORTEX_LANG: 'en',
      HOME: isolatedHome,
      PATH: '',
      TMPDIR: isolatedHome,
    } },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const snapshot = JSON.parse(child.stdout) as AuthStatusSnapshot;
  assert.equal(child.stdout, `${JSON.stringify(snapshot, null, 2)}\n`);
});

test('runCli auth help and invalid arguments provide a localized correction path', async (t) => {
  const previousLocale = getLocale();
  t.onTestFinished(() => setLocale(previousLocale));
  setLocale('zh');

  const authHelp = await runCli(['auth', '--help']);
  assert.equal(authHelp.exitCode, 0);
  assert.match(authHelp.stdout, /用法：.*cortex auth /);
  assert.match(authHelp.stdout, /命令：|选项：|示例：/);
  assert.doesNotMatch(authHelp.stdout, /Usage:|Commands:|Options:|Examples:/);

  const statusHelp = await runCli(['auth', 'status', '--help']);
  assert.equal(statusHelp.exitCode, 0);
  assert.match(statusHelp.stdout, /--json/);

  const badCommand = await runCli(['auth', 'show']);
  assert.equal(badCommand.exitCode, 1);
  assert.match(badCommand.stderr, /合法值：.*status/);
  assert.match(badCommand.stderr, /提示：/);

  const badFlag = await runCli(['auth', 'status', '--yaml']);
  assert.equal(badFlag.exitCode, 1);
  assert.match(badFlag.stderr, /合法值：.*--json/);
  assert.doesNotMatch(badFlag.stderr, /Valid values:|Hint:/);

  const topHelp = await runCli(['--help']);
  assert.match(topHelp.stdout, /显示 backend 认证状态/);
});

test('runCli with init --help returns help text', async () => {
  const result = await runCli(['init', '--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /CORTEX_HOME/);
  assert.equal(result.stderr, '');
});

test('runCli config returns path info', async () => {
  const result = await runCli(['config']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /INSTALL_ROOT/);
  assert.match(result.stdout, /DATA_DIR/);
  assert.equal(result.stderr, '');
});

test('runCli bare daemon returns error when not main entry', async () => {
  const result = await runCli(['daemon']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /must be run from the main entry/);
});

test('runCli daemon status reports daemon state (running or not)', async () => {
  const result = await runCli(['daemon', 'status']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  // Output must mention "daemon" and either "running" or "not running"
  assert.match(result.stdout, /daemon/i);
  assert.ok(
    /running/.test(result.stdout) || /not running/.test(result.stdout),
    `expected status output to mention running or not running, got: ${result.stdout}`,
  );
});

test('runCli daemon restart exit code reflects daemon state', async () => {
  const result = await runCli(['daemon', 'restart']);
  // If daemon is running: exit 0 + success message. If not: exit 1 + error.
  if (result.exitCode === 0) {
    assert.match(result.stdout, /Restart signal sent/);
    assert.equal(result.stderr, '');
  } else {
    assert.match(result.stderr, /not running/);
    assert.equal(result.stdout, '');
  }
});

test('runCli daemon status shows child info when daemon is running', async () => {
  const result = await runCli(['daemon', 'status']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  if (/daemon is running/i.test(result.stdout)) {
    // When running, should include child/app.js info.
    // NOTE: match the positive phrase only — a bare /running/ also matches
    // "Cortex daemon is not running", which would wrongly trigger this assertion.
    assert.match(result.stdout, /Child|app\.js/i);
  }
});

test('runCli daemon restart --hard sends signal to app.js', async () => {
  const result = await runCli(['daemon', 'restart', '--hard']);
  if (result.exitCode === 0) {
    assert.match(result.stdout, /SIGTERM.*app\.js/i);
    assert.equal(result.stderr, '');
  } else {
    // Daemon or child not running
    assert.match(result.stderr, /not running|No child PID/i);
    assert.equal(result.stdout, '');
  }
});

test('runCli daemon restart --force sends SIGKILL to app.js', async () => {
  const result = await runCli(['daemon', 'restart', '--force']);
  if (result.exitCode === 0) {
    assert.match(result.stdout, /SIGKILL.*app\.js/i);
    assert.equal(result.stderr, '');
  } else {
    assert.match(result.stderr, /not running|No child PID/i);
    assert.equal(result.stdout, '');
  }
});

test('runCli daemon restart-self is not handled by runCli (needs main)', async () => {
  const result = await runCli(['daemon', 'restart-self']);
  // runCli doesn't know about restart-self — should fall through to the
  // "must be run from the main entry point" error, or be unknown
  assert.ok(
    result.stderr.includes('must be run from the main entry') || result.exitCode !== 0,
    `expected runCli to reject restart-self, got exitCode=${result.exitCode} stderr="${result.stderr}"`,
  );
});
