// input:  settings module, isolated config and env
// output: parsing, provenance, failure, reload, and write tests
// pos:    Specifies the L0 runtime settings contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../../src/core/paths.js';
import { SETTINGS_SPEC } from '../../src/core/settings-spec.js';
import {
  getSettings,
  getSettingsSnapshot,
  onSettingsChange,
  updateSettings,
} from '../../src/core/settings.js';

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const ENV_NAMES = [
  'CORTEX_TURN_NOTIFY',
  'CORTEX_TURN_NOTIFY_THRESHOLD_S',
  'CORTEX_NOTIFY_COMPACTION',
  'CORTEX_SHOW_TOOL_CALLS',
  'CORTEX_STATUS_NEWQ_BUTTON',
  'CORTEX_AUTO_RESUME',
  'CORTEX_STREAM_DELTAS',
  'CORTEX_BG_CONTINUATION',
  'CORTEX_EVENT_LOG',
  'CORTEX_DISABLE_USER_CONTEXT',
  'CORTEX_SERVER_UPDATE_DISABLE',
  'CORTEX_HOOKS_LEGACY',
  'CORTEX_MANAGER_ROTATE_STEPS',
  'CORTEX_WAITING_SWEEP_MS',
  'CORTEX_INJECT_WAIT_MAX_S',
  'CORTEX_THREAD_MAX_DEPTH',
  'CORTEX_TASK_ARTIFACT_TEMPLATES',
  'TASK_DISPATCH_MAX_CONCURRENT',
  'CORTEX_UI_CORS_ORIGINS',
  'SLACK_ADMIN_CHANNEL',
  'CORTEX_ADMIN_CHANNEL',
  'FEISHU_ADMIN_CHANNEL',
] as const;

const originalEnv = new Map<string, string | undefined>();

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), 'condition did not become true before timeout');
}

beforeAll(async () => {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  for (const name of ENV_NAMES) {
    originalEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env.CORTEX_TURN_NOTIFY = '0';
  process.env.CORTEX_TURN_NOTIFY_THRESHOLD_S = '25';
  process.env.CORTEX_SHOW_TOOL_CALLS = ' yes ';
  process.env.TASK_DISPATCH_MAX_CONCURRENT = '8';
  process.env.CORTEX_UI_CORS_ORIGINS = 'https://env.example';
  process.env.SLACK_ADMIN_CHANNEL = 'slack-admin';
  process.env.CORTEX_ADMIN_CHANNEL = 'cortex-admin';
  await fs.writeFile(SETTINGS_FILE, JSON.stringify({
    turnNotify: true,
    turnNotifyThresholdS: 0,
    taskDispatchMaxConcurrent: null,
    uiCorsOrigins: [],
  }));
});

afterAll(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const expectedKeys = [
  'turnNotify',
  'turnNotifyThresholdS',
  'notifyCompaction',
  'showToolCalls',
  'statusNewqButton',
  'autoResume',
  'streamDeltas',
  'bgContinuation',
  'eventLog',
  'disableUserContext',
  'serverUpdateDisable',
  'hooksLegacy',
  'managerRotateSteps',
  'waitingSweepMs',
  'injectWaitMaxS',
  'threadMaxDepth',
  'taskArtifactTemplates',
  'taskDispatchMaxConcurrent',
  'uiCorsOrigins',
  'adminChannel',
  'feishuAdminChannel',
];

const expectedDefaults = {
  turnNotify: true,
  turnNotifyThresholdS: 60,
  notifyCompaction: false,
  showToolCalls: false,
  statusNewqButton: false,
  autoResume: true,
  streamDeltas: true,
  bgContinuation: true,
  eventLog: true,
  disableUserContext: false,
  serverUpdateDisable: false,
  hooksLegacy: false,
  managerRotateSteps: 10,
  waitingSweepMs: 60_000,
  injectWaitMaxS: 600,
  threadMaxDepth: 5,
  taskArtifactTemplates: ['manager'],
  taskDispatchMaxConcurrent: null,
  uiCorsOrigins: [],
  adminChannel: null,
  feishuAdminChannel: null,
};

describe.sequential('core settings', () => {
  test('SETTINGS_SPEC declares all 21 keys with exact env mapping, type, default, and parser metadata', () => {
    assert.deepEqual(Object.keys(SETTINGS_SPEC), expectedKeys);
    assert.deepEqual(
      Object.fromEntries(Object.entries(SETTINGS_SPEC).map(([key, entry]) => [key, entry.envVar])),
      {
        turnNotify: 'CORTEX_TURN_NOTIFY',
        turnNotifyThresholdS: 'CORTEX_TURN_NOTIFY_THRESHOLD_S',
        notifyCompaction: 'CORTEX_NOTIFY_COMPACTION',
        showToolCalls: 'CORTEX_SHOW_TOOL_CALLS',
        statusNewqButton: 'CORTEX_STATUS_NEWQ_BUTTON',
        autoResume: 'CORTEX_AUTO_RESUME',
        streamDeltas: 'CORTEX_STREAM_DELTAS',
        bgContinuation: 'CORTEX_BG_CONTINUATION',
        eventLog: 'CORTEX_EVENT_LOG',
        disableUserContext: 'CORTEX_DISABLE_USER_CONTEXT',
        serverUpdateDisable: 'CORTEX_SERVER_UPDATE_DISABLE',
        hooksLegacy: 'CORTEX_HOOKS_LEGACY',
        managerRotateSteps: 'CORTEX_MANAGER_ROTATE_STEPS',
        waitingSweepMs: 'CORTEX_WAITING_SWEEP_MS',
        injectWaitMaxS: 'CORTEX_INJECT_WAIT_MAX_S',
        threadMaxDepth: 'CORTEX_THREAD_MAX_DEPTH',
        taskArtifactTemplates: 'CORTEX_TASK_ARTIFACT_TEMPLATES',
        taskDispatchMaxConcurrent: 'TASK_DISPATCH_MAX_CONCURRENT',
        uiCorsOrigins: 'CORTEX_UI_CORS_ORIGINS',
        adminChannel: ['SLACK_ADMIN_CHANNEL', 'CORTEX_ADMIN_CHANNEL'],
        feishuAdminChannel: 'FEISHU_ADMIN_CHANNEL',
      },
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(SETTINGS_SPEC).map(([key, entry]) => [key, entry.default])),
      expectedDefaults,
    );
    for (const entry of Object.values(SETTINGS_SPEC)) {
      assert.equal(typeof entry.type, 'string');
      assert.equal(typeof entry.legacyParse, 'function');
    }
  });

  test('all legacy parsers preserve their distinct historical semantics', () => {
    const cases: Array<[keyof typeof SETTINGS_SPEC, string, unknown]> = [
      ['turnNotify', ' OFF ', false],
      ['turnNotify', '', true],
      ['turnNotifyThresholdS', '12.5', 12.5],
      ['turnNotifyThresholdS', '0', 60],
      ['turnNotifyThresholdS', 'bad', 60],
      ['notifyCompaction', '1', true],
      ['notifyCompaction', 'true', false],
      ['showToolCalls', ' YES ', true],
      ['showToolCalls', '2', false],
      ['statusNewqButton', ' on ', true],
      ['statusNewqButton', 'y', false],
      ['autoResume', 'false', false],
      ['autoResume', ' FALSE ', true],
      ['streamDeltas', '0', false],
      ['streamDeltas', 'off', true],
      ['bgContinuation', ' No ', false],
      ['bgContinuation', '', true],
      ['eventLog', 'off', false],
      ['eventLog', 'OFF', true],
      ['disableUserContext', '1', true],
      ['disableUserContext', 'true', false],
      ['serverUpdateDisable', '1', true],
      ['serverUpdateDisable', 'on', false],
      ['hooksLegacy', '1', true],
      ['hooksLegacy', 'yes', false],
      ['managerRotateSteps', '12steps', 12],
      ['managerRotateSteps', '-1', 10],
      ['managerRotateSteps', 'bad', 10],
      ['waitingSweepMs', '250ms', 250],
      ['waitingSweepMs', '0', 0],
      ['waitingSweepMs', '-2', -2],
      ['waitingSweepMs', 'bad', 60_000],
      ['injectWaitMaxS', '2.5', 2.5],
      ['injectWaitMaxS', '', 0],
      ['injectWaitMaxS', 'bad', Number.NaN],
      ['threadMaxDepth', '7levels', 7],
      ['threadMaxDepth', '0', 5],
      ['threadMaxDepth', '-2', -2],
      ['threadMaxDepth', 'bad', 5],
      ['taskArtifactTemplates', ' manager, coder-review, ,', ['manager', 'coder-review']],
      ['taskArtifactTemplates', '', []],
      ['taskDispatchMaxConcurrent', '8workers', 8],
      ['taskDispatchMaxConcurrent', '0', null],
      ['taskDispatchMaxConcurrent', ' ', null],
      ['uiCorsOrigins', ' https://a.example, ,https://b.example ', ['https://a.example', 'https://b.example']],
      ['uiCorsOrigins', '', []],
      ['adminChannel', 'C123', 'C123'],
      ['adminChannel', '', null],
      ['feishuAdminChannel', 'oc_123', 'oc_123'],
      ['feishuAdminChannel', '', null],
    ];

    for (const [key, raw, expected] of cases) {
      assert.deepEqual(SETTINGS_SPEC[key].legacyParse(raw), expected, `${key}(${JSON.stringify(raw)})`);
    }
  });

  test('getSettings resolves file before env before defaults and logs env deprecations', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settings = getSettings();

    assert.equal(settings.turnNotify, true, 'explicit file true must beat env false');
    assert.equal(settings.turnNotifyThresholdS, 0, 'explicit file 0 must beat env');
    assert.equal(settings.showToolCalls, true, 'absent file key must use env');
    assert.equal(settings.managerRotateSteps, 10, 'absent file/env key must use default');
    assert.equal(settings.taskDispatchMaxConcurrent, null, 'explicit file null must beat env');
    assert.deepEqual(settings.uiCorsOrigins, [], 'explicit file [] must beat env');
    assert.equal(settings.adminChannel, 'slack-admin', 'Slack legacy alias must have first priority');
    assert.equal(settings.feishuAdminChannel, null);
    const snapshot = getSettingsSnapshot();
    assert.deepEqual(
      snapshot.find((entry) => entry.key === 'turnNotify'),
      { key: 'turnNotify', value: true, source: 'file' },
    );
    assert.deepEqual(
      snapshot.find((entry) => entry.key === 'showToolCalls'),
      { key: 'showToolCalls', value: true, source: 'env' },
    );
    assert.deepEqual(
      snapshot.find((entry) => entry.key === 'managerRotateSteps'),
      { key: 'managerRotateSteps', value: 10, source: 'default' },
    );
    delete process.env.CORTEX_SHOW_TOOL_CALLS;
    try {
      assert.deepEqual(
        getSettingsSnapshot().find((entry) => entry.key === 'showToolCalls'),
        { key: 'showToolCalls', value: true, source: 'env' },
        'snapshot provenance must preserve the initialized env fallback',
      );
    } finally {
      process.env.CORTEX_SHOW_TOOL_CALLS = ' yes ';
    }

    const messages = warn.mock.calls.map((args) => args.join(' ')).join('\n');
    assert.match(messages, /CORTEX_SHOW_TOOL_CALLS/);
    assert.match(messages, /SLACK_ADMIN_CHANNEL/);
    const warningCount = warn.mock.calls.length;
    getSettings();
    assert.equal(warn.mock.calls.length, warningCount, 'cached reads must not repeat deprecation logs');
  });

  test('getSettings caches legacy env fallbacks after initialization', () => {
    const previous = process.env.CORTEX_AUTO_RESUME;
    try {
      const initial = getSettings().autoResume;
      process.env.CORTEX_AUTO_RESUME = initial ? '0' : '1';
      assert.equal(getSettings().autoResume, initial);
    } finally {
      if (previous === undefined) delete process.env.CORTEX_AUTO_RESUME;
      else process.env.CORTEX_AUTO_RESUME = previous;
    }
  });

  test('external settings edits hot-reload and report effective keys in spec order', async (t) => {
    const batches: string[][] = [];
    const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
    t.onTestFinished(unsubscribe);

    await fs.writeFile(SETTINGS_FILE, JSON.stringify({
      turnNotify: false,
      turnNotifyThresholdS: 0,
      showToolCalls: false,
      managerRotateSteps: 7,
      taskArtifactTemplates: [],
      uiCorsOrigins: ['https://file.example'],
    }));

    await waitFor(() => batches.length === 1);
    assert.deepEqual(batches[0], [
      'turnNotify',
      'showToolCalls',
      'managerRotateSteps',
      'taskArtifactTemplates',
      'taskDispatchMaxConcurrent',
      'uiCorsOrigins',
    ]);
    assert.equal(getSettings().taskDispatchMaxConcurrent, 8, 'removed file key must reveal env fallback');
    assert.deepEqual(getSettings().taskArtifactTemplates, []);
  });

  test('admin env fallback uses CORTEX_ADMIN_CHANNEL when Slack is empty or absent', async (t) => {
    const batches: string[][] = [];
    const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
    t.onTestFinished(unsubscribe);
    const current = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));

    process.env.SLACK_ADMIN_CHANNEL = '';
    await fs.writeFile(SETTINGS_FILE, JSON.stringify({ ...current, eventLog: false }));
    await waitFor(() => batches.length === 1);
    assert.equal(getSettings().adminChannel, 'cortex-admin');
    assert.deepEqual(batches[0], ['eventLog', 'adminChannel']);

    delete process.env.SLACK_ADMIN_CHANNEL;
    await fs.writeFile(SETTINGS_FILE, JSON.stringify({ ...current, eventLog: true }));
    await waitFor(() => batches.length === 2);
    assert.equal(getSettings().adminChannel, 'cortex-admin');
    assert.deepEqual(batches[1], ['eventLog']);
    process.env.SLACK_ADMIN_CHANNEL = 'slack-admin';
  });

  test('watcher ignores changes to unrelated config filenames', async (t) => {
    const batches: string[][] = [];
    const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
    t.onTestFinished(unsubscribe);

    await fs.writeFile(path.join(CONFIG_DIR, 'settings-unrelated.json'), '{"turnNotify":false}');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(batches, []);
  });

  test('malformed JSON and type mismatches log errors and retain the last valid snapshot', async (t) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const batches: string[][] = [];
    const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
    t.onTestFinished(unsubscribe);
    const previous = getSettings();

    await fs.writeFile(SETTINGS_FILE, '{');
    await waitFor(() => errors.mock.calls.length >= 1);
    assert.strictEqual(getSettings(), previous);
    assert.deepEqual(batches, []);

    const firstErrorCount = errors.mock.calls.length;
    await fs.writeFile(SETTINGS_FILE, JSON.stringify({ turnNotify: 'false' }));
    await waitFor(() => errors.mock.calls.length > firstErrorCount);
    assert.strictEqual(getSettings(), previous);
    assert.deepEqual(batches, []);
  });

  test('updateSettings merges a pending external edit before its watcher debounce fires', async () => {
    getSettings();
    const external = {
      turnNotify: false,
      showToolCalls: false,
      uiCorsOrigins: ['https://external.example'],
      futureSetting: { enabled: true },
    };
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(external));
    await updateSettings({ managerRotateSteps: 9 });

    const parsed = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    assert.deepEqual(parsed.futureSetting, { enabled: true });
    assert.deepEqual(parsed.uiCorsOrigins, ['https://external.example']);
    assert.equal(parsed.managerRotateSteps, 9);
  });

  test('updateSettings logs and falls back to cached overrides when disk read fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await updateSettings({
      turnNotify: false,
      showToolCalls: false,
      uiCorsOrigins: ['https://cached.example'],
    });
    const cached = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));

    await fs.writeFile(SETTINGS_FILE, '{');
    await updateSettings({ managerRotateSteps: 11 });

    const messages = errors.mock.calls.map((args) => args.join(' ')).join('\n');
    assert.match(messages, /Update settings\.json read failed/);
    assert.match(messages, /using previous settings/);
    assert.deepEqual(
      JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')),
      { ...cached, managerRotateSteps: 11 },
    );
  });

  test('updateSettings is atomic, has no watcher echo, and does not mask a following external edit', async (t) => {
    const batches: string[][] = [];
    const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
    t.onTestFinished(unsubscribe);

    const update = updateSettings({ turnNotify: true, adminChannel: null });
    await Promise.resolve();
    delete process.env.TASK_DISPATCH_MAX_CONCURRENT;
    try {
      await update;
      assert.deepEqual(
        getSettingsSnapshot().find((entry) => entry.key === 'taskDispatchMaxConcurrent'),
        { key: 'taskDispatchMaxConcurrent', value: 8, source: 'env' },
        'snapshot values and provenance must use env captured at update start',
      );
    } finally {
      process.env.TASK_DISPATCH_MAX_CONCURRENT = '8';
    }
    assert.deepEqual(batches, [['turnNotify', 'adminChannel']]);

    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.turnNotify, true);
    assert.equal(parsed.showToolCalls, false, 'last valid explicit fields must be preserved');
    assert.equal(parsed.adminChannel, null);
    assert.match(raw, /\n$/);

    const siblings = await fs.readdir(CONFIG_DIR);
    assert.deepEqual(siblings.filter((name) => name.startsWith('settings.json.tmp.')), []);
    await fs.writeFile(SETTINGS_FILE, JSON.stringify({ ...parsed, showToolCalls: true }));
    await waitFor(() => batches.length === 2);
    assert.deepEqual(batches[1], ['showToolCalls']);
    assert.equal(getSettings().showToolCalls, true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(batches.length, 2, 'the atomic rename must not trigger a duplicate callback');
  });

  test('concurrent partial updates serialize without losing fields', async () => {
    await Promise.all([
      updateSettings({ turnNotify: false }),
      updateSettings({ showToolCalls: true }),
    ]);
    const parsed = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    assert.equal(parsed.turnNotify, false);
    assert.equal(parsed.showToolCalls, true);
  });

  test('deleting settings.json hot-reloads env and default fallbacks', async (t) => {
    const batches: string[][] = [];
    const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
    t.onTestFinished(unsubscribe);

    await fs.unlink(SETTINGS_FILE);
    await waitFor(() => getSettings().managerRotateSteps === 10);
    assert.equal(getSettings().showToolCalls, true);
    assert.deepEqual(getSettings().uiCorsOrigins, ['https://env.example']);
    assert.ok(batches.length >= 1);
  });

  test('a throwing subscriber does not block later settings subscribers', async (t) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const batches: string[][] = [];
    const unsubscribeThrowing = onSettingsChange(() => { throw new Error('subscriber failed'); });
    const unsubscribeRecording = onSettingsChange((keys) => batches.push([...keys]));
    t.onTestFinished(unsubscribeThrowing);
    t.onTestFinished(unsubscribeRecording);

    await updateSettings({ eventLog: false });
    assert.deepEqual(batches, [['eventLog']]);
    assert.match(errors.mock.calls.map((args) => args.join(' ')).join('\n'), /subscriber failed/);
  });

  test('onSettingsChange unsubscribe stops future notifications', async () => {
    const batches: string[][] = [];
    const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
    unsubscribe();
    await updateSettings({ managerRotateSteps: 8 });
    assert.deepEqual(batches, []);
  });
});
