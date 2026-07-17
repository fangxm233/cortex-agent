// input:  Node test runner + createPrimaryAdaptersFromEnv / createAdapterFromEnv
// output: Verify CORTEX_PLATFORM comma-list parsing and N-primary + TUI composition
// pos:    Multi-platform factory tests (Slack + Feishu coexistence)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  createPrimaryAdaptersFromEnv,
  createAdapterFromEnv,
} from '../../src/platform/adapters/index.js';
import { CompositeAdapter } from '../../src/platform/adapters/composite-adapter.js';

const ENV_KEYS = [
  'CORTEX_PLATFORM', 'CORTEX_TUI',
  'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET',
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
