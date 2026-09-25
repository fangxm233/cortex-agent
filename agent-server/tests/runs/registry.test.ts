// input:  core/run-registry.ts (the live-executions index)
// output: the lookup rules sessions.list / mid-turn injection / Stop depend on
//
// T2.1 split this file: background holds moved to tests/core/session-holds.test.ts, the busy
// join (`sessionState`) to tests/core/session-state.test.ts, and the streaming slot to
// tests/orch/active-turns.test.ts — following the code out of RunRegistry. Assertions unchanged.
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { RunRegistry } from '../../src/core/run-registry.js';
import type { RunningExecutionInput } from '../../src/core/run-registry.js';

function makeInput(overrides: Partial<RunningExecutionInput> = {}): RunningExecutionInput {
  return {
    threadId: null,
    channel: 'web:s1',
    agentSlotId: null,
    executionId: 'exec-1',
    kind: null,
    kill: () => true,
    backend: 'claude',
    trackSessionId: 's1',
    ...overrides,
  };
}

// ── the foreground lookup sessionState joins on ────────────────────────

test('getForegroundBySessionId: nothing registered → null', () => {
  const r = new RunRegistry();
  assert.equal(r.getForegroundBySessionId('s1'), null);
});

test('getForegroundBySessionId: a thread execution does not count as the session\'s own turn', () => {
  const r = new RunRegistry();
  r.register(makeInput({ executionId: 'exec-thread', threadId: 'thr_1', trackSessionId: 's1' }));

  // The registry owns this rule: a thread step runs beside its parent on the same channel, and
  // sessions.list joins on sessionState rather than re-deriving it.
  assert.equal(r.getForegroundBySessionId('s1'), null);
});

test('getForegroundBySessionId: also matches a run known only by its backend session id, and picks the newest', () => {
  const r = new RunRegistry();
  r.register(makeInput({ executionId: 'exec-old', trackSessionId: null, backendSessionId: 's1' }));
  r.register(makeInput({ executionId: 'exec-new', trackSessionId: 's1' }));
  r.setNumTurns('exec-new', 7);

  assert.equal(r.getForegroundBySessionId('s1')?.executionId, 'exec-new');
  assert.equal(r.getForegroundBySessionId('s1')?.numTurns, 7);
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
