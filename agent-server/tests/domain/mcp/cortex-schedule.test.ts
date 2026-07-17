// input:  Node test runner + cortex_schedule_* MCP tool helpers
// output: target shorthand resolution + tool registration regression
// pos:    locks the __current__ shorthand → concrete ScheduleTarget mapping that
//         cortex_schedule_add applies at create time (decided 2026-04: resolve at create,
//         not at fire — so the persisted record always shows real IDs in list output).
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveTargetShorthand, type CortexContextSnapshot } from '../../../src/domain/mcp/tools/schedule.js';

const FULL_CTX: CortexContextSnapshot = {
  channel: 'C123',
  sessionId: 'sess-uuid-1',
  sessionName: 'cortex-abc111',
  threadId: 'thr_xyz999',
  profile: 'fast-worker',
  project: 'cortex-self',
  backend: 'claude',
  scheduleTaskId: null,
  callbackSource: null,
};

// --- shorthand strings ---

test('resolveTargetShorthand: undefined target → fresh', () => {
  const out = resolveTargetShorthand(undefined, FULL_CTX);
  assert.deepEqual(out, { kind: 'fresh' });
});

test('resolveTargetShorthand: "fresh" string → fresh', () => {
  const out = resolveTargetShorthand('fresh', FULL_CTX);
  assert.deepEqual(out, { kind: 'fresh' });
});

test('resolveTargetShorthand: "current-project" → resolved project', () => {
  const out = resolveTargetShorthand('current-project', FULL_CTX);
  assert.deepEqual(out, { kind: 'project', projectId: 'cortex-self' });
});

test('resolveTargetShorthand: "current-thread" → resolved thread', () => {
  const out = resolveTargetShorthand('current-thread', FULL_CTX);
  assert.deepEqual(out, { kind: 'thread', threadId: 'thr_xyz999', channel: 'C123' });
});

// --- shorthand error paths (context missing required fields) ---

test('resolveTargetShorthand: "current-project" without project → throws', () => {
  assert.throws(
    () => resolveTargetShorthand('current-project', { ...FULL_CTX, project: null }),
    /current-project.*project/i,
  );
});

test('resolveTargetShorthand: "current-thread" without threadId → throws (does not silently fall back to fresh)', () => {
  assert.throws(
    () => resolveTargetShorthand('current-thread', { ...FULL_CTX, threadId: null }),
    /current-thread.*thread/i,
  );
});

// --- object form passthrough + validation ---

test('resolveTargetShorthand: explicit { kind: "project", projectId } passes through', () => {
  const out = resolveTargetShorthand({ kind: 'project', projectId: 'my-project' } as any, FULL_CTX);
  assert.deepEqual(out, { kind: 'project', projectId: 'my-project' });
});

test('resolveTargetShorthand: explicit { kind: "thread", threadId, channel } passes through', () => {
  const out = resolveTargetShorthand({ kind: 'thread', threadId: 'thr_explicit', channel: 'C-other' }, FULL_CTX);
  assert.deepEqual(out, { kind: 'thread', threadId: 'thr_explicit', channel: 'C-other' });
});

test('resolveTargetShorthand: unknown shorthand string → throws', () => {
  assert.throws(
    () => resolveTargetShorthand('foo-bar' as any, FULL_CTX),
    /unknown target/i,
  );
});
