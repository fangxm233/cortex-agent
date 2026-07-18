import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  removeIssueEntry,
  buildIssuePrompt,
  handleIssuesDelete,
  handleIssuesHandle,
} from '../../../src/domain/ui-service/mutate/issues.js';
import { parseIssues } from '../../../src/domain/ui-service/query/issues.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const SAMPLE = `# demo ISSUES

preamble line.

- **First issue title** (2026-07-02)
  - 问题：first body line.
  - 建议：first suggestion.

- **Second issue title** (2026-07-04)
  - 问题：second body line.

- **Third issue title** (2026-07-05)
  - 问题：third body line.
`;

function idOf(md: string, title: string): string {
  const e = parseIssues(md).find((x) => x.title === title);
  if (!e) throw new Error(`no entry titled ${title}`);
  return e.id;
}

interface SentMessage {
  sessionId: string;
  channel: string;
  text: string;
}

function makeDeps(
  contextDir: string | null,
  opts?: { sent?: SentMessage[]; created?: string[] },
): UiServiceDeps {
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
    scheduler: { list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: (args: any) => {
      opts?.sent?.push({ sessionId: args.sessionId, channel: args.channel, text: args.text });
    },
    approvalsPath: '/nonexistent/PENDING_APPROVALS.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async (args: any) => {
      opts?.created?.push(args.projectId);
      return { sessionId: 'sess_new', sessionName: 'cortex-0001', channel: 'web:demo:1' };
    },
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: {} as any,
  };
}

function writeTempContext(content: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cortex-issues-mut-'));
  fs.writeFileSync(path.join(dir, 'ISSUES.md'), content, 'utf8');
  return dir;
}

// ── (1) removeIssueEntry: pure block removal ─────────────────────────────────
test('removeIssueEntry removes exactly the target entry block, preserving the rest', () => {
  const id = idOf(SAMPLE, 'Second issue title');
  const { md, entry } = removeIssueEntry(SAMPLE, id);
  assert.equal(entry.title, 'Second issue title');
  const remaining = parseIssues(md);
  assert.deepEqual(remaining.map((e) => e.title), ['First issue title', 'Third issue title']);
  // untouched entries stay byte-identical (their body lines survive verbatim)
  assert.match(md, /- 问题：first body line\./);
  assert.match(md, /- 问题：third body line\./);
  assert.ok(!md.includes('Second issue title'));
  assert.ok(!md.includes('second body line'));
  // preamble preserved
  assert.match(md, /# demo ISSUES/);
  assert.match(md, /preamble line\./);
  // no double blank-line residue where the block was removed
  assert.ok(!md.includes('\n\n\n'));
});

test('removeIssueEntry removes the last entry cleanly', () => {
  const id = idOf(SAMPLE, 'Third issue title');
  const { md } = removeIssueEntry(SAMPLE, id);
  const remaining = parseIssues(md);
  assert.deepEqual(remaining.map((e) => e.title), ['First issue title', 'Second issue title']);
  assert.ok(!md.includes('third body line'));
});

test('removeIssueEntry throws not-found for an unknown id', () => {
  assert.throws(
    () => removeIssueEntry(SAMPLE, 'deadbeef'),
    (err: any) => err.code === 'not-found',
  );
});

// ── (2) buildIssuePrompt carries the full entry text ─────────────────────────
test('buildIssuePrompt embeds project, title and the full entry body', () => {
  const entry = parseIssues(SAMPLE)[0];
  const prompt = buildIssuePrompt('demo', entry);
  assert.match(prompt, /demo/);
  assert.match(prompt, /First issue title/);
  assert.match(prompt, /first body line\./);
  assert.match(prompt, /first suggestion\./);
  assert.match(prompt, /ISSUES\.md/);
});

// ── (3) delete handler ───────────────────────────────────────────────────────
test('handleIssuesDelete removes the entry from disk and returns ok', async () => {
  const dir = writeTempContext(SAMPLE);
  const deps = makeDeps(dir);
  const id = idOf(SAMPLE, 'Second issue title');
  const res = await handleIssuesDelete(deps, { projectId: 'demo', id });
  assert.equal(res.ok, true);
  assert.deepEqual((res as any).data, { id, deleted: true });
  const after = fs.readFileSync(path.join(dir, 'ISSUES.md'), 'utf8');
  assert.deepEqual(parseIssues(after).map((e) => e.title), ['First issue title', 'Third issue title']);
});

test('handleIssuesDelete → not-found for unknown id / unknown project', async () => {
  const dir = writeTempContext(SAMPLE);
  const badId = await handleIssuesDelete(makeDeps(dir), { projectId: 'demo', id: 'deadbeef' });
  assert.equal(badId.ok, false);
  assert.equal((badId as any).code, 'not-found');
  const badProject = await handleIssuesDelete(makeDeps(dir), { projectId: 'nope', id: 'deadbeef' });
  assert.equal(badProject.ok, false);
  assert.equal((badProject as any).code, 'not-found');
});

// ── (4) handle handler: session + prompt + removal ───────────────────────────
test('handleIssuesHandle creates a session, sends the issue prompt, removes the entry', async () => {
  const dir = writeTempContext(SAMPLE);
  const sent: SentMessage[] = [];
  const created: string[] = [];
  const deps = makeDeps(dir, { sent, created });
  const id = idOf(SAMPLE, 'First issue title');
  const res = await handleIssuesHandle(deps, { projectId: 'demo', id });
  assert.equal(res.ok, true);
  assert.deepEqual((res as any).data, { sessionId: 'sess_new' });
  // session created for the right project, prompt carries the full entry
  assert.deepEqual(created, ['demo']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'sess_new');
  assert.equal(sent[0].channel, 'web:demo:1');
  assert.match(sent[0].text, /First issue title/);
  assert.match(sent[0].text, /first body line\./);
  // entry removed from disk
  const after = fs.readFileSync(path.join(dir, 'ISSUES.md'), 'utf8');
  assert.deepEqual(parseIssues(after).map((e) => e.title), ['Second issue title', 'Third issue title']);
});

test('handleIssuesHandle → not-found for unknown id, without creating a session', async () => {
  const dir = writeTempContext(SAMPLE);
  const created: string[] = [];
  const res = await handleIssuesHandle(makeDeps(dir, { created }), { projectId: 'demo', id: 'deadbeef' });
  assert.equal(res.ok, false);
  assert.equal((res as any).code, 'not-found');
  assert.deepEqual(created, []);
});
