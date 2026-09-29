import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveTargetShorthand } from '../../../src/domain/mcp/tools/schedule.js';
import type { CortexContextInternal } from '../../../src/domain/mcp/tools/context.js';

const FULL_CTX: CortexContextInternal = {
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

test('resolveTargetShorthand: unknown shorthand string → throws', () => {
  assert.throws(
    () => resolveTargetShorthand('foo-bar' as any, FULL_CTX),
    /unknown target/i,
  );
});
