import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseApprovals,
  handleApprovalsList,
} from '../../../src/domain/ui-service/query/approvals.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

// A representative PENDING_APPROVALS.md with a preamble + 4 entries covering every status,
// a missing-field entry, and a reject with parenthetical feedback.
const SAMPLE = `# Pending Approvals

> This file tracks operations that require user approval before execution.
> Use \`/approval\` to review.

## 2026-03-01 Alpha: promote a rule
- **Operation**: Move K to rules
- **Reason**: it is a validated behavior rule
- **Impact**: adds a rule section
- **Command/Action**: Edit CLAUDE.md
- **Status**: pending

## 2026-03-02 Beta: bump idle timeout
- **Operation**: Increase IDLE_TIMEOUT to 15m
- **Reason**: scans fail on slow WebFetch
- **Impact**: modifies one constant
- **Command/Action**: Edit bridge line 16
- **Status**: approved — executed 2026-03-02 (per user)

## 2026-03-06 Gamma: submit upstream issue
- **Operation**: Submit the bug report
- **Reason**: investigation complete
- **Status**: rejected 2026-03-02 (misdiagnosis, scan actually succeeded)

## 2026-03-11 Delta: failed thing
- **Operation**: do the thing
- **Reason**: because
- **Impact**: some impact
- **Command/Action**: run it
- **Status**: failed
`;

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
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, monthlyBudget: 0, budgetScope: 'global' as const, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: {} as any,
  };
}

function writeTemp(content: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cortex-appr-'));
  const p = path.join(dir, 'PENDING_APPROVALS.md');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ── (1) parse: multi-entry, order, headings, statuses ────────────────────────
test('parseApprovals parses every entry with title/queuedAt/status', () => {
  const all = parseApprovals(SAMPLE);
  assert.equal(all.length, 4);

  const [a, b, g, d] = all;
  assert.equal(a.title, 'Alpha: promote a rule');
  assert.equal(a.queuedAt, '2026-03-01');
  assert.equal(a.status, 'pending');
  assert.equal(a.operation, 'Move K to rules');
  assert.equal(a.reason, 'it is a validated behavior rule');
  assert.equal(a.impact, 'adds a rule section');
  assert.equal(a.command, 'Edit CLAUDE.md');

  assert.equal(b.status, 'approved');
  assert.equal(b.decidedAt, '2026-03-02');

  assert.equal(g.status, 'rejected');
  assert.equal(g.decidedAt, '2026-03-02');
  assert.equal(g.feedback, 'misdiagnosis, scan actually succeeded');

  assert.equal(d.status, 'failed');
});

// ── (2) missing fields → null ────────────────────────────────────────────────
test('parseApprovals sets missing bullet fields to null', () => {
  const [, , gamma] = parseApprovals(SAMPLE);
  // Gamma has no Impact / Command-Action bullets.
  assert.equal(gamma.impact, null);
  assert.equal(gamma.command, null);
  assert.equal(gamma.operation, 'Submit the bug report');
});

// ── (3) status filter ────────────────────────────────────────────────────────
test('parseApprovals filters by status', () => {
  const pending = parseApprovals(SAMPLE, 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, 'Alpha: promote a rule');

  const rejected = parseApprovals(SAMPLE, 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].status, 'rejected');
});

// ── (4) stable ids ───────────────────────────────────────────────────────────
test('parseApprovals assigns stable, distinct ids', () => {
  const first = parseApprovals(SAMPLE).map((e) => e.id);
  const second = parseApprovals(SAMPLE).map((e) => e.id);
  assert.deepEqual(first, second); // stable across reads
  assert.equal(new Set(first).size, first.length); // distinct
  assert.ok(first.every((id) => /^[0-9a-f]{8}$/.test(id)));
});

// ── (4b) provenance + taskRef (§12 C item 13): real-when-present, honest null else ──
// The canonical writer (need-approval skill) and the approval-gate builder BOTH emit only
// Operation/Reason/Impact/Command/Status — NO origin/task/ttl structured field. The only real
// carrier of "who raised this" + a task ref is the OPTIONAL freeform `Provenance` bullet some
// entries add. We parse it verbatim (provenance) + extract a 4-hex task ref (taskRef, reusing the
// memory.ts parseTaskRef semantics) — real when present, honest null when absent. TTL has ZERO
// source anywhere in the queue → never a fabricated field.
const PROV_SAMPLE = `# Pending Approvals

## 2026-07-10 Atlas: run a thing
- **Operation**: do the thing
- **Reason**: needed
- **Impact**: some files
- **Command/Action**: run it
- **Status**: pending
- **Provenance**: Cortex executor thread thr_42a1b744 (task 89dd), 2026-07-10

## 2026-07-10 Nimbus: manager-raised
- **Operation**: other thing
- **Status**: pending
- **Provenance**: manager c2a3 raised this after review

## 2026-07-10 Orchard: no provenance
- **Operation**: bare thing
- **Status**: pending
`;

test('parseApprovals captures a verbatim Provenance bullet + parses its task ref', () => {
  const [a, b, c] = parseApprovals(PROV_SAMPLE);

  // (a) thread + explicit `task <4hex>` → verbatim provenance + parsed taskRef.
  assert.equal(a.provenance, 'Cortex executor thread thr_42a1b744 (task 89dd), 2026-07-10');
  assert.equal(a.taskRef, '89dd');

  // (b) `manager <4hex>` keyword → taskRef parsed from the manager anchor (parseTaskRef semantics).
  assert.equal(b.provenance, 'manager c2a3 raised this after review');
  assert.equal(b.taskRef, 'c2a3');

  // (c) no Provenance bullet → honest null for BOTH (never fabricated).
  assert.equal(c.provenance, null);
  assert.equal(c.taskRef, null);
});

// ── (4c) project attribution: `- **Project**:` bullet → projectId, honest null else ──
// Entries raised inside a project carry a `Project` bullet (need-approval skill template); legacy
// and system-level entries have none → projectId null, rendered as "global" by the UI.
const PROJECT_SAMPLE = `# Pending Approvals

## 2026-07-30 Nimbus: scoped op
- **Operation**: change a config
- **Reason**: needed
- **Impact**: one file
- **Command/Action**: edit it
- **Project**: nimbus
- **Status**: pending

## 2026-07-30 Legacy: unscoped op
- **Operation**: old entry
- **Status**: pending
`;

test('parseApprovals parses a Project bullet into projectId, null when absent', () => {
  const [scoped, legacy] = parseApprovals(PROJECT_SAMPLE);
  assert.equal(scoped.projectId, 'nimbus');
  assert.equal(legacy.projectId, null);
});

test('parseApprovals sets projectId null across a Project-free file', () => {
  for (const e of parseApprovals(SAMPLE)) {
    assert.equal(e.projectId, null);
  }
});

test('parseApprovals never fabricates a ttl/expiry field (zero-source)', () => {
  // TTL is the prototype amber "expires in …" slot; the markdown queue has no expiry concept at all.
  // Guard: the DTO must not carry a fabricated ttl value.
  for (const e of parseApprovals(PROV_SAMPLE)) {
    assert.equal((e as unknown as Record<string, unknown>).ttl, undefined);
  }
});

// ── (5) missing file → [] ────────────────────────────────────────────────────
test('handleApprovalsList returns [] when the file is missing', async () => {
  const deps = makeDeps(path.join(os.tmpdir(), 'does-not-exist-approvals.md'));
  const list = await handleApprovalsList(deps, {});
  assert.deepEqual(list, []);
});

// ── (6) facade + tRPC wiring ─────────────────────────────────────────────────
test('approvals.list reachable via the ui-service facade', async () => {
  const deps = makeDeps(writeTemp(SAMPLE));
  const ui = createUiService(deps);
  const res = await ui.query('approvals.list', {});
  assert.ok(res.ok);
  assert.equal(res.data.length, 4);

  const filtered = await ui.query('approvals.list', { status: 'approved' });
  assert.ok(filtered.ok);
  assert.equal(filtered.data.length, 1);
  assert.equal(filtered.data[0].status, 'approved');
});

// The tRPC router binding is covered in the ui-http app-router test (tests/platform/ui-http-app-router.test.ts);
// here we assert the facade's pending-status filter (distinct from the approved filter above).
test('approvals.list via facade honors the pending-status filter', async () => {
  const deps = makeDeps(writeTemp(SAMPLE));
  const ui = createUiService(deps);
  const list = await ui.query('approvals.list', {});
  assert.ok(list.ok);
  assert.equal(list.data.length, 4);
  const pending = await ui.query('approvals.list', { status: 'pending' });
  assert.ok(pending.ok);
  assert.equal(pending.data.length, 1);
});
