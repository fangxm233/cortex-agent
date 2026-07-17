// input:  Node test runner + facade _test.filterChannelScopedPlugins
// output: channel-scoped pluginDir filtering tests (cortex-feishu gated to feishu: channels)
// pos:    Verify cortex-feishu plugin loads only for Feishu-originated sessions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { _test } from '../src/domain/agents/index.js';

const { filterChannelScopedPlugins } = _test;

const BASE = '/home/u/.cortex/plugins';
const FEISHU = `${BASE}/cortex-feishu`;
const SYSTEM = `${BASE}/cortex-system`;
const COMMON = `${BASE}/cortex-common`;

test('feishu channel keeps the cortex-feishu plugin', () => {
  const out = filterChannelScopedPlugins([COMMON, SYSTEM, FEISHU], 'feishu:oc_abc123');
  assert.deepEqual(out, [COMMON, SYSTEM, FEISHU]);
});

test('non-feishu channels strip cortex-feishu but keep the rest', () => {
  for (const channel of ['slack:C123', 'cli:local', '', undefined]) {
    const out = filterChannelScopedPlugins([COMMON, SYSTEM, FEISHU], channel as string | undefined);
    assert.deepEqual(out, [COMMON, SYSTEM], `channel=${JSON.stringify(channel)}`);
  }
});

test('undefined pluginDirs passes through unchanged', () => {
  assert.equal(filterChannelScopedPlugins(undefined, 'feishu:oc_x'), undefined);
});

test('basename match is exact — cortex-feishu-x is not stripped', () => {
  const FEISHU_X = `${BASE}/cortex-feishu-x`;
  const out = filterChannelScopedPlugins([SYSTEM, FEISHU_X], 'slack:C1');
  assert.deepEqual(out, [SYSTEM, FEISHU_X]);
});

test('trailing-slash plugin dir is still matched by basename', () => {
  const out = filterChannelScopedPlugins([`${FEISHU}/`], 'slack:C1');
  assert.deepEqual(out, []);
});
