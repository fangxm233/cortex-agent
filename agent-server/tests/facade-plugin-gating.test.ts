// input:  Node test runner + facade _test.filterScopedPlugins / filterChannelScopedPlugins
// output: scoped pluginDir filtering tests (cortex-feishu by channel, cortex-commission by mode)
// pos:    Verify scoped plugins load only for the sessions they belong to
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { _test } from '../src/domain/agents/index.js';

const { filterChannelScopedPlugins, filterScopedPlugins } = _test;

const BASE = '/home/u/.cortex/plugins';
const FEISHU = `${BASE}/cortex-feishu`;
const SYSTEM = `${BASE}/cortex-system`;
const COMMON = `${BASE}/cortex-common`;
const COMMISSION = `${BASE}/cortex-commission`;

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

test('commission mode keeps the cortex-commission plugin', () => {
  const out = filterScopedPlugins([COMMON, SYSTEM, COMMISSION], { commissionMode: true });
  assert.deepEqual(out, [COMMON, SYSTEM, COMMISSION]);
});

test('an ordinary session never sees the commission skill', () => {
  // The skill is a long prescriptive procedure; loading it everywhere would put it in front of
  // every session, which is exactly what making commission a mode is meant to avoid.
  for (const scope of [{}, { commissionMode: false }, { channel: 'feishu:oc_x' }]) {
    const out = filterScopedPlugins([COMMON, SYSTEM, COMMISSION], scope);
    assert.deepEqual(out, [COMMON, SYSTEM], `scope=${JSON.stringify(scope)}`);
  }
});

test('the two scopes are independent', () => {
  const out = filterScopedPlugins([FEISHU, COMMISSION], {
    channel: 'feishu:oc_x', commissionMode: true,
  });
  assert.deepEqual(out, [FEISHU, COMMISSION]);
});

test('the channel-only wrapper still strips the commission plugin', () => {
  assert.deepEqual(filterChannelScopedPlugins([SYSTEM, COMMISSION], 'feishu:oc_x'), [SYSTEM]);
});
