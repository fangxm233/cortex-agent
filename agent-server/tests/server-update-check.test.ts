import { describe, test, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { releaseNewTurnHold } from '../src/domain/system/rebuild-hold.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { importFresh } from './helpers/fresh-module.js';

// These cases cover the consent prompt; auto-update is covered in server-update-coordinator.test.ts.
vi.mock('../src/core/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/settings.js')>();
  return { ...actual, getSettings: () => ({ ...actual.getSettings(), serverAutoUpdate: false }) };
});

const installFixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/paths.js')>();
  return { ...actual, get INSTALL_ROOT() { return installFixture.root || actual.INSTALL_ROOT; } };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(() => { throw new Error('Unexpected subprocess in update test'); }) };
});

// ── Helpers ─────────────────────────────────────────────────────

function freshModule() {
  return importFresh<{
    isUpdateDevMode: () => boolean;
    checkServerUpdate: (deps: any) => Promise<any>;
  }>(new URL('../src/domain/system/server-update-check.js', import.meta.url));
}

function mockPrompt(result: 'apply' | 'skip' | 'cancel' | null) {
  return { ask: async () => result };
}

function unbundledGlobalInstall() {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'server-update-prefix-'));
  const modules = process.platform === 'win32' ? 'node_modules' : 'lib/node_modules';
  installFixture.root = path.join(prefix, modules, '@cortex-agent/server');
  fs.mkdirSync(installFixture.root, { recursive: true });
  fs.writeFileSync(path.join(installFixture.root, 'package.json'), JSON.stringify({
    name: '@cortex-agent/server', version: '2026.1.1',
    scripts: { postinstall: 'node scripts/postinstall-restart-trigger.mjs' },
  }));
  return prefix;
}

function mockNpmChild() {
  const child = Object.assign(new EventEmitter(), {
    stderr: Object.assign(new EventEmitter(), { unref: vi.fn() }), unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  return child;
}

// ============================================================
// isUpdateDevMode
// ============================================================

test('isUpdateDevMode - returns false when CORTEX_REPO is not set', async () => {
  const prev = process.env.CORTEX_REPO;
  delete process.env.CORTEX_REPO;
  try {
    const mod = await freshModule();
    assert.equal(mod.isUpdateDevMode(), false);
  } finally {
    if (prev !== undefined) process.env.CORTEX_REPO = prev;
  }
});

test('isUpdateDevMode - returns true when CORTEX_REPO dir exists', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-update-dev-'));
  const prev = process.env.CORTEX_REPO;
  process.env.CORTEX_REPO = tmpDir;
  try {
    const mod = await freshModule();
    assert.equal(mod.isUpdateDevMode(), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prev !== undefined) process.env.CORTEX_REPO = prev;
    else delete process.env.CORTEX_REPO;
  }
});

// ============================================================
// checkServerUpdate — dev mode test (CORTEX_REPO must be set)
// ============================================================

test('checkServerUpdate - dev mode returns null action and null version', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-update-dev-'));
  const prev = process.env.CORTEX_REPO;
  process.env.CORTEX_REPO = tmpDir;
  try {
    const mod = await freshModule();
    const result = await mod.checkServerUpdate({
      prompt: mockPrompt(null),
    });
    assert.deepEqual(result, { action: null, latestVersion: null });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prev !== undefined) process.env.CORTEX_REPO = prev;
    else delete process.env.CORTEX_REPO;
  }
});

// ============================================================
// checkServerUpdate — non-dev-mode tests (CORTEX_REPO must be unset)
// ============================================================

describe('checkServerUpdate (non-dev mode)', () => {
  let envBackup: string | undefined;

  beforeAll(() => {
    envBackup = process.env.CORTEX_REPO;
    delete process.env.CORTEX_REPO;
    // Default is enabled; no need to set any env var
  });

  afterAll(() => {
    if (envBackup !== undefined) process.env.CORTEX_REPO = envBackup;
    else delete process.env.CORTEX_REPO;
  });

  test('getLatest returns null', async () => {
    const mod = await freshModule();
    const result = await mod.checkServerUpdate({
      prompt: mockPrompt(null),
      getLatest: () => null,
    });
    assert.deepEqual(result, { action: null, latestVersion: null });
  });

  test('latest <= local version', async () => {
    const mod = await freshModule();
    const result = await mod.checkServerUpdate({
      prompt: mockPrompt(null),
      getLatest: () => '2025.1.1',
    });
    assert.deepEqual(result, { action: null, latestVersion: '2025.1.1' });
  });

  test('skippedVersion matches latest', async () => {
    const mod = await freshModule();
    const result = await mod.checkServerUpdate({
      prompt: mockPrompt(null),
      getLatest: () => '9999.1.1',
      loadState: () => ({ skippedVersion: '9999.1.1' }),
    });
    assert.deepEqual(result, { action: null, latestVersion: '9999.1.1' });
  });

  test('apply calls installWhenIdle and clears skippedVersion', async () => {
    const mod = await freshModule();
    let installCalled = false;
    let savedState: any = null;

    const result = await mod.checkServerUpdate({
      prompt: mockPrompt('apply'),
      getLatest: () => '9999.1.1',
      installWhenIdle: () => { installCalled = true; },
      loadState: () => ({ skippedVersion: '2025.1.1' }),
      saveState: (s: any) => { savedState = s; },
      now: () => '2026-06-01T00:00:00.000Z',
    });

    assert.equal(result.action, 'apply');
    assert.equal(result.latestVersion, '9999.1.1');
    assert.equal(installCalled, true, 'installWhenIdle should have been called');
    assert.equal(savedState.skippedVersion, undefined, 'skippedVersion should be cleared');
    assert.equal(savedState.lastCheckedAt, '2026-06-01T00:00:00.000Z');
    assert.equal(savedState.lastPromptedVersion, '9999.1.1');
  });

  test('skip sets skippedVersion', async () => {
    const mod = await freshModule();
    let installCalled = false;
    let savedState: any = null;

    const result = await mod.checkServerUpdate({
      prompt: mockPrompt('skip'),
      getLatest: () => '9999.1.1',
      installWhenIdle: () => { installCalled = true; },
      loadState: () => ({ skippedVersion: '2025.1.1', lastCheckedAt: 'old' }),
      saveState: (s: any) => { savedState = s; },
      now: () => '2026-06-01T00:00:00.000Z',
    });

    assert.equal(result.action, 'skip');
    assert.equal(result.latestVersion, '9999.1.1');
    assert.equal(installCalled, false, 'installWhenIdle should NOT be called on skip');
    assert.equal(savedState.skippedVersion, '9999.1.1', 'skippedVersion should be set to latest');
    assert.equal(savedState.lastCheckedAt, '2026-06-01T00:00:00.000Z');
    assert.equal(savedState.lastPromptedVersion, '9999.1.1');
  });

  test('cancel returns cancel without installWhenIdle', async () => {
    const mod = await freshModule();
    let installCalled = false;
    let savedState: any = null;

    const result = await mod.checkServerUpdate({
      prompt: mockPrompt('cancel'),
      getLatest: () => '9999.1.1',
      installWhenIdle: () => { installCalled = true; },
      loadState: () => ({ skippedVersion: '2025.1.1' }),
      saveState: (s: any) => { savedState = s; },
      now: () => '2026-06-01T00:00:00.000Z',
    });

    assert.equal(result.action, 'cancel');
    assert.equal(result.latestVersion, '9999.1.1');
    assert.equal(installCalled, false, 'installWhenIdle should NOT be called on cancel');
    assert.ok(savedState !== null);
    assert.equal(savedState.skippedVersion, '2025.1.1', 'skippedVersion unchanged');
  });

});

describe('self-update from an unbundled install to a bundled release', () => {
  let prefix: string;
  afterEach(() => {
    releaseNewTurnHold();
    vi.unstubAllEnvs();
    installFixture.root = '';
    if (prefix) fs.rmSync(prefix, { recursive: true, force: true });
  });

  test('uses full npm replacement in the existing prefix with restart lifecycle enabled', async () => {
    prefix = unbundledGlobalInstall();
    vi.stubEnv('CORTEX_REPO', '');
    vi.stubEnv('CORTEX_NPM_PREFIX', '');
    const child = mockNpmChild();
    const mod = await freshModule();
    // The updater selects a version; npm owns the incoming manifest and layout, not fast sync.
    const published = { name: '@cortex-agent/server', version: '9999.1.1', cortexBundle: true };
    const result = await mod.checkServerUpdate({
      prompt: mockPrompt('apply'), getLatest: () => published.version,
      loadState: () => null, saveState: () => {},
    });
    try {
      assert.equal(result.action, 'apply');
      assert.equal(vi.mocked(spawn).mock.calls.length, 1);
      const [command, args, options] = vi.mocked(spawn).mock.calls[0];
      const { npmInvocation } = await import('../src/core/utils.js');
      const expected = npmInvocation(['install', '-g', `${published.name}@${published.version}`, '--prefix', prefix]);
      assert.equal(command, expected.command);
      assert.deepEqual(args, expected.args); // No --ignore-scripts: npm runs the package's restart hook.
      assert.deepEqual(options, {
        shell: expected.shell, detached: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: os.tmpdir(),
      });
      assert.equal(child.unref.mock.calls.length, 1);
      assert.equal(child.stderr.unref.mock.calls.length, 1);
    } finally { child.emit('exit', 0, null); }
  });

  test('the existing postinstall restart hook uses the isolated home, not the package layout', async () => {
    prefix = unbundledGlobalInstall();
    const home = path.join(prefix, 'test-home');
    vi.stubEnv('CORTEX_HOME', home);
    fs.mkdirSync(path.join(home, 'data'), { recursive: true });

    // Exercise the hook itself, not npm or a daemon; no watcher runs in this temporary home.
    await importFresh(new URL('../scripts/postinstall-restart-trigger.mjs', import.meta.url));

    assert.equal(fs.readFileSync(path.join(home, 'data', '.restart'), 'utf8'), '');
    assert.equal(fs.existsSync(path.join(installFixture.root, '.restart')), false);
  });
});
