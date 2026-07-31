// input:  adapter factories, settings, and isolated env
// output: platform composition and settings reset regressions
// pos:    Verifies multi-platform adapter factory behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  createPrimaryAdaptersFromEnv,
  createAdapterFromEnv,
} from '../../src/platform/adapters/index.js';
import { CompositeAdapter } from '../../src/platform/adapters/composite-adapter.js';
import { resetSettingsForTests, updateSettings } from '../../src/core/settings.js';

vi.mock('@slack/bolt', () => ({
  App: class {
    client = {};
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

const ENV_KEYS = [
  'CORTEX_PLATFORM', 'CORTEX_TUI',
  'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN',
  'SLACK_ADMIN_CHANNEL', 'CORTEX_ADMIN_CHANNEL',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ADMIN_CHANNEL',
];

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

async function withFreshEnv(
  overrides: Record<string, string | undefined>,
  fn: (createPrimaries: typeof createPrimaryAdaptersFromEnv) => void,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetSettingsForTests();
    fn(createPrimaryAdaptersFromEnv);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    resetSettingsForTests();
  }
}

const SLACK = { SLACK_BOT_TOKEN: 'xoxb', SLACK_SIGNING_SECRET: 'sig', SLACK_APP_TOKEN: 'xapp' };
const FEISHU = { FEISHU_APP_ID: 'cli', FEISHU_APP_SECRET: 'secret' };

test('createPrimaryAdaptersFromEnv: single value (back-compat) → one adapter', () => {
  withEnv({ CORTEX_PLATFORM: 'slack', ...SLACK }, () => {
    const a = createPrimaryAdaptersFromEnv();
    assert.equal(a.length, 1);
    assert.equal(a[0].name, 'slack');
  });
});

test('createPrimaryAdaptersFromEnv: comma list → both adapters', () => {
  withEnv({ CORTEX_PLATFORM: 'slack,feishu', ...SLACK, ...FEISHU }, () => {
    const a = createPrimaryAdaptersFromEnv();
    assert.equal(a.length, 2);
    assert.deepEqual(a.map(x => x.name).sort(), ['feishu', 'slack']);
  });
});

test('createPrimaryAdaptersFromEnv: missing creds are skipped', () => {
  withEnv({ CORTEX_PLATFORM: 'slack,feishu', ...SLACK }, () => {
    const a = createPrimaryAdaptersFromEnv(); // no feishu creds
    assert.equal(a.length, 1);
    assert.equal(a[0].name, 'slack');
  });
});

test('createPrimaryAdaptersFromEnv: duplicates are de-duped', () => {
  withEnv({ CORTEX_PLATFORM: 'slack,slack', ...SLACK }, () => {
    assert.equal(createPrimaryAdaptersFromEnv().length, 1);
  });
});

test('createAdapterFromEnv: single primary, no TUI → returns it directly', () => {
  withEnv({ CORTEX_PLATFORM: 'slack', CORTEX_TUI: '0', ...SLACK }, () => {
    const a = createAdapterFromEnv();
    assert.equal(a.name, 'slack');
    assert.ok(!(a instanceof CompositeAdapter));
  });
});

test('createAdapterFromEnv: two primaries → CompositeAdapter', () => {
  withEnv({ CORTEX_PLATFORM: 'slack,feishu', CORTEX_TUI: '0', ...SLACK, ...FEISHU }, () => {
    const a = createAdapterFromEnv();
    assert.ok(a instanceof CompositeAdapter);
  });
});

test('createAdapterFromEnv: no platform and TUI disabled → throws', () => {
  withEnv({ CORTEX_PLATFORM: 'slack', CORTEX_TUI: '0' }, () => {
    assert.throws(() => createAdapterFromEnv(), /No platform configured/);
  });
});

test('admin channel env fallbacks preserve Slack, Feishu, and test priority chains', async () => {
  await withFreshEnv({
    CORTEX_PLATFORM: 'slack,feishu,test',
    ...SLACK,
    ...FEISHU,
    SLACK_ADMIN_CHANNEL: 'C_slack',
    CORTEX_ADMIN_CHANNEL: 'C_cortex',
    FEISHU_ADMIN_CHANNEL: 'oc_feishu',
  }, (createPrimaries) => {
    const adapters = createPrimaries() as any[];
    const slack = adapters.find((adapter) => adapter.name === 'slack');
    const feishu = adapters.find((adapter) => adapter.name === 'feishu');
    const mock = adapters.find((adapter) => adapter.name === 'mock');
    assert.equal(slack.config.adminChannel, 'C_slack');
    assert.equal(feishu.config.adminChannel, 'oc_feishu');
    assert.equal(mock._adminChannel, 'C_slack');
  });
});

test('admin channel env fallbacks reach legacy Slack alias independently', async () => {
  await withFreshEnv({
    CORTEX_PLATFORM: 'slack,feishu,test',
    ...SLACK,
    ...FEISHU,
    CORTEX_ADMIN_CHANNEL: 'C_legacy',
  }, (createPrimaries) => {
    const adapters = createPrimaries() as any[];
    const slack = adapters.find((adapter) => adapter.name === 'slack');
    const feishu = adapters.find((adapter) => adapter.name === 'feishu');
    const mock = adapters.find((adapter) => adapter.name === 'mock');
    assert.equal(slack.config.adminChannel, 'C_legacy');
    assert.equal(feishu.config.adminChannel, undefined, 'Feishu must not inherit a Slack channel');
    assert.equal(mock._adminChannel, 'C_legacy');
  });
});

test('admin channel env fallbacks terminate independently with no configured channel', async () => {
  await withFreshEnv({
    CORTEX_PLATFORM: 'slack,feishu,test',
    ...SLACK,
    ...FEISHU,
  }, (createPrimaries) => {
    const adapters = createPrimaries() as any[];
    const slack = adapters.find((adapter) => adapter.name === 'slack');
    const feishu = adapters.find((adapter) => adapter.name === 'feishu');
    const mock = adapters.find((adapter) => adapter.name === 'mock');
    assert.equal(slack.config.adminChannel, undefined);
    assert.equal(feishu.config.adminChannel, undefined);
    assert.equal(mock._adminChannel, null);
  });
});

test('settings admin channels override every env fallback without crossing platforms', async () => {
  await updateSettings({ adminChannel: 'C_settings', feishuAdminChannel: 'oc_settings' });
  await withFreshEnv({
    CORTEX_PLATFORM: 'slack,feishu,test',
    ...SLACK,
    ...FEISHU,
    SLACK_ADMIN_CHANNEL: 'C_slack',
    CORTEX_ADMIN_CHANNEL: 'C_cortex',
    FEISHU_ADMIN_CHANNEL: 'oc_env',
  }, (createPrimaries) => {
    const adapters = createPrimaries() as any[];
    const slack = adapters.find((adapter) => adapter.name === 'slack');
    const feishu = adapters.find((adapter) => adapter.name === 'feishu');
    const mock = adapters.find((adapter) => adapter.name === 'mock');
    assert.equal(slack.config.adminChannel, 'C_settings');
    assert.equal(feishu.config.adminChannel, 'oc_settings');
    assert.equal(mock._adminChannel, 'C_settings');
  });
});
