import { test } from 'vitest';
import assert from 'node:assert/strict';

import { filterScopedPlugins } from '../src/domain/runs/engine-spec.js';

const BASE = '/home/u/.cortex/plugins';
const FEISHU = `${BASE}/cortex-feishu`;
const SYSTEM = `${BASE}/cortex-system`;
const COMMON = `${BASE}/cortex-common`;
const BOARD = `${BASE}/cortex-board`;

test('feishu channel keeps the cortex-feishu plugin', () => {
  const out = filterScopedPlugins([COMMON, SYSTEM, FEISHU], { channel: 'feishu:oc_abc123' });
  assert.deepEqual(out, [COMMON, SYSTEM, FEISHU]);
});

test('non-feishu channels strip cortex-feishu but keep the rest', () => {
  for (const channel of ['slack:C123', 'cli:local', '', undefined]) {
    const out = filterScopedPlugins([COMMON, SYSTEM, FEISHU], {
      channel: channel as string | undefined,
    });
    assert.deepEqual(out, [COMMON, SYSTEM], `channel=${JSON.stringify(channel)}`);
  }
});

test('basename match is exact — cortex-feishu-x is not stripped', () => {
  const FEISHU_X = `${BASE}/cortex-feishu-x`;
  const out = filterScopedPlugins([SYSTEM, FEISHU_X], { channel: 'slack:C1' });
  assert.deepEqual(out, [SYSTEM, FEISHU_X]);
});

test('trailing-slash plugin dir is still matched by basename', () => {
  const out = filterScopedPlugins([`${FEISHU}/`], { channel: 'slack:C1' });
  assert.deepEqual(out, []);
});

test('the board plugin is not scoped: every session keeps it', () => {
  for (const scope of [{}, { channel: 'web:abc' }, { channel: 'feishu:oc_x' }]) {
    const out = filterScopedPlugins([COMMON, SYSTEM, BOARD], scope);
    assert.deepEqual(out, [COMMON, SYSTEM, BOARD], `scope=${JSON.stringify(scope)}`);
  }
});
