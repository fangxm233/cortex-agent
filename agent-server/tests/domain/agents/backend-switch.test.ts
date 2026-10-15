import { test } from 'vitest';
import assert from 'node:assert/strict';
import { decideBackendSwitch } from '../../../src/domain/agents/model-selection.js';

test('fresh session (no history) allows a cross-backend switch', () => {
  const d = decideBackendSwitch({ currentBackend: 'claude', targetBackend: 'pi', hasHistory: false });
  assert.deepEqual(d, { allowed: true, backendChanged: true });
});

test('live session (has history) allows a same-backend switch, no reset implied', () => {
  const d = decideBackendSwitch({ currentBackend: 'claude', targetBackend: 'claude', hasHistory: true });
  assert.deepEqual(d, { allowed: true, backendChanged: false });
});

test('live session (has history) BLOCKS a cross-backend switch', () => {
  const d = decideBackendSwitch({ currentBackend: 'claude', targetBackend: 'pi', hasHistory: true });
  assert.deepEqual(d, { allowed: false, reason: 'cross-backend-live-session' });
});
