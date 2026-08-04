import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseIssues,
  issueLineId,
  handleIssuesList,
} from '../../../src/domain/ui-service/query/issues.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

// A representative ISSUES.md mirroring the real-world shapes (cortex-self / flywheel):
// H1 + preamble + `---` rule, canonical entries, multi-date parens, freeform sub-bullet labels,
// an entry with no parseable date, and blank lines between entries.
const SAMPLE = `# demo ISSUES

记录执行摩擦。resolved 直接删除。

---

- **task-block 拦不住已派发在途执行** (2026-07-02)
  - 问题：\`cortex-task block\` 只改 YAML，不终止 in-flight thread。
  - 建议：先 stop 再 block。

- **daemon restart 残留未修** (2026-07-04, 更新 07-10)
  - 未修 B：postinstall 每次 touch .restart。
  - 未修 C：busy count ≠ executions registry。
    多行续行内容。

- **无日期条目** (持续更新)
  - 问题：paren 无日期。
`;

function makeDeps(contextDir: string | null): UiServiceDeps {
  return {
    projectStore: {
      list: () => [],
      get: (id: string) =>
        contextDir && id === 'demo'
          ? ({ id: 'demo', name: 'demo', kind: 'research' as const, contextDir } as any)
          : undefined,
      exists: () => false,
      getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }),
      createProject: () => ({} as any),
    },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/nonexistent/PENDING_APPROVALS.md',
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

function writeTempContext(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cortex-issues-'));
  if (content != null) fs.writeFileSync(path.join(dir, 'ISSUES.md'), content, 'utf8');
  return dir;
}

// ── (1) parse: entries, titles, dates ────────────────────────────────────────
test('parseIssues parses every top-level bullet entry with title/date/body', () => {
  const all = parseIssues(SAMPLE);
  assert.equal(all.length, 3);
  assert.equal(all[0].title, 'task-block 拦不住已派发在途执行');
  assert.equal(all[0].date, '2026-07-02');
  assert.match(all[0].body, /问题：`cortex-task block`/);
  assert.match(all[0].body, /建议：先 stop 再 block。/);
  // multi-date paren → first date wins
  assert.equal(all[1].title, 'daemon restart 残留未修');
  assert.equal(all[1].date, '2026-07-04');
  // continuation lines belong to the body
  assert.match(all[1].body, /多行续行内容。/);
  // no parseable date → honest null
  assert.equal(all[2].title, '无日期条目');
  assert.equal(all[2].date, null);
});

test('parseIssues skips the H1 / preamble / --- rule and never emits them as entries', () => {
  const all = parseIssues(SAMPLE);
  for (const e of all) {
    assert.ok(!e.title.includes('ISSUES'));
    assert.ok(!e.body.includes('---'));
  }
});

test('parseIssues on empty / heading-only markdown returns []', () => {
  assert.deepEqual(parseIssues(''), []);
  assert.deepEqual(parseIssues('# Only a heading\n\nsome prose\n'), []);
});

// ── (2) stable ids ───────────────────────────────────────────────────────────
test('issue ids are stable hashes of the title line and unique per entry', () => {
  const all = parseIssues(SAMPLE);
  const again = parseIssues(SAMPLE);
  assert.deepEqual(all.map((e) => e.id), again.map((e) => e.id));
  assert.equal(new Set(all.map((e) => e.id)).size, all.length);
  assert.equal(all[0].id, issueLineId('- **task-block 拦不住已派发在途执行** (2026-07-02)'));
  for (const e of all) assert.match(e.id, /^[0-9a-f]{8}$/);
});

// ── (3) list handler ─────────────────────────────────────────────────────────
test('handleIssuesList reads <contextDir>/ISSUES.md for the project', async () => {
  const dir = writeTempContext(SAMPLE);
  const deps = makeDeps(dir);
  const out = await handleIssuesList(deps, { projectId: 'demo' });
  assert.equal(out.length, 3);
  assert.equal(out[0].title, 'task-block 拦不住已派发在途执行');
});

test('handleIssuesList returns [] when ISSUES.md is missing', async () => {
  const dir = writeTempContext(null);
  const out = await handleIssuesList(makeDeps(dir), { projectId: 'demo' });
  assert.deepEqual(out, []);
});

test('handleIssuesList throws not-found for an unknown project', async () => {
  const deps = makeDeps(null);
  await assert.rejects(
    () => handleIssuesList(deps, { projectId: 'nope' }),
    (err: any) => err.code === 'not-found',
  );
});
