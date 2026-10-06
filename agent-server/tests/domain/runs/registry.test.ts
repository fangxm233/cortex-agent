// RunRegistry only. Background holds: tests/core/session-holds.test.ts; the busy join
// (`sessionState`): tests/core/session-state.test.ts; the streaming slot:
// tests/orchestration/active-turns.test.ts.
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { RunRegistry } from '../../../src/core/run-registry.js';
import type { RunningExecutionInput } from '../../../src/core/run-registry.js';

function makeInput(overrides: Partial<RunningExecutionInput> = {}): RunningExecutionInput {
  return {
    channel: 'web:s1',
    executionId: 'exec-1',
    kind: null,
    kill: () => true,
    backend: 'claude',
    trackSessionId: 's1',
    ...overrides,
  };
}

// ── the session lookup sessionState joins on ───────────────────────────

test('getBySessionId: nothing registered → null', () => {
  const r = new RunRegistry();
  assert.equal(r.getBySessionId('s1'), null);
});

test('getBySessionId: also matches a run known only by its backend session id, and picks the newest', () => {
  const r = new RunRegistry();
  r.register(makeInput({ executionId: 'exec-old', trackSessionId: null, backendSessionId: 's1' }));
  r.register(makeInput({ executionId: 'exec-new', trackSessionId: 's1' }));
  r.setNumTurns('exec-new', 7);

  assert.equal(r.getBySessionId('s1')?.executionId, 'exec-new');
  assert.equal(r.getBySessionId('s1')?.numTurns, 7);
});

// ── P1.8 run lookup for mid-turn injection ─────────────────────────────

test('getRunByChannel returns the newest live run and skips run-less executions', () => {
  const r = new RunRegistry();
  const older = { steer: async () => 'refused' as const, respondToDialog: () => false };
  const newer = { steer: async () => 'folded' as const, respondToDialog: () => false };
  r.register(makeInput({ executionId: 'exec-1', channel: 'web:s1' }));
  r.register(makeInput({ executionId: 'exec-2', channel: 'web:s1', run: older }));
  r.register(makeInput({ executionId: 'exec-3', channel: 'web:s1', run: newer }));

  assert.equal(r.getRunByChannel('web:s1'), newer);
  assert.equal(r.getRunByChannel('web:none'), null);
});

test('getOwnByChannel leaves out subagent children riding on the channel', () => {
  const r = new RunRegistry();
  r.register(makeInput({ executionId: 'exec-parent' }));
  r.register(makeInput({ executionId: 'exec-child', trackSessionId: null, subagent: true }));

  assert.deepEqual(r.getByChannel('web:s1').map((e) => e.executionId), ['exec-parent', 'exec-child']);
  assert.deepEqual(r.getOwnByChannel('web:s1').map((e) => e.executionId), ['exec-parent']);

  r.remove('exec-parent');
  assert.deepEqual(r.getOwnByChannel('web:s1'), [], 'only a child left ⇒ the channel is idle');
});
