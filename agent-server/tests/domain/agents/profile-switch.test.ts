import { test } from 'vitest';
import assert from 'node:assert/strict';
import { decideProfileSwitch } from '../../../src/domain/agents/profile-switch.js';

test('fresh session (no history) allows a same-backend switch', () => {
  const d = decideProfileSwitch({ currentBackend: 'claude', targetBackend: 'claude', hasHistory: false });
  assert.deepEqual(d, { allowed: true, backendChanged: false });
});

test('fresh session (no history) allows a cross-backend switch', () => {
  const d = decideProfileSwitch({ currentBackend: 'claude', targetBackend: 'codex', hasHistory: false });
  assert.deepEqual(d, { allowed: true, backendChanged: true });
});

test('live session (has history) allows a same-backend switch, no reset implied', () => {
  const d = decideProfileSwitch({ currentBackend: 'claude', targetBackend: 'claude', hasHistory: true });
  assert.deepEqual(d, { allowed: true, backendChanged: false });
});

test('live session (has history) BLOCKS a cross-backend switch', () => {
  const d = decideProfileSwitch({ currentBackend: 'claude', targetBackend: 'codex', hasHistory: true });
  assert.deepEqual(d, { allowed: false, reason: 'cross-backend-live-session' });
});

test('live session blocks pi→claude too (symmetric)', () => {
  const d = decideProfileSwitch({ currentBackend: 'pi', targetBackend: 'claude', hasHistory: true });
  assert.equal(d.allowed, false);
});

test('claude print↔tui counts as same backend (both backend=claude) on a live session', () => {
  // Both profiles resolve to backend 'claude' (claudeBackend is not part of the identity).
  const d = decideProfileSwitch({ currentBackend: 'claude', targetBackend: 'claude', hasHistory: true });
  assert.equal(d.allowed, true);
});
