// input:  settings migration, isolated config files
// output: env-to-settings migration regression tests
// pos:    Specifies one-time legacy settings migration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { beforeEach, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from '../../src/core/paths.js';

const ENV_FILE = path.join(CONFIG_DIR, '.env');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const MIGRATION_COMMENT = '# Legacy server settings migrated to settings.json; secrets remain in .env.';

const legacyLines = [
  'CORTEX_TURN_NOTIFY=off',
  'CORTEX_TURN_NOTIFY_THRESHOLD_S=12.5',
  'CORTEX_NOTIFY_COMPACTION=1',
  'CORTEX_SHOW_TOOL_CALLS=yes',
  'CORTEX_STATUS_NEWQ_BUTTON=on',
  'CORTEX_AUTO_RESUME=false',
  'CORTEX_STREAM_DELTAS=0',
  'CORTEX_BG_CONTINUATION=no',
  'CORTEX_EVENT_LOG=off',
  'CORTEX_DISABLE_USER_CONTEXT=1',
  'CORTEX_SERVER_UPDATE_DISABLE=1',
  'CORTEX_HOOKS_LEGACY=1',
  'CORTEX_MANAGER_ROTATE_STEPS=12steps',
  'CORTEX_WAITING_SWEEP_MS=0',
  'CORTEX_INJECT_WAIT_MAX_S=2.5',
  'CORTEX_THREAD_MAX_DEPTH=7levels',
  'CORTEX_TASK_ARTIFACT_TEMPLATES="manager, coder-review, ,"',
  'TASK_DISPATCH_MAX_CONCURRENT=8workers',
  'CORTEX_UI_CORS_ORIGINS="https://a.example, https://b.example"',
  'CORTEX_ADMIN_CHANNEL=C123',
  'FEISHU_ADMIN_CHANNEL=oc_123',
];

const expectedSettings = {
  turnNotify: false,
  turnNotifyThresholdS: 12.5,
  notifyCompaction: true,
  showToolCalls: true,
  statusNewqButton: true,
  autoResume: false,
  streamDeltas: false,
  bgContinuation: false,
  eventLog: false,
  disableUserContext: true,
  serverUpdateDisable: true,
  hooksLegacy: true,
  managerRotateSteps: 12,
  waitingSweepMs: 0,
  injectWaitMaxS: 2.5,
  threadMaxDepth: 7,
  taskArtifactTemplates: ['manager', 'coder-review'],
  taskDispatchMaxConcurrent: 8,
  uiCorsOrigins: ['https://a.example', 'https://b.example'],
  adminChannel: 'C123',
  feishuAdminChannel: 'oc_123',
};

async function loadMigration(): Promise<() => Promise<void>> {
  const module = await import('../../src/core/settings-migration.js');
  return module.migrateEnvToSettings;
}

async function backupNames(): Promise<string[]> {
  const names = await fs.readdir(CONFIG_DIR);
  return names.filter((name) => name.startsWith('.env.bak-')).sort();
}

beforeEach(async () => {
  vi.resetModules();
  assert.ok(
    !path.resolve(CONFIG_DIR).startsWith(`${path.join(os.homedir(), '.cortex')}${path.sep}`),
    `test CONFIG_DIR must be isolated, got ${CONFIG_DIR}`,
  );
  await fs.rm(CONFIG_DIR, { recursive: true, force: true });
  await fs.mkdir(CONFIG_DIR, { recursive: true });
});

describe.sequential('migrateEnvToSettings', () => {
  test('migrates all 21 setting keys, strips legacy lines, preserves other lines, and is idempotent', async () => {
    const preserved = [
      '# existing comment',
      'ANTHROPIC_API_KEY=secret-value',
      '',
      'UNRELATED_SETTING="keep exactly"',
      '# tail comment',
      '',
    ].join('\n');
    const original = [
      '# existing comment',
      'ANTHROPIC_API_KEY=secret-value',
      ...legacyLines,
      'CORTEX_SERVER_UPDATE_ENABLE=1',
      '',
      'UNRELATED_SETTING="keep exactly"',
      '# tail comment',
      '',
    ].join('\n');
    await fs.writeFile(ENV_FILE, original);

    const migrate = await loadMigration();
    await migrate();

    assert.deepEqual(JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')), expectedSettings);
    assert.equal(await fs.readFile(ENV_FILE, 'utf8'), `${MIGRATION_COMMENT}\n${preserved}`);
    const backups = await backupNames();
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(CONFIG_DIR, backups[0]), 'utf8'), original);

    const oldTime = new Date('2001-02-03T04:05:06.000Z');
    await fs.utimes(ENV_FILE, oldTime, oldTime);
    await fs.utimes(SETTINGS_FILE, oldTime, oldTime);
    const envBefore = await fs.stat(ENV_FILE, { bigint: true });
    const settingsBefore = await fs.stat(SETTINGS_FILE, { bigint: true });

    await migrate();

    assert.deepEqual(await backupNames(), backups);
    assert.equal((await fs.stat(ENV_FILE, { bigint: true })).mtimeNs, envBefore.mtimeNs);
    assert.equal((await fs.stat(SETTINGS_FILE, { bigint: true })).mtimeNs, settingsBefore.mtimeNs);
  });

  test('does not overwrite explicit settings and preserves admin alias precedence', async () => {
    const existing = {
      showToolCalls: false,
      taskDispatchMaxConcurrent: null,
      uiCorsOrigins: [],
      unknownField: 'preserved',
    };
    await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(existing, null, 2)}\n`);
    await fs.writeFile(ENV_FILE, [
      'CORTEX_SHOW_TOOL_CALLS=1',
      'TASK_DISPATCH_MAX_CONCURRENT=9',
      'CORTEX_UI_CORS_ORIGINS=https://ignored.example',
      'SLACK_ADMIN_CHANNEL=slack-admin',
      'CORTEX_ADMIN_CHANNEL=cortex-admin',
      'FEISHU_ADMIN_CHANNEL=feishu-admin',
      'KEEP_ME=yes',
      '',
    ].join('\n'));

    const migrate = await loadMigration();
    await migrate();

    assert.deepEqual(JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')), {
      ...existing,
      adminChannel: 'slack-admin',
      feishuAdminChannel: 'feishu-admin',
    });
    assert.equal(await fs.readFile(ENV_FILE, 'utf8'), `${MIGRATION_COMMENT}\nKEEP_ME=yes\n`);
  });

  test('does nothing when only the dead non-SPEC key remains', async () => {
    const original = 'CORTEX_SERVER_UPDATE_ENABLE=1\nKEEP_ME=yes\n';
    await fs.writeFile(ENV_FILE, original);
    const before = await fs.stat(ENV_FILE, { bigint: true });

    const migrate = await loadMigration();
    await migrate();

    assert.equal(await fs.readFile(ENV_FILE, 'utf8'), original);
    assert.equal((await fs.stat(ENV_FILE, { bigint: true })).mtimeNs, before.mtimeNs);
    assert.deepEqual(await backupNames(), []);
    await assert.rejects(fs.access(SETTINGS_FILE));
  });

  test('does not fail or create files when .env is absent', async () => {
    const migrate = await loadMigration();

    await migrate();

    assert.deepEqual(await fs.readdir(CONFIG_DIR), []);
  });
});
