// input:  Vitest, commissions query/mutate handlers, tmp project dirs
// output: commissions.list/get/decisions and commissions.close regressions
// pos:    Tests the commission board's ui-service surface (DR-0037)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleCommissionsList,
  handleCommissionsGet,
  handleCommissionsDecisions,
  foldDecisionLines,
} from '../../../src/domain/ui-service/query/commissions.js';
import { handleCommissionClose } from '../../../src/domain/ui-service/mutate/commissions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { CommissionRecord } from '../../../src/store/commission-repo.js';

const T0 = Date.UTC(2026, 7, 28, 10, 0, 0);

function record(overrides: Partial<CommissionRecord> = {}): CommissionRecord {
  return {
    id: 'c1', projectId: 'proj1', slug: 'ship-it', title: 'Ship It',
    status: 'active', createdAt: T0, updatedAt: T0, ...overrides,
  };
}

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({} as any),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: { getProjectConduits: async () => ({}) } as any,
    ...overrides,
  };
}

function storeOf(records: CommissionRecord[]): NonNullable<UiServiceDeps['commissionStore']> {
  return {
    list: async (projectId?: string) => records.filter((r) => !projectId || r.projectId === projectId),
    find: async (id: string) => records.find((r) => r.id === id) ?? null,
    update: async (id: string, fn: (r: CommissionRecord) => void) => {
      const r = records.find((x) => x.id === id);
      if (!r) return null;
      fn(r);
      r.updatedAt = Date.now();
      return r;
    },
  };
}

test('commissions.list filters by project/status and maps epoch ms to ISO', async () => {
  const records = [record(), record({ id: 'c2', slug: 'other', projectId: 'proj2' }),
    record({ id: 'c3', slug: 'done-one', status: 'done', closedAt: T0 + 1000, closeNote: 'ok' })];
  const deps = makeDeps({ commissionStore: storeOf(records) });
  const all = await handleCommissionsList(deps, {});
  assert.equal(all.length, 3);
  const proj1 = await handleCommissionsList(deps, { projectId: 'proj1' });
  assert.deepEqual(proj1.map((c) => c.id), ['c1', 'c3']);
  const done = await handleCommissionsList(deps, { status: 'done' });
  assert.equal(done.length, 1);
  assert.equal(done[0].createdAt, new Date(T0).toISOString());
  assert.equal(done[0].closedAt, new Date(T0 + 1000).toISOString());
  assert.equal(done[0].closeNote, 'ok');
  assert.equal(proj1[0].closedAt, null);   // honest null, not fabricated
});

test('commissions.get returns the DTO and throws not-found for unknown ids', async () => {
  const deps = makeDeps({ commissionStore: storeOf([record()]) });
  const got = await handleCommissionsGet(deps, { commissionId: 'c1' });
  assert.equal(got.slug, 'ship-it');
  await assert.rejects(
    handleCommissionsGet(deps, { commissionId: 'nope' }),
    (e: any) => e.code === 'not-found',
  );
});

test('foldDecisionLines merges action lines into items and skips garbage', () => {
  const lines = [
    JSON.stringify({ v: 1, kind: 'decision', ts: 't1', sessionId: 's1', items: [{ id: 'd1', title: 'T', decision: 'D', context: 'C', reasoning: 'R' }] }),
    'not json at all',
    JSON.stringify({ v: 1, kind: 'action', ts: 't2', sessionId: 's1', decisionId: 'd1', action: 'revise', message: 'again' }),
    JSON.stringify({ v: 1, kind: 'action', ts: 't3', sessionId: 's1', decisionId: 'unknown', action: 'approve' }),
    JSON.stringify({ v: 1, kind: 'action', ts: 't4', sessionId: 's1', decisionId: 'd1', action: 'bogus-kind' }),
  ].join('\n');
  const entries = foldDecisionLines(lines);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, 's1');
  assert.deepEqual(entries[0].item.actions, [{ action: 'revise', message: 'again', ts: 't2' }]);
});

test('commissions.decisions reads the real projection file under the project root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-comm-ui-'));
  t.onTestFinished(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const dir = path.join(root, 'commissions', 'ship-it');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'),
    JSON.stringify({ v: 1, kind: 'decision', ts: 't1', sessionId: 's1', items: [{ id: 'd1', title: 'T', decision: 'D', context: 'C', reasoning: 'R' }] }) + '\n');
  const deps = makeDeps({
    commissionStore: storeOf([record()]),
    projectStore: { list: () => [], get: (id: string) => (id === 'proj1' ? { id: 'proj1', name: 'p', kind: 'general', contextDir: root } as any : undefined), exists: () => true, getDefault: () => ({} as any), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
  });
  const entries = await handleCommissionsDecisions(deps, { commissionId: 'c1' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].item.id, 'd1');

  // Missing projection file → empty stream, not an error.
  fs.unlinkSync(path.join(dir, 'decisions.jsonl'));
  assert.deepEqual(await handleCommissionsDecisions(deps, { commissionId: 'c1' }), []);
});

test('commissions.close sets status/closedAt/note, publishes, and guards re-close', async () => {
  const records = [record()];
  const published: any[] = [];
  const deps = makeDeps({
    commissionStore: storeOf(records),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: (e: any) => { published.push(e); } } as any,
  });
  const closed = await handleCommissionClose(deps, { commissionId: 'c1', status: 'done', note: 'shipped' });
  assert.ok(closed.ok);
  assert.equal((closed as any).data.status, 'done');
  assert.equal((closed as any).data.closeNote, 'shipped');
  assert.ok((closed as any).data.closedAt);
  assert.deepEqual(published, [{ type: 'commission.updated', commissionId: 'c1', projectId: 'proj1' }]);

  const again = await handleCommissionClose(deps, { commissionId: 'c1', status: 'abandoned' });
  assert.ok(!again.ok && (again as any).code === 'already-terminal');
  const missing = await handleCommissionClose(deps, { commissionId: 'zz', status: 'done' });
  assert.ok(!missing.ok && (missing as any).code === 'not-found');
});
