// input:  Node test runner, server-update-check module
// output: tests for compareCalVer, isUpdateDevMode, checkServerUpdate
// pos:    DR-0013 core checker — all branches covered

import { describe, test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  compareCalVer,
} from '../src/domain/system/server-update-check.js';

// ── Helpers ─────────────────────────────────────────────────────

function freshModule() {
  const url = new URL('../src/domain/system/server-update-check.js', import.meta.url);
  url.searchParams.set('ts', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return import(url.href) as Promise<{
    compareCalVer: typeof compareCalVer;
    isUpdateDevMode: () => boolean;
    checkServerUpdate: (deps: any) => Promise<any>;
  }>;
}

function mockPrompt(result: 'apply' | 'skip' | 'cancel' | null) {
  return { ask: async () => result };
}

// ============================================================
// compareCalVer
// ============================================================

test('compareCalVer - same version returns 0', () => {
  assert.equal(compareCalVer('2026.5.23', '2026.5.23'), 0);
  assert.equal(compareCalVer('2027.1.1', '2027.1.1'), 0);
});

test('compareCalVer - different day, same month/year', () => {
  assert.ok(compareCalVer('2026.5.23', '2026.5.9') > 0, '23 > 9');
  assert.ok(compareCalVer('2026.5.9', '2026.5.23') < 0, '9 < 23');
});

test('compareCalVer - cross-digit day boundary', () => {
  assert.ok(compareCalVer('2026.5.9', '2026.5.10') < 0, '9 < 10');
  assert.ok(compareCalVer('2026.5.10', '2026.5.9') > 0, '10 > 9');
});

test('compareCalVer - suffix comparison', () => {
  assert.ok(compareCalVer('2026.5.23-2', '2026.5.23-1') > 0, '-2 > -1');
  assert.ok(compareCalVer('2026.5.23-1', '2026.5.23-2') < 0, '-1 < -2');
  assert.ok(compareCalVer('2026.5.23-1', '2026.5.23') > 0, '-1 > absent (default 0)');
  assert.ok(compareCalVer('2026.5.23', '2026.5.23-1') < 0, 'absent (default 0) < -1');
});

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

  test('apply calls spawnInstall and clears skippedVersion', async () => {
    const mod = await freshModule();
    let installCalled = false;
    let savedState: any = null;

    const result = await mod.checkServerUpdate({
      prompt: mockPrompt('apply'),
      getLatest: () => '9999.1.1',
      spawnInstall: () => { installCalled = true; },
      loadState: () => ({ skippedVersion: '2025.1.1' }),
      saveState: (s: any) => { savedState = s; },
      now: () => '2026-06-01T00:00:00.000Z',
    });

    assert.equal(result.action, 'apply');
    assert.equal(result.latestVersion, '9999.1.1');
    assert.equal(installCalled, true, 'spawnInstall should have been called');
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
      spawnInstall: () => { installCalled = true; },
      loadState: () => ({ skippedVersion: '2025.1.1', lastCheckedAt: 'old' }),
      saveState: (s: any) => { savedState = s; },
      now: () => '2026-06-01T00:00:00.000Z',
    });

    assert.equal(result.action, 'skip');
    assert.equal(result.latestVersion, '9999.1.1');
    assert.equal(installCalled, false, 'spawnInstall should NOT be called on skip');
    assert.equal(savedState.skippedVersion, '9999.1.1', 'skippedVersion should be set to latest');
    assert.equal(savedState.lastCheckedAt, '2026-06-01T00:00:00.000Z');
    assert.equal(savedState.lastPromptedVersion, '9999.1.1');
  });

  test('cancel returns cancel without spawnInstall', async () => {
    const mod = await freshModule();
    let installCalled = false;
    let savedState: any = null;

    const result = await mod.checkServerUpdate({
      prompt: mockPrompt('cancel'),
      getLatest: () => '9999.1.1',
      spawnInstall: () => { installCalled = true; },
      loadState: () => ({ skippedVersion: '2025.1.1' }),
      saveState: (s: any) => { savedState = s; },
      now: () => '2026-06-01T00:00:00.000Z',
    });

    assert.equal(result.action, 'cancel');
    assert.equal(result.latestVersion, '9999.1.1');
    assert.equal(installCalled, false, 'spawnInstall should NOT be called on cancel');
    assert.ok(savedState !== null);
    assert.equal(savedState.skippedVersion, '2025.1.1', 'skippedVersion unchanged');
  });

});
