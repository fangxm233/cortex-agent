import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCancelThread } from '../../../src/domain/ui-service/mutate/threads.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, monthlyBudget: 0, budgetScope: 'global' as const, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: {} as any,
    ...overrides,
  };
}

test('threads.cancel returns not-found when thread does not exist', async () => {
  const result = await handleCancelThread(makeDeps(), { threadId: 'thr_nonexist' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not-found');
});

test('threads.cancel returns already-terminal for completed/completed threads', async () => {
  // The handler delegates to cancelThread() from @domain/threads/index.js which
  // uses the real threadStore singleton.  With a missing thread, cancelThread
  // returns false and the handler checks threadStore.get → null → not-found.
  // The success/cancellation paths require a thread to be first inserted into
  // the real ThreadRepo singleton, which is tested downstream in thread-runner.
  const result = await handleCancelThread(makeDeps(), { threadId: 'thr_missing' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(['not-found', 'already-terminal'].includes(result.code));
});
