import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSchedulesList } from '../../../src/domain/ui-service/query/schedules.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const mockSchedules = [
  { id: 'sch1', type: 'interval' as const, message: 'Check health', projectId: 'proj1', profile: 'claude-haiku', nextRun: Date.now() + 60000, lastRun: Date.now() - 300000, isPaused: false },
  { id: 'sch2', type: 'daily' as const, message: 'Daily report', projectId: 'proj1', profile: 'claude-sonnet', time: '09:00', nextRun: Date.now() + 3600000, lastRun: Date.now() - 86400000, isPaused: false },
  // sch3 has no profile (legacy record) → must map to null, not a fabricated default.
  { id: 'sch3', type: 'weekly' as const, message: 'Weekly review', projectId: 'proj2', dayOfWeek: 1, time: '10:00', nextRun: Date.now() + 7200000, lastRun: null, isPaused: true, pausedBy: 'user' },
];

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { list: async () => mockSchedules as any, get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: { getProjectConduits: async () => ({}) } as any,
    ...overrides,
  };
}

test('schedules.list returns all schedules when no filter', async () => {
  const result = await handleSchedulesList(makeDeps(), {});
  assert.equal(result.length, 3);
});

test('schedules.list filters by projectId', async () => {
  const result = await handleSchedulesList(makeDeps(), { projectId: 'proj1' });
  assert.equal(result.length, 2);
  assert.ok(result.every(s => s.projectId === 'proj1'));
});

test('schedules.list filters by paused', async () => {
  const result = await handleSchedulesList(makeDeps(), { paused: true });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'sch3');
  assert.equal(result[0].paused, true);
});

test('schedules.list active schedules (paused: false)', async () => {
  const result = await handleSchedulesList(makeDeps(), { paused: false });
  assert.equal(result.length, 2);
  assert.ok(result.every(s => s.paused === false));
});

test('schedules.list nextRun/lastRun are ISO strings', async () => {
  const result = await handleSchedulesList(makeDeps(), {});
  for (const s of result) {
    if (s.nextRun) assert.ok(s.nextRun.endsWith('Z') || s.nextRun.includes('T'), `nextRun should be ISO: ${s.nextRun}`);
    if (s.lastRun) assert.ok(s.lastRun.endsWith('Z') || s.lastRun.includes('T'), `lastRun should be ISO: ${s.lastRun}`);
  }
});

test('schedules.list paused schedule has pausedBy', async () => {
  const result = await handleSchedulesList(makeDeps(), { paused: true });
  assert.equal(result[0].pausedBy, 'user');
});

test('schedules.list carries the real profile from the schedule config source', async () => {
  const result = await handleSchedulesList(makeDeps(), { projectId: 'proj1' });
  const byId = Object.fromEntries(result.map((s) => [s.id, s]));
  assert.equal(byId['sch1'].profile, 'claude-haiku');
  assert.equal(byId['sch2'].profile, 'claude-sonnet');
});

test('schedules.list maps a schedule without a profile to null (honest placeholder)', async () => {
  const result = await handleSchedulesList(makeDeps(), { projectId: 'proj2' });
  assert.equal(result[0].id, 'sch3');
  assert.equal(result[0].profile, null);
});
