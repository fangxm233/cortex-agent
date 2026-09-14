import assert from 'node:assert/strict';
import { test } from 'vitest';

import { shouldSyncManagedStartupAssets } from '../../src/entry/startup-helpers.js';

test('sealed production config skips every managed startup mutation', () => {
  assert.equal(shouldSyncManagedStartupAssets({ CORTEX_CONFIG_IMMUTABLE: '1' }), false);
  assert.equal(shouldSyncManagedStartupAssets({ CORTEX_CONFIG_IMMUTABLE: '0' }), true);
  assert.equal(shouldSyncManagedStartupAssets({}), true);
});
