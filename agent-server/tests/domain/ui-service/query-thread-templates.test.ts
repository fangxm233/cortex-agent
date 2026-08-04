import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readThreadTemplates,
  handleThreadTemplatesGet,
} from '../../../src/domain/ui-service/query/thread-templates.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-fixture-'));
  const configDir = path.join(root, 'config');
  const tt = path.join(configDir, 'thread-templates');
  await fs.mkdir(path.join(tt, 'agents'), { recursive: true });
  await fs.mkdir(path.join(tt, 'templates'), { recursive: true });
  await fs.mkdir(path.join(tt, 'shells'), { recursive: true });

  await fs.writeFile(
    path.join(tt, 'agents', 'executor.json'),
    JSON.stringify({
      name: 'executor',
      description: 'Executor — performs assigned work',
      profile: 'execute',
      directive: 'file:executor.md',
      entryStage: 'execute',
      stages: { execute: { description: 'Do the work' }, retry: { description: 'Fix issues' } },
      tools: 'Agent,Bash,Edit,Glob,Grep',
      pluginDirs: ['plugins/cortex-common'],
    }),
  );

  await fs.writeFile(
    path.join(tt, 'templates', 'default.json'),
    JSON.stringify({
      name: 'default',
      description: 'Single agent template',
      agents: ['__active__'],
      transitions: [],
      entryAgent: '__active__',
      maxTotalSteps: 1,
    }),
  );

  await fs.writeFile(
    path.join(tt, 'shells', 'worker-review.json'),
    JSON.stringify({
      shell: 'worker-review',
      worker: 'executor',
      reviewer: 'executor-reviewer',
      description: 'Execute-then-review shell',
    }),
  );

  return configDir;
}

test('readThreadTemplates returns one entry per kind from fixture dirs', async () => {
  const configDir = await makeFixture();
  const entries = await readThreadTemplates(configDir);

  assert.equal(entries.length, 3);
  const kinds = new Set(entries.map((e) => e.kind));
  assert.ok(kinds.has('agent'), 'should include agent kind');
  assert.ok(kinds.has('template'), 'should include template kind');
  assert.ok(kinds.has('shell'), 'should include shell kind');
});

test('readThreadTemplates agent entry has name and non-null body', async () => {
  const configDir = await makeFixture();
  const entries = await readThreadTemplates(configDir);
  const executor = entries.find((e) => e.kind === 'agent' && e.name === 'executor');
  assert.ok(executor, 'executor agent entry missing');
  assert.equal(executor.description, 'Executor — performs assigned work');
  assert.ok(executor.body !== null, 'body should be non-null for a valid JSON file');
  // body carries the real parsed content
  assert.equal((executor.body as Record<string, unknown>).profile, 'execute');
  assert.equal((executor.body as Record<string, unknown>).entryStage, 'execute');
});

test('readThreadTemplates template entry has name and non-null body', async () => {
  const configDir = await makeFixture();
  const entries = await readThreadTemplates(configDir);
  const tmpl = entries.find((e) => e.kind === 'template' && e.name === 'default');
  assert.ok(tmpl, 'default template entry missing');
  assert.equal(tmpl.description, 'Single agent template');
  assert.ok(tmpl.body !== null);
  assert.equal((tmpl.body as Record<string, unknown>).entryAgent, '__active__');
});

test('readThreadTemplates shell entry has name and non-null body', async () => {
  const configDir = await makeFixture();
  const entries = await readThreadTemplates(configDir);
  const shell = entries.find((e) => e.kind === 'shell' && e.name === 'worker-review');
  assert.ok(shell, 'worker-review shell entry missing');
  assert.equal(shell.description, 'Execute-then-review shell');
  assert.ok(shell.body !== null);
  assert.equal((shell.body as Record<string, unknown>).worker, 'executor');
});

test('readThreadTemplates returns empty array when dirs are absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-empty-'));
  const entries = await readThreadTemplates(path.join(root, 'config'));
  assert.deepEqual(entries, []);
});

test('readThreadTemplates sets body=null for malformed JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-bad-'));
  const agentDir = path.join(root, 'config', 'thread-templates', 'agents');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, 'bad.json'), 'not-json{{{');
  const entries = await readThreadTemplates(path.join(root, 'config'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'bad');
  assert.equal(entries[0].kind, 'agent');
  assert.equal(entries[0].body, null);
});

test('readThreadTemplates entries are sorted by name within each kind', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-sort-'));
  const agentDir = path.join(root, 'config', 'thread-templates', 'agents');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, 'z-last.json'), '{}');
  await fs.writeFile(path.join(agentDir, 'a-first.json'), '{}');
  const entries = await readThreadTemplates(path.join(root, 'config'));
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, ['a-first', 'z-last']);
});

test('handleThreadTemplatesGet returns an array via the handler', async () => {
  const result = await handleThreadTemplatesGet(makeMinimalDeps(), {});
  assert.ok(Array.isArray(result));
});

test('threadTemplates.get via facade returns ok with array data', async () => {
  const ui = createUiService(makeMinimalDeps());
  const result = await ui.query('threadTemplates.get', {});
  assert.ok(result.ok, `expected ok but got ${JSON.stringify(result)}`);
  assert.ok(Array.isArray(result.data));
});

function makeMinimalDeps(): UiServiceDeps {
  return {
    projectStore: {
      list: () => [],
      get: () => undefined,
      exists: () => false,
      getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/tmp' }),
      createProject: () => ({} as any),
    },
    sessionStore: {
      listByProject: async () => [],
      listByOrigin: async () => [],
      listResumable: async () => [],
      getById: async () => null,
    },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: {
      list: async () => [],
      get: async () => null,
      pause: async () => null,
      resume: async () => null,
      remove: async () => false,
      add: async () => ({ id: 'sch_new' } as any),
      update: async () => null,
    },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    approvalsPath: '/tmp/PENDING_APPROVALS.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({
      today: 0, week: 0, month: 0, total: 0,
      byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {},
      tokens: {} as any, entryCount: 0, dailyBudget: 0, forecastToday: 0,
      dailyCost: [], byTriggerScoped: {},
    }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: { getProjectConduits: async () => ({}) } as any,
  };
}
