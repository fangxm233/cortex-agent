import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveTargetShorthand } from '../../../src/domain/mcp/tools/schedule.js';
import type { CortexContextInternal } from '../../../src/domain/mcp/tools/context.js';

const FULL_CTX: CortexContextInternal = {
  channel: 'C123',
  sessionId: 'sess-uuid-1',
  sessionName: 'cortex-abc111',
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

test('resolveTargetShorthand: "fresh" and an absent target → fresh', () => {
  assert.deepEqual(resolveTargetShorthand('fresh', FULL_CTX), { kind: 'fresh' });
  assert.deepEqual(resolveTargetShorthand(undefined, FULL_CTX), { kind: 'fresh' });
});

// --- shorthand error paths (context missing required fields) ---

test('resolveTargetShorthand: "current-project" without project → throws', () => {
  assert.throws(
    () => resolveTargetShorthand('current-project', { ...FULL_CTX, project: null }),
    /current-project.*project/i,
  );
});

test('resolveTargetShorthand: the retired thread target is refused at create time', () => {
  assert.throws(() => resolveTargetShorthand('current-thread' as any, FULL_CTX), /unknown target/i);
  assert.throws(
    () => resolveTargetShorthand({ kind: 'thread', threadId: 'thr_xyz999', channel: 'C123' } as any, FULL_CTX),
    /unknown target/i,
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
