// input:  Node test runner + thread-callback session→task wake bridge
// output: notifyTaskOriginSession tests for origin-session terminal-task notices
// pos:    Verifies wake precedence and system-reminder framing
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { threadStore } from '../src/store/thread-repo.js';
import { notifyTaskOriginSession, _testResetCallbackState } from '../src/orchestration/thread-callback.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const projectDirs: string[] = [];
const createdThreadIds = new Set<string>();
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
  for (const d of projectDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function makeProject(name: string, yaml: string): void {
  const dir = path.join(PROJECTS_DIR, name);
  projectDirs.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TASKS.yaml'), yaml);
}

function originTaskYaml(id: string, over: Record<string, string> = {}): string {
  const lines = [
    `  - id: "${id}"`, `    text: task ${id}`, '    why: w', '    done-when: dw',
    '    priority: medium', `    status: ${over.status ?? 'done'}`, '    template: coder-review', '    plan: p',
  ];
  if (over.channel) lines.push(`    origin-channel: ${over.channel}`);
  if (over.session) lines.push(`    origin-session-id: ${over.session}`);
  if (over.blocked) lines.push(`    blocked-by: ${over.blocked}`);
  if (over.note) lines.push(`    completed-note: ${over.note}`);
  return lines.join('\n') + '\n';
}

function makeWaitingThread(proj: string, waitingOnTasks: string[]): string {
  const id = `thr_ow${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  threadStore.set({
    id, templateName: 'manager', status: 'waiting' as ThreadStatus, channel: 'C', projectId: proj,
    platformThreadId: null, userMessage: 'x', userMessageTs: 't', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'm', activeStage: null, currentStepIndex: 1, steps: [], iterationCounts: {},
    totalCostUsd: 0, createdAt: now, updatedAt: now, endedAt: null, error: null, abortReason: null,
    metadata: { waitingOnTasks: [...waitingOnTasks] },
  } as ThreadRecord);
  createdThreadIds.add(id);
  return id;
}

test('notifyTaskOriginSession wakes the origin channel on completion', async () => {
  _testResetCallbackState();
  const proj = `_ow_p${seq++}`;
  makeProject(proj, 'tasks:\n' + originTaskYaml('a1', { channel: 'C-origin', session: 's1', status: 'done', note: 'all good' }));
  const calls: { channel: string; notice: string }[] = [];
  await notifyTaskOriginSession('a1', 'completed', { wake: (channel, notice) => { calls.push({ channel, notice }); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'C-origin');
  assert.equal(
    calls[0].notice,
    `<system-reminder>\n[Task done] The task you dispatched #a1 (${proj}) "task a1" is complete.\nNote: all good\nRun cortex-task show --task-id a1 for details.\n</system-reminder>`,
  );
});

test('notifyTaskOriginSession ignores tasks with no origin channel', async () => {
  _testResetCallbackState();
  const proj = `_ow_p${seq++}`;
  makeProject(proj, 'tasks:\n' + originTaskYaml('b1', { status: 'done' }));
  const calls: any[] = [];
  await notifyTaskOriginSession('b1', 'completed', { wake: (c, n) => { calls.push({ c, n }); } });
  assert.equal(calls.length, 0);
});

test('notifyTaskOriginSession defers to the thread-parent path when a thread is waiting on the task', async () => {
  _testResetCallbackState();
  const proj = `_ow_p${seq++}`;
  makeProject(proj, 'tasks:\n' + originTaskYaml('c1', { channel: 'C-x', status: 'done' }));
  makeWaitingThread(proj, ['c1']);
  const calls: any[] = [];
  await notifyTaskOriginSession('c1', 'completed', { wake: (c, n) => { calls.push({ c, n }); } });
  assert.equal(calls.length, 0);
});

test('notifyTaskOriginSession ignores a loose completed event when the task is not done on disk', async () => {
  _testResetCallbackState();
  const proj = `_ow_p${seq++}`;
  makeProject(proj, 'tasks:\n' + originTaskYaml('d1', { channel: 'C-y', status: 'open' }));
  const calls: any[] = [];
  await notifyTaskOriginSession('d1', 'completed', { wake: (c, n) => { calls.push({ c, n }); } });
  assert.equal(calls.length, 0);
});

test('notifyTaskOriginSession is single-fire per task+kind', async () => {
  _testResetCallbackState();
  const proj = `_ow_p${seq++}`;
  makeProject(proj, 'tasks:\n' + originTaskYaml('e1', { channel: 'C-z', status: 'done' }));
  const calls: any[] = [];
  await notifyTaskOriginSession('e1', 'completed', { wake: (c, n) => { calls.push({ c, n }); } });
  await notifyTaskOriginSession('e1', 'completed', { wake: (c, n) => { calls.push({ c, n }); } });
  assert.equal(calls.length, 1);
});

test('notifyTaskOriginSession wakes on blocked with the block reason', async () => {
  _testResetCallbackState();
  const proj = `_ow_p${seq++}`;
  makeProject(proj, 'tasks:\n' + originTaskYaml('f1', { channel: 'C-b', status: 'open', blocked: 'stuck' }));
  const calls: { channel: string; notice: string }[] = [];
  await notifyTaskOriginSession('f1', 'blocked', { wake: (channel, notice) => { calls.push({ channel, notice }); } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].notice, /stuck|受阻|阻塞/);
});
