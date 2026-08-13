// input:  isolated config home, config schemas and handlers
// output: budget, profile, and runtime-settings mutation tests
// pos:    Regression coverage for config.set writes and validation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeBudget, writeDefaultProfile, handleConfigSet } from '../../../src/domain/ui-service/mutate/config.js';
import { configSetInput } from '../../../src/domain/ui-service/input-schemas.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import { CONFIG_DIR } from '../../../src/core/paths.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

function makeMinimalDeps(): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/tmp' }), createProject: () => ({} as any) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    approvalsPath: '/tmp/PENDING_APPROVALS.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, monthlyBudget: 0, budgetScope: 'global' as const, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: { getProjectConduits: async () => ({}) } as any,
  };
}

// ── pure writer: atomic write proof ─────────────────────────────────
test('writeBudget persists a valid budget atomically (re-read equals input)', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-write-'));
  await writeBudget(configDir, { daily_usd: 42, monthly_usd: 900 });
  const raw = await fs.readFile(path.join(configDir, 'budget.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { daily_usd: 42, monthly_usd: 900, projects: {} });
  // no tmp file left behind
  const leftovers = (await fs.readdir(configDir)).filter((f) => f.includes('.tmp.'));
  assert.deepEqual(leftovers, []);
});

test('writeBudget rejects invalid values without writing', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-write-bad-'));
  await assert.rejects(() => writeBudget(configDir, { daily_usd: -1, monthly_usd: 900 } as any));
  await assert.rejects(() => writeBudget(configDir, { daily_usd: 0, monthly_usd: 900 } as any));
  await assert.rejects(() => writeBudget(configDir, { daily_usd: Number.NaN, monthly_usd: 900 } as any));
  await assert.rejects(() => writeBudget(configDir, { daily_usd: Number.POSITIVE_INFINITY, monthly_usd: 900 } as any));
  const files = await fs.readdir(configDir);
  assert.deepEqual(files, [], 'no file should be written on invalid input');
});

// ── zod schema validation ───────────────────────────────────────────
test('configSetInput accepts a valid budget mutation', () => {
  const parsed = configSetInput.parse({ section: 'budget', value: { daily_usd: 100, monthly_usd: 2000 } });
  assert.equal(parsed.section, 'budget');
  assert.deepEqual(parsed.value, { daily_usd: 100, monthly_usd: 2000 });
});

test('configSetInput accepts partial settings and rejects unknown or wrongly typed keys', () => {
  const value = {
    turnNotify: false,
    sessionRetentionDays: 14,
    taskDispatchMaxConcurrent: null,
    taskDispatchEnabled: true,
    taskDispatchIntervalMs: 30_000,
    uiCorsOrigins: ['https://ui.example'],
  };
  const parsed = configSetInput.parse({ section: 'settings', value });
  assert.equal(parsed.section, 'settings');
  assert.deepEqual(parsed.value, value);
  assert.throws(() => configSetInput.parse({ section: 'settings', value: { unknownSetting: true } }));
  assert.throws(() => configSetInput.parse({ section: 'settings', value: { turnNotify: 'false' } }));
  assert.throws(() => configSetInput.parse({ section: 'settings', value: { turnNotify: undefined } }));
  assert.throws(() => configSetInput.parse({ section: 'settings', value: { uiCorsOrigins: [42] } }));
});

test('configSetInput rejects built-in job intervals outside safe timer bounds', () => {
  assert.doesNotThrow(() => configSetInput.parse({
    section: 'settings', value: { taskArchiveIntervalMs: 1_000 },
  }));
  for (const value of [999, 1_000.5, 2_147_483_648]) {
    assert.throws(() => configSetInput.parse({
      section: 'settings', value: { memoryIndexRegenIntervalMs: value },
    }));
  }
});

test('configSetInput accepts valid sessionRetentionDays and rejects zero, fractions, and unsafe values', () => {
  const maxDays = Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000);
  assert.deepEqual(
    configSetInput.parse({ section: 'settings', value: { sessionRetentionDays: 30 } }),
    { section: 'settings', value: { sessionRetentionDays: 30 } },
  );
  assert.doesNotThrow(() => configSetInput.parse({ section: 'settings', value: { sessionRetentionDays: maxDays } }));
  for (const value of [0, 1.5, maxDays + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => configSetInput.parse({
      section: 'settings', value: { sessionRetentionDays: value },
    }));
  }
});

test('configSetInput rejects illegal values / shapes', () => {
  assert.throws(() => configSetInput.parse({ section: 'budget', value: { daily_usd: -5, monthly_usd: 2000 } }));
  assert.throws(() => configSetInput.parse({ section: 'budget', value: { daily_usd: 0, monthly_usd: 2000 } }));
  assert.throws(() => configSetInput.parse({ section: 'budget', value: { daily_usd: Number.POSITIVE_INFINITY, monthly_usd: 2000 } }));
  assert.throws(() => configSetInput.parse({ section: 'budget', value: { daily_usd: 100, monthly_usd: Number.NaN } }));
  assert.throws(() => configSetInput.parse({ section: 'budget', value: { daily_usd: 100 } }));
  assert.throws(() => configSetInput.parse({ section: 'budget', value: { daily_usd: 'x', monthly_usd: 2000 } }));
  assert.throws(() => configSetInput.parse({ section: 'profiles', value: {} }));
  assert.throws(() => configSetInput.parse({ value: { daily_usd: 100, monthly_usd: 2000 } }));
});

// ── handler section guard (defensive: direct calls bypass the router) ─
test('handleConfigSet rejects a non-budget section with invalid-args', async () => {
  const result = await handleConfigSet(makeMinimalDeps(), { section: 'profiles' as any, value: {} as any });
  assert.equal(result.ok, false);
  assert.equal((result as any).code, 'invalid-args');
});

test('handleConfigSet rejects an invalid budget with invalid-args (no write)', async () => {
  const result = await handleConfigSet(makeMinimalDeps(), { section: 'budget', value: { daily_usd: -1, monthly_usd: 5 } });
  assert.equal(result.ok, false);
  assert.equal((result as any).code, 'invalid-args');
});

test('handleConfigSet rejects unknown and wrongly typed settings with invalid-args', async () => {
  const unknown = await handleConfigSet(
    makeMinimalDeps(),
    { section: 'settings', value: { unknownSetting: true } } as any,
  );
  const wrongType = await handleConfigSet(
    makeMinimalDeps(),
    { section: 'settings', value: { turnNotify: 'false' } } as any,
  );
  const explicitUndefined = await handleConfigSet(
    makeMinimalDeps(),
    { section: 'settings', value: { turnNotify: undefined } } as any,
  );
  const unsafeInterval = await handleConfigSet(
    makeMinimalDeps(),
    { section: 'settings', value: { taskDispatchIntervalMs: 999 } } as any,
  );
  const invalidRetention = await handleConfigSet(
    makeMinimalDeps(),
    { section: 'settings', value: { sessionRetentionDays: 0 } } as any,
  );
  assert.equal(unknown.ok, false);
  assert.equal(wrongType.ok, false);
  assert.equal(explicitUndefined.ok, false);
  assert.equal(unsafeInterval.ok, false);
  assert.equal(invalidRetention.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, 'invalid-args');
  if (!wrongType.ok) assert.equal(wrongType.code, 'invalid-args');
  if (!explicitUndefined.ok) assert.equal(explicitUndefined.code, 'invalid-args');
  if (!unsafeInterval.ok) assert.equal(unsafeInterval.code, 'invalid-args');
  if (!invalidRetention.ok) assert.equal(invalidRetention.code, 'invalid-args');
});

// ── facade + app-router wiring ──────────────────────────────────────
test('config.set via facade writes to the isolated CONFIG_DIR and returns written', async () => {
  const ui = createUiService(makeMinimalDeps());
  const result = await ui.mutate('config.set', { section: 'budget', value: { daily_usd: 55, monthly_usd: 1234 } });
  assert.ok(result.ok);
  assert.deepEqual(result.data, { written: true, section: 'budget' });
  // read it back through config.get (same isolated CONFIG_DIR)
  const got = await ui.query('config.get', {});
  assert.ok(got.ok);
  assert.deepEqual(got.data.budget, { daily_usd: 55, monthly_usd: 1234, projects: {} });
});

// ── per-project budget overrides ────────────────────────────────────
test('writeBudget with a project stores an override and preserves the globals', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-proj-'));
  await writeBudget(configDir, { daily_usd: 300, monthly_usd: 8000 });
  await writeBudget(configDir, { daily_usd: 5, monthly_usd: 100 }, 'alpha');
  const raw = JSON.parse(await fs.readFile(path.join(configDir, 'budget.json'), 'utf8'));
  assert.deepEqual(raw, {
    daily_usd: 300, monthly_usd: 8000,
    projects: { alpha: { daily_usd: 5, monthly_usd: 100 } },
  });
});

test('writeBudget global edit preserves every per-project override', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-proj-keep-'));
  await writeBudget(configDir, { daily_usd: 5, monthly_usd: 100 }, 'alpha');
  await writeBudget(configDir, { daily_usd: 9, monthly_usd: 90 }, 'beta');
  await writeBudget(configDir, { daily_usd: 250, monthly_usd: 7000 });
  const raw = JSON.parse(await fs.readFile(path.join(configDir, 'budget.json'), 'utf8'));
  assert.equal(raw.daily_usd, 250);
  assert.deepEqual(raw.projects, {
    alpha: { daily_usd: 5, monthly_usd: 100 },
    beta: { daily_usd: 9, monthly_usd: 90 },
  });
});

test('writeBudget with a null value clears only that project override', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-proj-clear-'));
  await writeBudget(configDir, { daily_usd: 300, monthly_usd: 8000 });
  await writeBudget(configDir, { daily_usd: 5, monthly_usd: 100 }, 'alpha');
  await writeBudget(configDir, { daily_usd: 9, monthly_usd: 90 }, 'beta');
  await writeBudget(configDir, null, 'alpha');
  const raw = JSON.parse(await fs.readFile(path.join(configDir, 'budget.json'), 'utf8'));
  assert.deepEqual(raw.projects, { beta: { daily_usd: 9, monthly_usd: 90 } });
  assert.equal(raw.daily_usd, 300, 'globals untouched');
});

test('writeBudget emits one consistent shape regardless of which write path ran last', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-proj-empty-'));
  await writeBudget(configDir, { daily_usd: 300, monthly_usd: 8000 });
  await writeBudget(configDir, { daily_usd: 5, monthly_usd: 100 }, 'alpha');
  await writeBudget(configDir, null, 'alpha');
  const raw = JSON.parse(await fs.readFile(path.join(configDir, 'budget.json'), 'utf8'));
  // The domain path (costRepo, behind !budget) serialises the whole BudgetConfig including an
  // empty map; this path matches it rather than producing a shape that depends on the surface.
  assert.deepEqual(raw, { daily_usd: 300, monthly_usd: 8000, projects: {} });
});

test('configSetInput accepts the project forms and rejects a projectless clear', () => {
  const set = configSetInput.parse({ section: 'budget', project: 'alpha', value: { daily_usd: 5, monthly_usd: 100 } });
  assert.equal(set.section, 'budget');
  const clear = configSetInput.parse({ section: 'budget', project: 'alpha', value: null });
  assert.equal((clear as any).value, null);
  // A null value means "clear an override" — meaningless, and destructive-looking, without one.
  assert.throws(() => configSetInput.parse({ section: 'budget', value: null }));
  assert.throws(() => configSetInput.parse({ section: 'budget', project: '', value: { daily_usd: 5, monthly_usd: 100 } }));
  // Overrides stay pair-only: a half-pair is rejected the same way for projects as for globals.
  assert.throws(() => configSetInput.parse({ section: 'budget', project: 'alpha', value: { daily_usd: 5 } }));
});

test('config.set via facade round-trips a per-project override through config.get', async () => {
  const ui = createUiService(makeMinimalDeps());
  await ui.mutate('config.set', { section: 'budget', value: { daily_usd: 300, monthly_usd: 8000 } });
  const written = await ui.mutate('config.set', {
    section: 'budget', project: 'alpha', value: { daily_usd: 5, monthly_usd: 100 },
  });
  assert.ok(written.ok);

  const got = await ui.query('config.get', {});
  assert.ok(got.ok);
  assert.deepEqual(got.data.budget, {
    daily_usd: 300, monthly_usd: 8000,
    projects: { alpha: { daily_usd: 5, monthly_usd: 100 } },
  });

  const cleared = await ui.mutate('config.set', { section: 'budget', project: 'alpha', value: null });
  assert.ok(cleared.ok);
  const after = await ui.query('config.get', {});
  assert.ok(after.ok);
  assert.deepEqual(after.data.budget?.projects, {});
});

test('config.set settings writes without retention side-effect hooks', async () => {
  const deps = makeMinimalDeps();
  const first = await handleConfigSet(deps, {
    section: 'settings',
    value: { turnNotify: false },
  } as any);
  const second = await handleConfigSet(deps, {
    section: 'settings',
    value: { sessionRetentionDays: 45 },
  } as any);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});

test('config.set settings remains successful when async CC retention sync fails later', async () => {
  const result = await handleConfigSet(makeMinimalDeps(), {
    section: 'settings',
    value: { sessionRetentionDays: 60 },
  } as any);

  assert.deepEqual(result, { ok: true, data: { written: true, section: 'settings' } });
  const settings = JSON.parse(await fs.readFile(path.join(CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.equal(settings.sessionRetentionDays, 60);
});
