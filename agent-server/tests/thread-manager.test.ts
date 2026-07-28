// input:  vitest, thread APIs, session activity fixtures
// output: Prompt variables, transitions, and creation regressions
// pos:    Thread helper and orchestration behavioral tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DATA_DIR } from '../src/core/utils.js';
import { threadStore } from '../src/store/thread-repo.js';
import {
  buildStepPrompt,
  cleanupWorkspace,
  createThread,
  evaluateTransitions,
  getModifiedFilesFromSession,
  getSessionKey,
  isAdHocThread,
  isDefaultThread,
  listAgents,
  loadConfig,
  resolveAgentSlotConfig,
  resolveSystemVars,
} from '../src/domain/threads/index.js';

const SESSION_LOG_DIR = path.join(DATA_DIR, 'logs', 'session-activity');
const SESSION_ID_PREFIX = 'test-thread-manager-';
const createdSessionIds = new Set<string>();

function uniqueSessionId(): string {
  const id = `${SESSION_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdSessionIds.add(id);
  return id;
}

function writeSessionLog(sessionId: string, content: string) {
  fs.mkdirSync(SESSION_LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_LOG_DIR, `${sessionId}.jsonl`), content);
}

function removeSessionLog(sessionId: string) {
  try {
    fs.unlinkSync(path.join(SESSION_LOG_DIR, `${sessionId}.jsonl`));
  } catch {}
  createdSessionIds.delete(sessionId);
}

// Safety net: if a test is killed mid-run (Ctrl-C, SIGTERM), unlink any logs we created
// and also sweep any orphaned logs from earlier aborted runs that share our prefix.
process.on('exit', () => {
  for (const id of createdSessionIds) {
    try { fs.unlinkSync(path.join(SESSION_LOG_DIR, `${id}.jsonl`)); } catch {}
  }
  try {
    for (const entry of fs.readdirSync(SESSION_LOG_DIR)) {
      if (entry.startsWith(SESSION_ID_PREFIX)) {
        try { fs.unlinkSync(path.join(SESSION_LOG_DIR, entry)); } catch {}
      }
    }
  } catch {}
});

// --- resolveSystemVars ---

test('resolveSystemVars replaces {{currentDateTime}} with a timestamp string', () => {
  const out = resolveSystemVars('Now is {{currentDateTime}}.');
  assert.doesNotMatch(out, /\{\{currentDateTime\}\}/);
  // Format comes from zh-CN Asia/Shanghai locale with yyyy/mm/dd hh:mm:ss-ish shape.
  assert.match(out, /\d{4}/);
});

test('resolveSystemVars leaves unknown placeholders untouched', () => {
  const out = resolveSystemVars('Hello {{name}} and {{currentDateTime}}.');
  assert.match(out, /Hello \{\{name\}\}/);
  assert.doesNotMatch(out, /\{\{currentDateTime\}\}/);
});

test('resolveSystemVars leaves text without placeholders unchanged', () => {
  assert.equal(resolveSystemVars('no vars here'), 'no vars here');
});

test('resolveSystemVars replaces multiple {{currentDateTime}} occurrences with identical value', () => {
  const out = resolveSystemVars('{{currentDateTime}} = {{currentDateTime}}');
  const [a, b] = out.split(' = ');
  assert.equal(a, b);
});

// --- getModifiedFilesFromSession ---

test('getModifiedFilesFromSession returns [] when sessionId is null/undefined/empty', () => {
  assert.deepEqual(getModifiedFilesFromSession(null), []);
  assert.deepEqual(getModifiedFilesFromSession(undefined), []);
  assert.deepEqual(getModifiedFilesFromSession(''), []);
});

test('getModifiedFilesFromSession returns [] when log file is missing', () => {
  const id = uniqueSessionId();
  assert.deepEqual(getModifiedFilesFromSession(id), []);
});

test('getModifiedFilesFromSession returns [] for empty log', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, '');
  try {
    assert.deepEqual(getModifiedFilesFromSession(id), []);
  } finally {
    removeSessionLog(id);
  }
});

test('getModifiedFilesFromSession extracts and de-dupes edit_file + write_file paths, ignoring other events', () => {
  const id = uniqueSessionId();
  const lines = [
    JSON.stringify({ event: 'read_file', file_path: '/skip/this.txt' }),
    JSON.stringify({ event: 'edit_file', file_path: '/a/b.ts' }),
    JSON.stringify({ event: 'edit_file', file_path: '/a/b.ts' }),
    JSON.stringify({ event: 'write_file', file_path: '/c/d.md' }),
    JSON.stringify({ event: 'skill', file_path: '/also/skip.md' }),
  ].join('\n');
  writeSessionLog(id, lines);
  try {
    const files = getModifiedFilesFromSession(id).sort();
    assert.deepEqual(files, ['/a/b.ts', '/c/d.md']);
  } finally {
    removeSessionLog(id);
  }
});

test('getModifiedFilesFromSession tolerates malformed JSON lines and missing fields', () => {
  const id = uniqueSessionId();
  const lines = [
    'not json',
    JSON.stringify({ event: 'edit_file' }), // missing file_path
    JSON.stringify({ event: 'edit_file', file_path: '  ' }), // blank
    JSON.stringify({ event: 'edit_file', file_path: '/only/one.ts' }),
    '',
  ].join('\n');
  writeSessionLog(id, lines);
  try {
    assert.deepEqual(getModifiedFilesFromSession(id), ['/only/one.ts']);
  } finally {
    removeSessionLog(id);
  }
});

test('getModifiedFilesFromSession trims leading/trailing whitespace from file paths', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, JSON.stringify({ event: 'edit_file', file_path: '  /path/with/space.ts  ' }));
  try {
    assert.deepEqual(getModifiedFilesFromSession(id), ['/path/with/space.ts']);
  } finally {
    removeSessionLog(id);
  }
});

test('buildStepPrompt keeps the modified file list but drops obsolete inline change content', () => {
  const sessionId = uniqueSessionId();
  writeSessionLog(sessionId, JSON.stringify({
    ts: new Date().toISOString(),
    tool: 'Edit',
    event: 'edit_file',
    file_path: '/srv/private.md',
    originalFile: 'PRIVATE_BEFORE\n',
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-PRIVATE_BEFORE', '+PRIVATE_AFTER'] }],
  }));
  const anyAgent = listAgents()[0];
  const thread = createThread('C-compact-prompt', {
    agentName: anyAgent.name,
    userMessage: 'review',
    userMessageTs: 'ts',
  });
  trackThreadId(thread.id);
  const stored = threadStore.get(thread.id)!;
  stored.steps.push({
    stepIndex: 0,
    agentSlotId: anyAgent.name,
    stage: null,
    executionId: null,
    sessionId,
    sessionName: null,
    input: '',
    output: 'done',
    costUsd: 0,
    numTurns: 1,
    durationS: 0,
    startedAt: null,
    endedAt: null,
  });
  threadStore.set(stored);
  const config = {
    ...resolveAgentSlotConfig(anyAgent.name)!,
    persistSession: false,
    promptTemplate: 'Files:\n{{modifiedFiles}}',
  };

  try {
    const prompt = buildStepPrompt(thread.id, config);
    assert.match(prompt, /- \/srv\/private\.md/);
    assert.doesNotMatch(prompt, /PRIVATE_BEFORE|PRIVATE_AFTER|```diff/);
  } finally {
    removeSessionLog(sessionId);
  }
});

// --- thread predicates ---

test('isDefaultThread and isAdHocThread return false for unknown thread ids', () => {
  assert.equal(isDefaultThread('nope-' + Math.random()), false);
  assert.equal(isAdHocThread('nope-' + Math.random()), false);
});

// --- getSessionKey ---

test('getSessionKey formats thread + slot as thr:<threadId>:<slotId>', () => {
  assert.equal(getSessionKey('thr-123', 'writer'), 'thr:thr-123:writer');
  assert.equal(getSessionKey('abc', 'a0'), 'thr:abc:a0');
});

// --- createThread / evaluateTransitions (P1 orchestration paths) ---
//
// These tests mutate threadStore (writing to DATA_DIR/threads.json). We back up the real
// threads.json once and restore on teardown. Test threads are recorded and deleted to keep
// the in-memory store clean too.

const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
let threadsBackup: string | null = null;
let threadsBackupExisted = false;
const createdThreadIds = new Set<string>();

beforeAll(() => {
  try {
    threadsBackup = fs.readFileSync(THREADS_FILE, 'utf8');
    threadsBackupExisted = true;
  } catch {
    threadsBackup = null;
    threadsBackupExisted = false;
  }
  loadConfig();
});

afterAll(async () => {
  for (const id of createdThreadIds) {
    try { cleanupWorkspace(id); } catch {}
    await threadStore.delete(id);
  }
  if (threadsBackupExisted && threadsBackup != null) {
    fs.writeFileSync(THREADS_FILE, threadsBackup);
  } else {
    try { fs.unlinkSync(THREADS_FILE); } catch {}
  }
  await threadStore.flush();
});

process.on('exit', () => {
  if (threadsBackupExisted && threadsBackup != null) {
    try { fs.writeFileSync(THREADS_FILE, threadsBackup); } catch {}
  }
});

function trackThreadId(id: string): string {
  createdThreadIds.add(id);
  return id;
}

test('createThread ad-hoc with valid agent populates slot, workspace, and isAdHocThread=true', () => {
  const anyAgent = listAgents()[0];
  assert.ok(anyAgent, 'loadConfig should have populated at least one agent');

  const thread = createThread('C-create-1', {
    agentName: anyAgent.name,
    userMessage: 'hello',
    userMessageTs: 'ts-1',
  });
  trackThreadId(thread.id);

  assert.equal(thread.templateName, null);
  assert.equal(thread.channel, 'C-create-1');
  assert.equal(thread.activeAgent, anyAgent.name);
  assert.ok(thread.agents[anyAgent.name], 'slot should exist for the agent');
  assert.equal(thread.agents[anyAgent.name].status, 'idle');
  assert.ok(thread.workspacePath.length > 0);
  assert.ok(fs.existsSync(thread.workspacePath), 'workspace directory should exist');
  assert.ok(fs.existsSync(thread.artifactPath), 'artifact file should be initialised');
  assert.equal(isAdHocThread(thread.id), true);
  assert.equal(isDefaultThread(thread.id), false);
});

test('createThread throws for unknown agent name', () => {
  assert.throws(
    () => createThread('C-create-2', { agentName: 'does-not-exist-xxxx', userMessage: 'x', userMessageTs: 'ts' }),
    /Unknown agent/,
  );
});

test('createThread throws when neither templateName nor agentName is provided', () => {
  assert.throws(
    () => createThread('C-create-3', { userMessage: 'x', userMessageTs: 'ts' } as any),
    /requires either templateName or agentName/,
  );
});

test('evaluateTransitions returns no_matching_transition for unknown thread id', () => {
  const result = evaluateTransitions('thr_does-not-exist-' + Date.now());
  assert.equal(result.shouldTransition, false);
  assert.equal(result.reason, 'no_matching_transition');
});

test('evaluateTransitions returns no_matching_transition for ad-hoc thread (no template)', () => {
  const anyAgent = listAgents()[0];
  const thread = createThread('C-eval-1', {
    agentName: anyAgent.name,
    userMessage: 'x',
    userMessageTs: 'ts',
  });
  trackThreadId(thread.id);
  const result = evaluateTransitions(thread.id);
  assert.equal(result.shouldTransition, false);
  assert.equal(result.reason, 'no_matching_transition');
});

test('evaluateTransitions returns no_matching_transition when steps array is empty (template thread)', () => {
  // Construct a synthetic template thread directly in the store so we can control transitions.
  // This bypasses createThread's config requirement and lets us test the empty-steps guard in
  // evaluateTransitions (line 632-633 of thread-manager.ts: `if (!lastStep) return fallback`).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-manager-empty-'));
  const artifactPath = path.join(tmp, 'artifact.md');
  fs.writeFileSync(artifactPath, '');
  const id = 'thr_test-empty-' + Date.now().toString(36);
  trackThreadId(id);

  const agent = listAgents()[0];
  threadStore.set({
    id, channel: 'C-eval-2',
    templateName: 'nonexistent-template-xxxx', // unknown template → still fallback
    status: 'running',
    projectId: 'general',
    platformThreadId: null,
    userMessage: '', userMessageTs: 'ts',
    workspacePath: tmp, artifactPath,
    agents: { [agent.name]: { slotId: agent.name, profile: '__active__', sessionId: null, sessionName: null, status: 'idle', lastOutput: null, persistSession: false } },
    activeAgent: agent.name,
    activeStage: null,
    currentStepIndex: 0, steps: [], iterationCounts: {},
    totalCostUsd: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    endedAt: null, error: null, abortReason: null, metadata: null,
  });

  const result = evaluateTransitions(id);
  assert.equal(result.shouldTransition, false);
  assert.equal(result.reason, 'no_matching_transition');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('evaluateTransitions respects max_iterations cost_limit when currentStepIndex >= maxTotalSteps', async () => {
  // Since `templates` is a module-private map, this test relies on a real production template
  // with a conservative maxTotalSteps. Skip quietly if none exists.
  const { listTemplates } = await import('../src/domain/threads/index.js');
  const candidate = listTemplates().find((t) => t.maxTotalSteps && t.maxTotalSteps <= 3);
  if (!candidate) return; // skip quietly — no suitable production template

  const thread = createThread('C-eval-limit', {
    templateName: candidate.name,
    userMessage: 'x',
    userMessageTs: 'ts',
  });
  trackThreadId(thread.id);

  // Fast-forward currentStepIndex past the limit + push one dummy step so `lastStep` is defined.
  const stored = threadStore.get(thread.id)!;
  const dummyStep = {
    stepIndex: 0, agentSlotId: stored.activeAgent, stage: null, executionId: null,
    sessionId: null, sessionName: null, input: '', output: 'x',
    costUsd: 0, numTurns: 1, durationS: 0, startedAt: null, endedAt: null,
  };
  stored.steps.push(dummyStep);
  stored.currentStepIndex = candidate.maxTotalSteps; // exactly at the limit
  threadStore.set(stored);

  const result = evaluateTransitions(thread.id);
  assert.equal(result.shouldTransition, false);
  assert.equal(result.reason, 'max_iterations');
});
