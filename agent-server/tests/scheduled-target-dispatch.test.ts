// input:  Node test runner + planScheduledDispatch (pure planner)
// output: fresh / project / thread target dispatch + fallback policy regression
// pos:    locks the dispatch decision tree extracted from scheduled-task.ts so the
//         orchestration around it (Slack / executions / progress) stays untouched.
//         M4: channel target removed, project target added. Later: session target removed
//         (along with the default-thread path) — user messages are no longer threads.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { planScheduledDispatch, type DispatchPlan } from '../src/domain/scheduling/jobs/target-dispatch.js';
import type { ScheduleTarget } from '../src/store/schedule-repo.js';

function lookups(overrides: Partial<Parameters<typeof planScheduledDispatch>[0]['lookups']> = {}) {
  return {
    getThread: () => null,
    ...overrides,
  };
}

// --- target=fresh ---

test('plan: target=fresh always returns { kind: "fresh" }', async () => {
  const plan = await planScheduledDispatch({
    target: { kind: 'fresh' },
    fallback: 'fresh',
    fallbackChannel: 'C1',
    lookups: lookups(),
  });
  assert.deepEqual(plan, { kind: 'fresh', channel: 'C1' });
});

test('plan: undefined target falls back to fresh', async () => {
  const plan = await planScheduledDispatch({
    target: undefined,
    fallback: undefined,
    fallbackChannel: 'C1',
    lookups: lookups(),
  });
  assert.deepEqual(plan, { kind: 'fresh', channel: 'C1' });
});

// --- target=project ---

test('plan: target=project always returns { kind: "fresh" } on fallbackChannel', async () => {
  const plan = await planScheduledDispatch({
    target: { kind: 'project', projectId: 'cortex-self' },
    fallback: 'fresh',
    fallbackChannel: 'C1',
    lookups: lookups(),
  });
  assert.deepEqual(plan, { kind: 'fresh', channel: 'C1' });
});

// --- target=thread ---

test('plan: target=thread running → continue-thread', async () => {
  const plan = await planScheduledDispatch({
    target: { kind: 'thread', threadId: 'thr_live', channel: 'CT' },
    fallback: 'fresh',
    fallbackChannel: 'C1',
    lookups: lookups({
      getThread: (id) => id === 'thr_live' ? { id: 'thr_live', channel: 'CT', status: 'running' } as any : null,
    }),
  });
  assert.deepEqual(plan, { kind: 'continue-thread', channel: 'CT', threadId: 'thr_live' });
});

test('plan: target=thread waiting → continue-thread', async () => {
  const plan = await planScheduledDispatch({
    target: { kind: 'thread', threadId: 'thr_wait', channel: 'CT' },
    fallback: 'fresh',
    fallbackChannel: 'C1',
    lookups: lookups({
      getThread: () => ({ id: 'thr_wait', channel: 'CT', status: 'waiting' } as any),
    }),
  });
  assert.equal(plan.kind, 'continue-thread');
});

test('plan: target=thread terminal status + fallback=skip → skip', async () => {
  const plan = await planScheduledDispatch({
    target: { kind: 'thread', threadId: 'thr_done', channel: 'CT' },
    fallback: 'skip',
    fallbackChannel: 'C1',
    lookups: lookups({
      getThread: () => ({ id: 'thr_done', channel: 'CT', status: 'completed' } as any),
    }),
  });
  assert.equal(plan.kind, 'skip');
  assert.match((plan as { reason: string }).reason, /thread/i);
});

test('plan: target=thread missing + default fallback (undefined) → fresh on fallback channel', async () => {
  const plan = await planScheduledDispatch({
    target: { kind: 'thread', threadId: 'thr_404', channel: 'CT' },
    fallback: undefined,
    fallbackChannel: 'C1',
    lookups: lookups({ getThread: () => null }),
  });
  assert.deepEqual(plan, { kind: 'fresh', channel: 'C1' });
});
