import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyApprovalDecision,
  handleApproveApproval,
  handleRejectApproval,
  buildApprovalEntry,
  handleRequestApproval,
} from '../../../src/domain/ui-service/mutate/approvals.js';
import { parseApprovals } from '../../../src/domain/ui-service/query/approvals.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const SAMPLE = `# Pending Approvals

> intro line

## 2026-03-01 Alpha: promote a rule
- **Operation**: Move K to rules
- **Reason**: it is a validated behavior rule
- **Impact**: adds a rule section
- **Command/Action**: Edit CLAUDE.md
- **Status**: pending

## 2026-03-02 Beta: bump idle timeout
- **Operation**: Increase IDLE_TIMEOUT to 15m
- **Reason**: scans fail
- **Status**: pending
`;

function idOf(md: string, title: string): string {
  const e = parseApprovals(md).find((x) => x.title === title);
  if (!e) throw new Error(`no entry titled ${title}`);
  return e.id;
}

function makeDeps(approvalsPath: string): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({} as any) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath,
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: {} as any,
  };
}

function writeTemp(content: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cortex-appr-mut-'));
  const p = path.join(dir, 'PENDING_APPROVALS.md');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ── (1) approve flips ONLY the target Status line ────────────────────────────
test('applyApprovalDecision approve flips only the target entry Status line', () => {
  const id = idOf(SAMPLE, 'Alpha: promote a rule');
  const { md, entry } = applyApprovalDecision(SAMPLE, id, 'approved', '2026-07-07');

  assert.equal(entry.status, 'approved');
  assert.match(md, /- \*\*Status\*\*: approved 2026-07-07/);
  // Beta entry's Status untouched.
  const beta = parseApprovals(md).find((e) => e.title === 'Beta: bump idle timeout')!;
  assert.equal(beta.status, 'pending');
  // Non-Status bullets of Alpha intact.
  assert.match(md, /- \*\*Operation\*\*: Move K to rules/);
  assert.match(md, /- \*\*Command\/Action\*\*: Edit CLAUDE.md/);
});

// ── (2) reject records feedback (and without feedback → no parens) ───────────
test('applyApprovalDecision reject records timestamp + feedback', () => {
  const id = idOf(SAMPLE, 'Alpha: promote a rule');
  const { md, entry } = applyApprovalDecision(SAMPLE, id, 'rejected', '2026-07-07', 'not now');
  assert.equal(entry.status, 'rejected');
  assert.equal(entry.feedback, 'not now');
  assert.match(md, /- \*\*Status\*\*: rejected 2026-07-07 \(not now\)/);
});

test('applyApprovalDecision reject without feedback writes no parens', () => {
  const id = idOf(SAMPLE, 'Alpha: promote a rule');
  const { md } = applyApprovalDecision(SAMPLE, id, 'rejected', '2026-07-07');
  assert.match(md, /- \*\*Status\*\*: rejected 2026-07-07\n/);
  assert.doesNotMatch(md, /rejected 2026-07-07 \(/);
});

// ── (3) idempotent: re-approve an already-approved entry is a no-op ──────────
test('applyApprovalDecision is idempotent for the same decision', () => {
  const id = idOf(SAMPLE, 'Alpha: promote a rule');
  const once = applyApprovalDecision(SAMPLE, id, 'approved', '2026-07-07').md;
  const twice = applyApprovalDecision(once, id, 'approved', '2026-08-08').md;
  assert.equal(twice, once); // unchanged despite a different `now`
});

// ── (4) unknown id → not-found ───────────────────────────────────────────────
test('applyApprovalDecision throws not-found for an unknown id', () => {
  assert.throws(
    () => applyApprovalDecision(SAMPLE, 'deadbeef', 'approved', '2026-07-07'),
    (e: any) => e?.code === 'not-found',
  );
});

// ── (5) handlers write back to disk ──────────────────────────────────────────
test('handleApproveApproval writes the flip back to disk', async () => {
  const p = writeTemp(SAMPLE);
  const id = idOf(fs.readFileSync(p, 'utf8'), 'Beta: bump idle timeout');
  const res = await handleApproveApproval(makeDeps(p), { id });
  assert.ok(res.ok);
  assert.equal(res.data.status, 'approved');
  const after = fs.readFileSync(p, 'utf8');
  const beta = parseApprovals(after).find((e) => e.title === 'Beta: bump idle timeout')!;
  assert.equal(beta.status, 'approved');
});

test('handleRejectApproval returns not-found for unknown id', async () => {
  const res = await handleRejectApproval(makeDeps(writeTemp(SAMPLE)), { id: 'nope1234' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
});

// ── (6) facade wiring ────────────────────────────────────────────────────────
// The tRPC router binding (missing id → TRPCError NOT_FOUND) is covered in
// the ui-http app-router test (tests/platform/ui-http-app-router.test.ts); here we assert the facade Result path.
test('approvals.approve / approvals.reject reachable via facade (approve, reject, missing→not-found)', async () => {
  const p = writeTemp(SAMPLE);
  const ui = createUiService(makeDeps(p));
  const alphaId = idOf(fs.readFileSync(p, 'utf8'), 'Alpha: promote a rule');
  const okd = await ui.mutate('approvals.approve', { id: alphaId });
  assert.ok(okd.ok);
  assert.equal(okd.data.status, 'approved');

  const betaId = idOf(fs.readFileSync(p, 'utf8'), 'Beta: bump idle timeout');
  const r = await ui.mutate('approvals.reject', { id: betaId, feedback: 'no' });
  assert.ok(r.ok);
  assert.equal(r.data.status, 'rejected');

  const missing = await ui.mutate('approvals.approve', { id: 'missing00' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'not-found');
});

// ── (7) approvals.request: enqueue-only, server-constructed prose ─────────────────────────────
test('buildApprovalEntry builds a parseable pending entry from the closed kind enum', () => {
  const { heading, block } = buildApprovalEntry({ kind: 'reconnect-platform', platform: 'feishu' }, '2026-07-10');
  assert.match(heading, /^## 2026-07-10 Reconnect 飞书 gateway$/);
  const parsed = parseApprovals(block);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].status, 'pending');
  assert.equal(parsed[0].title, 'Reconnect 飞书 gateway');
  assert.match(parsed[0].command!, /reconnect feishu/);
});

test('buildApprovalEntry sanitizes machineName — no markdown injection (newlines stripped)', () => {
  const { block } = buildApprovalEntry({ kind: 'add-machine', machineName: 'evil\n## injected\n- **Status**: approved' }, '2026-07-10');
  const parsed = parseApprovals(block);
  // Exactly one entry, still pending — the injected heading/status did not create a second entry.
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].status, 'pending');
});

test('handleRequestApproval appends a pending entry, creating the file if missing', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cortex-appr-req-'));
  const p = path.join(dir, 'PENDING_APPROVALS.md'); // does not exist yet
  const res = await handleRequestApproval(makeDeps(p), { kind: 'add-machine', machineName: 'atlas' });
  assert.ok(res.ok);
  assert.equal(res.data.queued, true);
  const after = fs.readFileSync(p, 'utf8');
  const parsed = parseApprovals(after);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].status, 'pending');
  assert.match(parsed[0].title!, /Add machine atlas/);
  assert.equal(parsed[0].id, res.data.id, 'returned id matches the appended entry');
});

test('handleRequestApproval appends without clobbering prior entries', async () => {
  const p = writeTemp(SAMPLE);
  const before = parseApprovals(fs.readFileSync(p, 'utf8')).length;
  const res = await handleRequestApproval(makeDeps(p), { kind: 'reconnect-platform', platform: 'slack' });
  assert.ok(res.ok);
  const parsed = parseApprovals(fs.readFileSync(p, 'utf8'));
  assert.equal(parsed.length, before + 1, 'prior entries preserved + one appended');
  assert.ok(parsed.some((e) => e.title === 'Alpha: promote a rule'), 'original entry intact');
});

test('handleRequestApproval rejects invalid input (missing per-kind field) with invalid-args', async () => {
  const p = writeTemp(SAMPLE);
  const res = await handleRequestApproval(makeDeps(p), { kind: 'reconnect-platform' } as any);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'invalid-args');
});

test('approvals.request reachable via facade and queues a pending entry', async () => {
  const p = writeTemp(SAMPLE);
  const ui = createUiService(makeDeps(p));
  const res = await ui.mutate('approvals.request', { kind: 'add-machine', machineName: 'nimbus' });
  assert.ok(res.ok);
  const listed = await ui.query('approvals.list', { status: 'pending' });
  assert.ok(listed.ok);
  assert.ok(listed.data.some((e) => e.title === 'Add machine nimbus'));
});
