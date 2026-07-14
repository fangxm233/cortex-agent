import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfigSnapshot, handleConfigGet } from '../../../src/domain/ui-service/query/config.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const RAW_SECRET = 'sk-super-secret-value-123456';

async function makeFixture(): Promise<{ configDir: string; hooksDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-fixture-'));
  const configDir = path.join(root, 'config');
  const hooksDir = path.join(root, 'hooks');
  await fs.mkdir(path.join(configDir, 'thread-templates', 'agents'), { recursive: true });
  await fs.mkdir(path.join(configDir, 'thread-templates', 'templates'), { recursive: true });
  await fs.mkdir(path.join(configDir, 'thread-templates', 'shells'), { recursive: true });
  await fs.mkdir(hooksDir, { recursive: true });

  await fs.writeFile(path.join(configDir, 'budget.json'), JSON.stringify({ daily_usd: 100, monthly_usd: 2000 }));
  await fs.writeFile(
    path.join(configDir, 'profiles.json'),
    JSON.stringify({ defaultProfile: 'plan', profiles: { plan: { model: 'm1', backend: 'claude', mode: 'plan' } } }),
  );
  await fs.writeFile(
    path.join(configDir, 'machines.json'),
    JSON.stringify({
      lab2: { cortexPath: '/x', gpuCount: 2 },
      lab: { cortexPath: '/y', gpuCount: 1, ssh: 'user@host', win: false },
    }),
  );
  await fs.writeFile(path.join(configDir, 'mcp-config.json'), JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }));
  await fs.writeFile(path.join(configDir, 'thread-templates', 'agents', 'coder.json'), '{}');
  await fs.writeFile(path.join(configDir, 'thread-templates', 'templates', 'coder-review.json'), '{}');
  await fs.writeFile(path.join(configDir, 'thread-templates', 'shells', 'default.json'), '{}');
  await fs.writeFile(path.join(configDir, '.env'), `# a comment\nSECRET_TOKEN=${RAW_SECRET}\nEMPTY_KEY=\nBASE_URL=https://api.example.com\n`);
  await fs.writeFile(path.join(hooksDir, 'my-hook.mjs'), '// hook');
  return { configDir, hooksDir };
}

test('readConfigSnapshot parses budget', async () => {
  const { configDir, hooksDir } = await makeFixture();
  const snap = await readConfigSnapshot(configDir, hooksDir);
  assert.deepEqual(snap.budget, { daily_usd: 100, monthly_usd: 2000 });
});

test('readConfigSnapshot redacts .env secrets — raw value never appears in the DTO', async () => {
  const { configDir, hooksDir } = await makeFixture();
  const snap = await readConfigSnapshot(configDir, hooksDir);
  const serialized = JSON.stringify(snap);
  assert.ok(!serialized.includes(RAW_SECRET), 'raw secret leaked into snapshot');

  const secret = snap.env.find((e) => e.key === 'SECRET_TOKEN');
  assert.ok(secret, 'SECRET_TOKEN entry missing');
  assert.equal(secret!.present, true);
  assert.notEqual(secret!.masked, RAW_SECRET);
  assert.ok(secret!.masked.length > 0);

  const empty = snap.env.find((e) => e.key === 'EMPTY_KEY');
  assert.ok(empty, 'EMPTY_KEY entry missing');
  assert.equal(empty!.present, false);
  assert.equal(empty!.masked, '');

  const base = snap.env.find((e) => e.key === 'BASE_URL');
  assert.ok(base, 'BASE_URL entry missing');
  assert.equal(base!.present, true);
  // comment line is not an entry
  assert.ok(!snap.env.some((e) => e.key.startsWith('#')));
});

test('readConfigSnapshot maps profiles / machines / mcp / thread-templates / hooks', async () => {
  const { configDir, hooksDir } = await makeFixture();
  const snap = await readConfigSnapshot(configDir, hooksDir);

  assert.equal(snap.profiles!.defaultProfile, 'plan');
  assert.deepEqual(snap.profiles!.profiles, [{ name: 'plan', model: 'm1', backend: 'claude', mode: 'plan' }]);

  const lab2 = snap.machines.find((m) => m.name === 'lab2');
  const lab = snap.machines.find((m) => m.name === 'lab');
  assert.deepEqual(lab2, { name: 'lab2', cortexPath: '/x', gpuCount: 2, ssh: false, win: false });
  assert.equal(lab!.ssh, true, 'ssh should be a presence flag (true), never the raw user@host');
  const serialized = JSON.stringify(snap);
  assert.ok(!serialized.includes('user@host'), 'raw ssh string leaked into snapshot');

  assert.deepEqual(snap.mcp!.servers.sort(), ['alpha', 'beta']);
  assert.deepEqual(snap.threadTemplates.agents, ['coder']);
  assert.deepEqual(snap.threadTemplates.templates, ['coder-review']);
  assert.deepEqual(snap.threadTemplates.shells, ['default']);
  assert.deepEqual(snap.hooks, ['my-hook.mjs']);
});

test('readConfigSnapshot returns null / empty when files are absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-empty-'));
  const snap = await readConfigSnapshot(path.join(root, 'config'), path.join(root, 'hooks'));
  assert.equal(snap.budget, null);
  assert.equal(snap.profiles, null);
  assert.equal(snap.mcp, null);
  assert.deepEqual(snap.machines, []);
  assert.deepEqual(snap.threadTemplates, { agents: [], templates: [], shells: [] });
  assert.deepEqual(snap.hooks, []);
  assert.deepEqual(snap.env, []);
});

function makeMinimalDeps(): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/tmp' }), createProject: () => ({} as any) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    approvalsPath: '/tmp/PENDING_APPROVALS.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: { getProjectConduits: async () => ({}) } as any,
  };
}

test('config.get handler returns a snapshot object', async () => {
  const snap = await handleConfigGet(makeMinimalDeps(), {});
  assert.ok(snap);
  assert.ok('budget' in snap && 'env' in snap && 'machines' in snap && 'threadTemplates' in snap);
});

test('config.get via facade returns ok', async () => {
  const ui = createUiService(makeMinimalDeps());
  const result = await ui.query('config.get', {});
  assert.ok(result.ok);
  assert.ok(Array.isArray(result.data.machines));
});

// The tRPC router binding (Result-unwrap + Err→TRPCError mapping) is covered in
// the ui-http app-router test (tests/platform/ui-http-app-router.test.ts); here we assert the facade snapshot shape.
test('config.get via facade exposes the env snapshot array', async () => {
  const result = await createUiService(makeMinimalDeps()).query('config.get', {});
  assert.ok(result.ok);
  assert.ok(Array.isArray(result.data.env));
});
