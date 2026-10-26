import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { CLEAN_WORKSPACES_DIR, CONFIG_DIR } from '../src/core/paths.js';
import { createWorkspace } from '../src/core/workspace.js';
import { resolveInvocation } from '../src/core/agents/subagent/schema.js';
import {
  openChildWorkspace, prepareCleanTasks, withWorkspaceNote,
} from '../src/core/agents/subagent/workspace.js';
import { subagentNoticeEvents } from '../src/core/agents/subagent/attribution.js';
import { noticesFor } from '../src/agent-adapter/pi/child-events.js';
import { runPiChild } from '../src/agent-adapter/pi/child-runner.js';
import type { ChildSessionRequest } from '../src/agent-adapter/pi/child-session.js';
import { subagentRowFields } from '../src/store/conversation-history-repo.js';
import { buildEngineSpec } from '../src/domain/runs/engine-spec.js';
import { emptyUsage } from '../src/core/agents/subagent/usage.js';
import type { SubagentResult, SubagentTask } from '../src/core/agents/subagent/types.js';

const runSubagent = vi.hoisted(() => vi.fn());
vi.mock('../src/domain/agents/subagent/runner.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runSubagent,
}));
const { startDaemonSubagentRun } = await import('../src/domain/agents/subagent/service.js');
const { _test: runnerTest } = await import('../src/domain/agents/subagent/runner.js');
const { _resetSubagentRuns, waitForSubagentRun } = await import('../src/domain/agents/subagent/registry.js');

function task(overrides: Partial<SubagentTask> = {}): SubagentTask {
  return { description: 'd', prompt: 'p', subagent_type: 'general-purpose', ...overrides };
}

function ok(output = 'done'): SubagentResult {
  return { description: 'd', prompt: 'p', subagentType: 'general-purpose', output, usage: emptyUsage() };
}

function tmpFile(name: string, body = 'x'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sub-clean-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  runSubagent.mockReset();
  _resetSubagentRuns();
  const dir = path.join(CONFIG_DIR, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'general-purpose.md'), '---\nname: general-purpose\ndescription: d\n---\nbody');
});
afterEach(() => { _resetSubagentRuns(); });

const parent = { backend: 'claude' as const, channel: 'web:1', env: process.env };

// --- validation and preparation ---

test('the schema accepts clean and files and rejects malformed ones', () => {
  assert.doesNotThrow(() => resolveInvocation(task({ clean: true, files: ['/a'] })));
  assert.throws(() => resolveInvocation({ ...task(), clean: 'yes' }), /clean must be a boolean/);
  assert.throws(() => resolveInvocation({ ...task(), files: '/a' }), /files must be a list/);
  assert.throws(() => resolveInvocation({ parallel: [{ ...task(), files: [''] }] }), /files must be a list/);
});

test('files imply clean and resolve to absolute paths; a missing one rejects the call', () => {
  const file = tmpFile('notes.md');
  const prepared = prepareCleanTasks(
    { mode: 'parallel', tasks: [task({ files: [path.basename(file)] }), task()] },
    { cwd: path.dirname(file), parentWorkspace: null },
  );
  assert.deepEqual(prepared.tasks[0], { ...task(), clean: true, files: [file] });
  assert.equal(prepared.tasks[1].clean, undefined, 'an ordinary sibling stays ordinary');
  assert.throws(
    () => prepareCleanTasks({ mode: 'single', tasks: [task({ files: ['/nope/missing.csv'] })] }, { cwd: '/', parentWorkspace: null }),
    /file not found: \/nope\/missing.csv/,
  );
});

test('a clean parent makes every child clean', () => {
  const prepared = prepareCleanTasks({ mode: 'single', tasks: [task()] }, { cwd: '/', parentWorkspace: '/srv/ws' });
  assert.equal(prepared.tasks[0].clean, true);
});

test('a clean child gets sub-<run>-<index> with its files; under a clean parent it shares that workspace', async () => {
  const file = tmpFile('data.csv', 'a,b');
  const own = await openChildWorkspace(task({ clean: true, files: [file] }), { parentWorkspace: null, runId: 'sa_abc', index: 1 });
  assert.equal(own, path.join(CLEAN_WORKSPACES_DIR, 'sub-sa_abc-1'));
  assert.equal(fs.readFileSync(path.join(own!, 'inputs', 'data.csv'), 'utf8'), 'a,b');

  const parentWs = createWorkspace('parent-ws');
  const shared = await openChildWorkspace(task({ clean: true, files: [file] }), { parentWorkspace: parentWs, runId: 'r', index: 0 });
  assert.equal(shared, parentWs);
  assert.ok(fs.existsSync(path.join(parentWs, 'inputs', 'data.csv')));
  assert.equal(await openChildWorkspace(task(), { parentWorkspace: null, runId: 'r', index: 0 }), null);
});

test('the workspace is named at the end of the child result', () => {
  assert.equal(withWorkspaceNote(ok('report'), '/srv/ws').output, 'report\n\nWorkspace: /srv/ws');
  assert.equal(withWorkspaceNote(ok(''), '/srv/ws').output, 'Workspace: /srv/ws');
  assert.equal(withWorkspaceNote(ok('report'), null).output, 'report');
});

// --- daemon runner ---

test('the daemon runs a clean child in its workspace and names it in the result', async () => {
  runSubagent.mockImplementation(async () => ok('found it'));
  const view = startDaemonSubagentRun({
    params: task({ clean: true }), background: false, cwd: '/tmp', parent, sessionId: 's1',
  });
  const outcome = await waitForSubagentRun(view.id, 5000);
  const request = runSubagent.mock.calls[0][0];
  const workspace = path.join(CLEAN_WORKSPACES_DIR, `sub-${view.id}-0`);
  assert.equal(request.workspace, workspace);
  assert.equal(request.cwd, workspace);
  assert.equal(request.task.clean, true);
  assert.match(outcome!.result!.content[0].text, new RegExp(`found it\\n\\nWorkspace: ${workspace}$`));
});

test('the daemon refuses a call naming a missing file before any child starts', () => {
  assert.throws(() => startDaemonSubagentRun({
    params: { parallel: [task(), task({ files: ['/nope/x'] })] }, background: false, cwd: '/tmp', parent, sessionId: 's1',
  }), /file not found/);
  assert.equal(runSubagent.mock.calls.length, 0);
});

test('a clean parent\'s children run in the parent workspace', async () => {
  runSubagent.mockImplementation(async () => ok());
  const parentWs = createWorkspace('lead-ws');
  const view = startDaemonSubagentRun({
    params: task(), background: false, cwd: '/tmp', parent, sessionId: 's1', parentWorkspace: parentWs,
  });
  await waitForSubagentRun(view.id, 5000);
  assert.equal(runSubagent.mock.calls[0][0].workspace, parentWs);
});

test('a clean Claude child runs in its workspace under the clean policy, the workspace after its role', () => {
  const request = {
    task: task({ clean: true }), role: { systemPrompt: 'ROLE', tools: null }, cwd: '/tmp/work',
    workspace: '/srv/workspaces/sub-r-0', parent: { backend: 'claude', channel: 'web:1' },
  } as any;
  const config = { model: 'm', backend: 'claude', mode: 'plan', provider: null, thinking: null } as any;
  const built = runnerTest.claudeChildRequest(request, config);
  assert.equal(built.cwd, '/srv/workspaces/sub-r-0');
  assert.equal(built.policy.clean, true);
  assert.deepEqual(built.policy.settingSources, ['user', 'local']);
  const append = buildEngineSpec(built, config).prompt.append!;
  assert.ok(append.startsWith('ROLE'));
  assert.ok(append.includes('the current directory, /srv/workspaces/sub-r-0.'));

  const plain = runnerTest.claudeChildRequest({ ...request, workspace: null }, config);
  assert.equal(plain.cwd, '/tmp/work');
  assert.equal(plain.policy.clean, undefined);
});

test('a clean PI child runs in its workspace without context files, the workspace after its role', async () => {
  const calls: ChildSessionRequest[] = [];
  await runPiChild({
    task: task(), role: { name: 'r', systemPrompt: 'ROLE', tools: null } as any,
    cwd: '/tmp/work', workspace: '/srv/workspaces/sub-r-0', agentDir: '/srv/pi', parentEnv: {},
    childExtensions: () => [],
    createSession: async (req) => {
      calls.push(req);
      return { session: { prompt: async () => {}, subscribe: () => () => {}, abort: async () => {} }, dispose: () => {} } as any;
    },
  });
  assert.equal(calls[0].cwd, '/srv/workspaces/sub-r-0');
  assert.equal(calls[0].noContextFiles, true);
  assert.equal(calls[0].appendSystemPrompt[0], 'ROLE');
  assert.match(calls[0].appendSystemPrompt[1], /^## Workspace/);
});

// --- transcript marker ---

test('a clean child\'s notices mark its rows clean all the way to the stored row fields', () => {
  const [notice] = noticesFor('run#0', { ...task(), clean: true }, { output: '', usage: emptyUsage() }, {
    type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: {},
  });
  assert.equal(notice.clean, true);
  const [event] = subagentNoticeEvents(notice) as any[];
  assert.equal(event.subagent.clean, true);
  assert.deepEqual(subagentRowFields({ id: 'run#0', clean: true }), { subagentId: 'run#0', subagentClean: true });
  assert.deepEqual(subagentRowFields({ id: 'run#0' }), { subagentId: 'run#0' });
});

test('a clean child\'s stored rows read back marked, and its compact summary says clean', async () => {
  const { ConversationHistoryRepo } = await import('../src/store/conversation-history-repo.js');
  const { projectCompactHistory } = await import('../src/store/conversation-display-projection.js');
  const repo = new ConversationHistoryRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hist-clean-')));
  await repo.appendUser('s1', { text: 'go' });
  await repo.appendTool('s1', { toolName: 'Read', toolInput: 'a', toolUseId: 'run#0:t1', subagent: { id: 'run#0', type: 'explore', clean: true } });
  await repo.appendTool('s1', { toolName: 'Read', toolInput: 'b', toolUseId: 'run#1:t1', subagent: { id: 'run#1', type: 'explore' } });
  const compact = projectCompactHistory((await repo.getHistory('s1'))!);
  const rows = compact.events.filter(e => e.subagentId);
  assert.deepEqual(rows.map(e => e.subagentClean), [true, undefined]);
  assert.deepEqual(compact.subagentSummaries.map(s => [s.id, s.clean]), [['run#0', true], ['run#1', undefined]]);
});
