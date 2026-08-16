// input:  startup environment and immutable trial marker
// output: managed startup asset sync admission decisions
// pos:    Guards sealed production homes from startup config mutation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { shouldSyncManagedStartupAssets } from '../../src/entry/startup-helpers.js';

test('sealed production config skips every managed startup mutation', () => {
  assert.equal(shouldSyncManagedStartupAssets({ CORTEX_CONFIG_IMMUTABLE: '1' }), false);
  assert.equal(shouldSyncManagedStartupAssets({ CORTEX_CONFIG_IMMUTABLE: '0' }), true);
  assert.equal(shouldSyncManagedStartupAssets({}), true);
});
