import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../../src/core/paths.js';
import { SETTINGS_SPEC, type SettingSpecEntry } from '../../src/core/settings-spec.js';
import {
  getSettings,
  getSettingsSnapshot,
  onSettingsChange,
  resolveSettingsSnapshot,
  setProviderRateLimitPolicy,
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
  'CORTEX_DISK_MONITOR',
  'CORTEX_DISABLE_USER_CONTEXT',
  'CORTEX_SERVER_UPDATE_DISABLE',
  'CORTEX_HOOKS_LEGACY',
  'CORTEX_WAITPOINT_SWEEP_MS',
  'CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR',
  'CORTEX_INJECT_WAIT_MAX_S',
  'CORTEX_PI_COMPACT_RESERVE_TOKENS',
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
  process.env.FEISHU_ADMIN_CHANNEL = 'oc_env';
  process.env.CORTEX_UI_CORS_ORIGINS = 'https://env.example';
  process.env.SLACK_ADMIN_CHANNEL = 'slack-admin';
  process.env.CORTEX_ADMIN_CHANNEL = 'cortex-admin';
  await fs.writeFile(SETTINGS_FILE, JSON.stringify({
    turnNotify: true,
    turnNotifyThresholdS: 0,
    feishuAdminChannel: null,
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

describe.sequential('core settings', () => {
  test('all declared legacy parsers preserve their distinct historical semantics', () => {
    const cases: Array<[keyof typeof SETTINGS_SPEC, string, unknown]> = [
      ['turnNotify', ' OFF ', false],
      ['turnNotify', '', true],
      ['turnNotifyThresholdS', '12.5', 12.5],
      ['turnNotifyThresholdS', '0', 60],
      ['turnNotifyThresholdS', 'bad', 60],
      ['notifyCompaction', '1', true],
      ['notifyCompaction', 'true', true],
      ['notifyCompaction', ' OFF ', false],
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
      ['diskMonitor', ' OFF ', false],
      ['diskMonitor', '', true],
      ['disableUserContext', '1', true],
      ['disableUserContext', 'true', false],
      ['serverUpdateDisable', '1', true],
      ['serverUpdateDisable', 'on', false],
      ['waitpointMaxWakesPerHour', '20wakes', 20],
      ['waitpointMaxWakesPerHour', '-1', 12],
      ['waitpointMaxWakesPerHour', 'bad', 12],
      ['waitpointSweepMs', '250ms', 250],
      ['waitpointSweepMs', '0', 0],
      ['waitpointSweepMs', '-2', -2],
      ['waitpointSweepMs', 'bad', 30_000],
      ['injectWaitMaxS', '2.5', 2.5],
      ['injectWaitMaxS', '', 0],
      ['injectWaitMaxS', 'bad', Number.NaN],
      ['uiCorsOrigins', ' https://a.example, ,https://b.example ', ['https://a.example', 'https://b.example']],
      ['uiCorsOrigins', '', []],
      ['adminChannel', 'C123', 'C123'],
      ['adminChannel', '', null],
      ['feishuAdminChannel', 'oc_123', 'oc_123'],
      ['feishuAdminChannel', '', null],
    ];

    for (const [key, raw, expected] of cases) {
      const parser = (SETTINGS_SPEC[key] as SettingSpecEntry<unknown>).legacyParse!;
      assert.deepEqual(parser(raw), expected, `${key}(${JSON.stringify(raw)})`);
    }
  });

  test('getSettings resolves file before env before defaults and logs env deprecations', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settings = getSettings();

    assert.equal(settings.turnNotify, true, 'explicit file true must beat env false');
    assert.equal(settings.turnNotifyThresholdS, 0, 'explicit file 0 must beat env');
    assert.equal(settings.showToolCalls, true, 'absent file key must use env');
    assert.equal(settings.waitpointMaxWakesPerHour, 12, 'absent file/env key must use default');
    assert.equal(settings.feishuAdminChannel, null, 'explicit file null must beat env');
    assert.deepEqual(settings.uiCorsOrigins, [], 'explicit file [] must beat env');
    assert.equal(settings.adminChannel, 'slack-admin', 'Slack legacy alias must have first priority');
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
      snapshot.find((entry) => entry.key === 'waitpointMaxWakesPerHour'),
      { key: 'waitpointMaxWakesPerHour', value: 12, source: 'default' },
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
      waitpointMaxWakesPerHour: 7,
      anthropicSubscriptionModes: [],
      uiCorsOrigins: ['https://file.example'],
    }));

    await waitFor(() => batches.length === 1);
    assert.deepEqual(batches[0], [
      'turnNotify',
      'showToolCalls',
      'waitpointMaxWakesPerHour',
      'anthropicSubscriptionModes',
      'uiCorsOrigins',
      'feishuAdminChannel',
    ]);
    assert.equal(getSettings().feishuAdminChannel, 'oc_env', 'removed file key must reveal env fallback');
    assert.deepEqual(getSettings().anthropicSubscriptionModes, []);
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

  test('providerRateLimits defaults to an empty map and validates exact nested window policies', () => {
    assert.deepEqual(getSettings().providerRateLimits, {});
    assert.doesNotThrow(() => resolveSettingsSnapshot({
      providerRateLimits: {
        'openai-codex': {
          windows: [{ type: 'codex_primary', enabled: false, threshold: 0.91 }],
        },
        anthropic: {
          enabled: true,
          windows: [
            { type: 'five_hour', enabled: false },
            { type: 'model_scoped', label: 'Sonnet', enabled: true, threshold: 0.75 },
          ],
        },
      },
    }));
    assert.throws(() => resolveSettingsSnapshot({
      providerRateLimits: { '   ': { enabled: true } },
    }));
    assert.throws(() => resolveSettingsSnapshot({
      providerRateLimits: { __proto__: { enabled: true } },
    }));
    assert.throws(() => resolveSettingsSnapshot({
      providerRateLimits: { constructor: { enabled: true } },
    }));
    assert.throws(() => resolveSettingsSnapshot({
      providerRateLimits: { prototype: { enabled: true } },
    }));
    assert.throws(() => resolveSettingsSnapshot({
      providerRateLimits: { 'openai-codex': { threshold: 0.8 } },
    }));
    assert.throws(() => resolveSettingsSnapshot({
      providerRateLimits: { 'openai-codex': { enabled: true, threshold: 0 } },
    }));
    assert.throws(() => resolveSettingsSnapshot({
      providerRateLimits: { 'openai-codex': { enabled: true, threshold: 1.01 } },
    }));
    assert.throws(() => resolveSettingsSnapshot({
      providerRateLimits: {
        anthropic: {
          windows: [
            { type: 'model_scoped', label: 'Sonnet', enabled: true },
            { type: 'model_scoped', label: 'Sonnet', enabled: false },
          ],
        },
      },
    }));
    assert.throws(() => resolveSettingsSnapshot({
      providerRateLimits: { 'openai-codex': { enabled: true, extra: 1 } },
    }));
  });

  test('built-in job intervals enforce integer Node timer bounds', () => {
    const valid = {
      providerUsageCollectionIntervalMs: 1_000,
      memoryIndexRegenIntervalMs: 2_147_483_647,
    };
    assert.doesNotThrow(() => resolveSettingsSnapshot(valid));
    for (const value of [999, 1_000.5, 2_147_483_648]) {
      assert.throws(() => resolveSettingsSnapshot({ memoryIndexRegenIntervalMs: value }));
    }
  });

  test('a settings file still carrying retired keys parses, and the keys are ignored', () => {
    const snapshot = resolveSettingsSnapshot({
      taskDispatchEnabled: false,
      taskDispatchMaxConcurrent: 'not-a-number',
      taskArchiveIntervalMs: 1,
      managerRotateSteps: 7,
      threadMaxDepth: 3,
      taskArtifactTemplates: ['manager'],
      dispatchReconcilerEnabled: false,
      waitingSweepMs: 0,
      turnNotify: false,
    });
    const keys = snapshot.map((entry) => entry.key as string);
    for (const retired of ['taskDispatchEnabled', 'managerRotateSteps', 'threadMaxDepth', 'waitingSweepMs']) {
      assert.equal(keys.includes(retired), false, retired);
    }
    assert.deepEqual(snapshot.find((entry) => entry.key === 'turnNotify'), { key: 'turnNotify', value: false, source: 'file' });
  });

  test('sessionRetentionDays defaults to 90 and enforces safe integer day bounds', () => {
    assert.equal(resolveSettingsSnapshot({}).find((entry) => entry.key === 'sessionRetentionDays')?.value, 90);
    const maxDays = Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000);
    assert.doesNotThrow(() => resolveSettingsSnapshot({ sessionRetentionDays: 1 }));
    assert.doesNotThrow(() => resolveSettingsSnapshot({ sessionRetentionDays: maxDays }));
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, maxDays + 1]) {
      assert.throws(() => resolveSettingsSnapshot({ sessionRetentionDays: value }));
    }
  });

  test('piCompactReserveTokens defaults to PI\'s own 16384 and accepts only in-range whole tokens', () => {
    for (const value of [1_024, 16_384, 32_768, 131_072]) {
      assert.doesNotThrow(() => resolveSettingsSnapshot({ piCompactReserveTokens: value }));
    }
    for (const value of [0, -1, 1_023, 16_384.5, 131_073]) {
      assert.throws(() => resolveSettingsSnapshot({ piCompactReserveTokens: value }));
    }
  });

  test('maxContextTokens defaults to null and accepts null or whole tokens within Claude\'s range', () => {
    assert.equal(resolveSettingsSnapshot({}).find((entry) => entry.key === 'maxContextTokens')?.value, null);
    for (const value of [null, 100_000, 450_000, 1_000_000]) {
      assert.doesNotThrow(() => resolveSettingsSnapshot({ maxContextTokens: value }));
    }
    for (const value of [0, 99_999, 200_000.5, 1_000_001]) {
      assert.throws(() => resolveSettingsSnapshot({ maxContextTokens: value }));
    }
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
    await updateSettings({ waitpointMaxWakesPerHour: 9 });

    const parsed = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    assert.deepEqual(parsed.futureSetting, { enabled: true });
    assert.deepEqual(parsed.uiCorsOrigins, ['https://external.example']);
    assert.equal(parsed.waitpointMaxWakesPerHour, 9);
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
    await updateSettings({ waitpointMaxWakesPerHour: 14 });

    const messages = errors.mock.calls.map((args) => args.join(' ')).join('\n');
    assert.match(messages, /Update settings\.json read failed/);
    assert.match(messages, /using previous settings/);
    assert.deepEqual(
      JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')),
      { ...cached, waitpointMaxWakesPerHour: 14 },
    );
  });

  test('updateSettings is atomic, has no watcher echo, and does not mask a following external edit', async (t) => {
    const batches: string[][] = [];
    const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
    t.onTestFinished(unsubscribe);

    const update = updateSettings({ turnNotify: true, adminChannel: null });
    await Promise.resolve();
    delete process.env.FEISHU_ADMIN_CHANNEL;
    try {
      await update;
      assert.deepEqual(
        getSettingsSnapshot().find((entry) => entry.key === 'feishuAdminChannel'),
        { key: 'feishuAdminChannel', value: 'oc_env', source: 'env' },
        'snapshot values and provenance must use env captured at update start',
      );
    } finally {
      process.env.FEISHU_ADMIN_CHANNEL = 'oc_env';
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

  test('unchanged providerRateLimits does not appear in change batches for unrelated writes', async (t) => {
    const batches: string[][] = [];
    const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
    t.onTestFinished(unsubscribe);

    await updateSettings({ providerRateLimits: { 'openai-codex': { enabled: false, threshold: 0.91 } } });
    batches.length = 0;
    await updateSettings({ waitpointMaxWakesPerHour: getSettings().waitpointMaxWakesPerHour + 1 });

    assert.deepEqual(batches, [['waitpointMaxWakesPerHour']]);
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

  test('setProviderRateLimitPolicy preserves concurrent window patches and unrelated settings', async () => {
    await updateSettings({
      eventLog: false,
      providerRateLimits: { anthropic: { windows: [{ type: 'five_hour', enabled: false }] } },
    });

    await Promise.all([
      setProviderRateLimitPolicy({ provider: 'anthropic', windowType: 'model_scoped', windowLabel: 'Sonnet', enabled: false, threshold: 0.75 }),
      setProviderRateLimitPolicy({ provider: 'openai-codex', windowType: 'codex_primary', enabled: false, threshold: null }),
    ]);

    const parsed = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    assert.equal(parsed.eventLog, false);
    assert.deepEqual(parsed.providerRateLimits, {
      anthropic: {
        windows: [
          { type: 'five_hour', enabled: false },
          { type: 'model_scoped', label: 'Sonnet', enabled: false, threshold: 0.75 },
        ],
      },
      'openai-codex': { windows: [{ type: 'codex_primary', enabled: false }] },
    });
  });

  test('setProviderRateLimitPolicy serializes same-window writes and preserves sibling labels', async () => {
    await updateSettings({
      providerRateLimits: {
        anthropic: {
          windows: [
            { type: 'model_scoped', label: 'Haiku', enabled: false },
            { type: 'model_scoped', label: 'Sonnet', enabled: false, threshold: 0.91 },
          ],
        },
      },
    });

    const first = setProviderRateLimitPolicy({ provider: 'anthropic', windowType: 'model_scoped', windowLabel: 'Sonnet', enabled: false, threshold: 0.88 });
    const second = setProviderRateLimitPolicy({ provider: 'anthropic', windowType: 'model_scoped', windowLabel: 'Sonnet', enabled: true, threshold: null });
    const [, committed] = await Promise.all([first, second]);

    assert.deepEqual(committed, {
      provider: 'anthropic',
      windowType: 'model_scoped',
      windowLabel: 'Sonnet',
      enabled: true,
      threshold: null,
    });
    assert.deepEqual(JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')).providerRateLimits, {
      anthropic: {
        windows: [{ type: 'model_scoped', label: 'Haiku', enabled: false }],
      },
    });
  });

  test('setProviderRateLimitPolicy clears a legacy provider fallback without deleting window overrides', async () => {
    await updateSettings({
      providerRateLimits: {
        anthropic: {
          enabled: false,
          threshold: 0.92,
          windows: [{ type: 'five_hour', enabled: false, threshold: 0.8 }],
        },
      },
    });

    const committed = await setProviderRateLimitPolicy({ provider: 'anthropic', enabled: true, threshold: null });

    assert.deepEqual(committed, { provider: 'anthropic', enabled: true, threshold: null });
    assert.deepEqual(JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')).providerRateLimits, {
      anthropic: {
        windows: [{ type: 'five_hour', enabled: false, threshold: 0.8 }],
      },
    });
  });

  test('resetting one window masks a non-default legacy provider fallback', async () => {
    await updateSettings({
      providerRateLimits: { anthropic: { enabled: false, threshold: 0.82 } },
    });

    await setProviderRateLimitPolicy({
      provider: 'anthropic', windowType: 'seven_day', enabled: true, threshold: null,
    });

    assert.deepEqual(JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')).providerRateLimits, {
      anthropic: {
        enabled: false,
        threshold: 0.82,
        windows: [{ type: 'seven_day', enabled: true }],
      },
    });
  });

  test('deleting settings.json hot-reloads env and default fallbacks', async (t) => {
    const batches: string[][] = [];
    const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
    t.onTestFinished(unsubscribe);

    await fs.unlink(SETTINGS_FILE);
    await waitFor(() => getSettings().waitpointMaxWakesPerHour === 12);
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
    await updateSettings({ waitpointMaxWakesPerHour: 8 });
    assert.deepEqual(batches, []);
  });
});
