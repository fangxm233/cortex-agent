import { test } from 'vitest';
import assert from 'node:assert/strict';

import { isBgContinuationEnabled, isInteractiveChannel, isWebChannel, shouldHoldForBg, shouldHoldWebForBg } from '../../src/orchestration/background-hold-gates.js';
import { resetSettingsForTests } from '../../src/core/settings.js';


test('isBgContinuationEnabled: default ON, opt-out via CORTEX_BG_CONTINUATION=0/false', async () => {
  const prev = process.env.CORTEX_BG_CONTINUATION;
  try {
    delete process.env.CORTEX_BG_CONTINUATION;
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), true, 'enabled by default when unset');
    process.env.CORTEX_BG_CONTINUATION = '0';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), false, 'disabled by "0"');
    process.env.CORTEX_BG_CONTINUATION = 'false';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), false, 'disabled by "false"');
    process.env.CORTEX_BG_CONTINUATION = 'off';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), false, 'disabled by "off"');
    process.env.CORTEX_BG_CONTINUATION = '1';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), true, 'explicitly enabled');
    process.env.CORTEX_BG_CONTINUATION = 'true';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), true);
    process.env.CORTEX_BG_CONTINUATION = '';
    resetSettingsForTests();
    assert.equal(isBgContinuationEnabled(), true, 'empty string is not an opt-out');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_BG_CONTINUATION;
    else process.env.CORTEX_BG_CONTINUATION = prev;
    resetSettingsForTests();
  }
});

test('shouldHoldForBg: hold gates — remaining count, rate limit, channel scope, sink capability, feature flag', async () => {
  const prev = process.env.CORTEX_BG_CONTINUATION;
  try {
    delete process.env.CORTEX_BG_CONTINUATION;
    resetSettingsForTests();
    const base = { pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0, rateLimited: false };
    assert.equal(shouldHoldForBg(base as any, 'slack:D1', true), true, 'running task holds');
    assert.equal(shouldHoldForBg({ ...base, pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 } as any, 'slack:D1', true), true, 'undelivered completion holds (grace watchdog upstream)');
    assert.equal(shouldHoldForBg({ ...base, pendingBackgroundTasks: 0 } as any, 'slack:D1', true), false, 'nothing remaining → no hold');
    assert.equal(shouldHoldForBg({ ...base, rateLimited: true } as any, 'slack:D1', true), false, 'rate-limited turn never holds');
    assert.equal(shouldHoldForBg(base as any, 'thread-abc', true), false, 'non-interactive channel never holds');
    assert.equal(shouldHoldForBg(base as any, 'slack:D1', false), false, 'no sink capability → no hold');
    assert.equal(shouldHoldForBg(null, 'slack:D1', true), false, 'null result → no hold');
    process.env.CORTEX_BG_CONTINUATION = '0';
    resetSettingsForTests();
    assert.equal(shouldHoldForBg(base as any, 'slack:D1', true), false, 'feature flag off → no hold');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_BG_CONTINUATION;
    else process.env.CORTEX_BG_CONTINUATION = prev;
    resetSettingsForTests();
  }
});

test('isInteractiveChannel: only slack/feishu interactive conduits, not thread/dispatch/web', () => {
  assert.equal(isInteractiveChannel('slack:D123'), true);
  assert.equal(isInteractiveChannel('feishu:oc_abc'), true);
  assert.equal(isInteractiveChannel('thread-abc123'), false);
  assert.equal(isInteractiveChannel('dispatch:task-1'), false);
  assert.equal(isInteractiveChannel('web:cortex-abcd'), false, 'web is NOT slack/feishu — held separately');
  assert.equal(isInteractiveChannel(''), false);
});

test('isWebChannel: only the web: conduit', () => {
  assert.equal(isWebChannel('web:cortex-abcd'), true);
  assert.equal(isWebChannel('slack:D123'), false);
  assert.equal(isWebChannel('feishu:oc_abc'), false);
  assert.equal(isWebChannel('thread-abc123'), false);
  assert.equal(isWebChannel(''), false);
});

test('shouldHoldWebForBg: hold gates mirror shouldHoldForBg but scoped to web:', async () => {
  const prev = process.env.CORTEX_BG_CONTINUATION;
  try {
    delete process.env.CORTEX_BG_CONTINUATION;
    resetSettingsForTests();
    const base = { pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0, rateLimited: false };
    assert.equal(shouldHoldWebForBg(base as any, 'web:cortex-abcd', true), true, 'running task on web holds');
    assert.equal(shouldHoldWebForBg({ ...base, pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 } as any, 'web:cortex-abcd', true), true, 'undelivered completion holds');
    assert.equal(shouldHoldWebForBg({ ...base, pendingBackgroundTasks: 0 } as any, 'web:cortex-abcd', true), false, 'nothing remaining → no hold');
    assert.equal(shouldHoldWebForBg({ ...base, rateLimited: true } as any, 'web:cortex-abcd', true), false, 'rate-limited turn never holds');
    assert.equal(shouldHoldWebForBg(base as any, 'slack:D1', true), false, 'slack channel is NOT the web hold');
    assert.equal(shouldHoldWebForBg(base as any, 'web:cortex-abcd', false), false, 'no sink capability → no hold');
    assert.equal(shouldHoldWebForBg(null, 'web:cortex-abcd', true), false, 'null result → no hold');
    process.env.CORTEX_BG_CONTINUATION = '0';
    resetSettingsForTests();
    assert.equal(shouldHoldWebForBg(base as any, 'web:cortex-abcd', true), false, 'feature flag off → no hold');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_BG_CONTINUATION;
    else process.env.CORTEX_BG_CONTINUATION = prev;
    resetSettingsForTests();
  }
});

