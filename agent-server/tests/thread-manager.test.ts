// input:  Node test runner + thread-manager API + templates
// output: resolveSystemVars + evaluateTransitions + create
// pos:    Verify thread-manager pure helpers and orchestration
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DATA_DIR } from '../src/core/utils.js';
import { threadStore } from '../src/store/thread-repo.js';
import {
  cleanupWorkspace,
  createThread,
  evaluateTransitions,
  getModifiedFilesFromSession,
  getSessionFileChanges,
  getSessionKey,
  isAdHocThread,
  isDefaultThread,
  listAgents,
  loadConfig,
  renderModifiedFilesWithDiff,
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

// --- getSessionFileChanges (net diff reconstruction) ---

interface MutationLine {
  ts: string;
  tool: 'Edit' | 'Write';
  event: 'edit_file' | 'write_file';
  file_path: string;
  device?: string;
  originalFile?: string | null;
  structuredPatch?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>;
  writtenContent?: string;
  diffDegraded?: boolean;
}

function jsonl(lines: MutationLine[]): string {
  return lines.map(l => JSON.stringify(l)).join('\n');
}

function ts(seq: number): string {
  return new Date(2026, 0, 1, 0, 0, seq).toISOString();
}

// Helper to build hunks for a single-line edit replacing one line in a 3-line file.
function singleLineHunks(beforeContext: string, oldLine: string, newLine: string, afterContext: string): MutationLine['structuredPatch'] {
  return [{
    oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
    lines: [` ${beforeContext}`, `-${oldLine}`, `+${newLine}`, ` ${afterContext}`],
  }];
}

test('getSessionFileChanges returns [] for null/missing session', () => {
  assert.deepEqual(getSessionFileChanges(null), []);
  assert.deepEqual(getSessionFileChanges(uniqueSessionId()), []);
});

test('getSessionFileChanges single Edit produces net unified diff', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, jsonl([{
    ts: ts(1), tool: 'Edit', event: 'edit_file', file_path: '/x/a.txt',
    originalFile: 'a\nb\nc\n',
    structuredPatch: singleLineHunks('a', 'b', 'BEE', 'c'),
  }]));
  try {
    const changes = getSessionFileChanges(id);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].mode, 'net');
    assert.match(changes[0].unifiedDiff, /-b/);
    assert.match(changes[0].unifiedDiff, /\+BEE/);
  } finally {
    removeSessionLog(id);
  }
});

test('getSessionFileChanges multi-Edit on same file accumulates to net baseline→final', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, jsonl([
    { ts: ts(1), tool: 'Edit', event: 'edit_file', file_path: '/x/a.txt',
      originalFile: 'a\nb\nc\n',
      structuredPatch: singleLineHunks('a', 'b', 'BEE', 'c') },
    { ts: ts(2), tool: 'Edit', event: 'edit_file', file_path: '/x/a.txt',
      originalFile: 'a\nBEE\nc\n', // truthful intermediate (we ignore this anyway)
      structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
        lines: [' a', ' BEE', '-c', '+SEE'] }] },
  ]));
  try {
    const [c] = getSessionFileChanges(id);
    assert.equal(c.mode, 'net');
    assert.match(c.unifiedDiff, /-b/);
    assert.match(c.unifiedDiff, /\+BEE/);
    assert.match(c.unifiedDiff, /-c/);
    assert.match(c.unifiedDiff, /\+SEE/);
  } finally {
    removeSessionLog(id);
  }
});

test('getSessionFileChanges ignores record[i>0].originalFile when reconstructing — external interleaved edit not attributed', () => {
  const id = uniqueSessionId();
  // Truth: agent edited b->BEE, then later edited c->SEE. An external agent inserted "MID" between
  // record[0] and record[1], polluting record[1].originalFile. Reconstruction should NOT include MID.
  writeSessionLog(id, jsonl([
    { ts: ts(1), tool: 'Edit', event: 'edit_file', file_path: '/x/a.txt',
      originalFile: 'a\nb\nc\n',
      structuredPatch: singleLineHunks('a', 'b', 'BEE', 'c') },
    // Even if originalFile here lies (claims "a\nBEE\nMID\nc\n"), our algorithm uses applied-state
    // from baseline, not this field. The hunks are still based on the same context lines (BEE/c).
    { ts: ts(2), tool: 'Edit', event: 'edit_file', file_path: '/x/a.txt',
      originalFile: 'a\nBEE\nMID\nc\n',
      structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
        lines: [' a', ' BEE', '-c', '+SEE'] }] },
  ]));
  try {
    const [c] = getSessionFileChanges(id);
    assert.equal(c.mode, 'net');
    assert.doesNotMatch(c.unifiedDiff, /MID/, 'external edit must not appear in net diff');
    assert.match(c.unifiedDiff, /\+BEE/);
    assert.match(c.unifiedDiff, /\+SEE/);
  } finally {
    removeSessionLog(id);
  }
});

test('getSessionFileChanges Write→Edit yields baseline→edited content', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, jsonl([
    { ts: ts(1), tool: 'Write', event: 'write_file', file_path: '/x/a.txt',
      originalFile: 'pre\n', writtenContent: 'a\nb\nc\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 3,
        lines: ['-pre', '+a', '+b', '+c'] }] },
    { ts: ts(2), tool: 'Edit', event: 'edit_file', file_path: '/x/a.txt',
      originalFile: 'a\nb\nc\n',
      structuredPatch: singleLineHunks('a', 'b', 'BEE', 'c') },
  ]));
  try {
    const [c] = getSessionFileChanges(id);
    assert.equal(c.mode, 'net');
    // baseline = 'pre\n' from first record; final state = 'a\nBEE\nc\n'
    assert.match(c.unifiedDiff, /-pre/);
    assert.match(c.unifiedDiff, /\+BEE/);
  } finally {
    removeSessionLog(id);
  }
});

test('getSessionFileChanges Edit→Write yields baseline→writtenContent (Edit collapsed)', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, jsonl([
    { ts: ts(1), tool: 'Edit', event: 'edit_file', file_path: '/x/a.txt',
      originalFile: 'a\nb\nc\n',
      structuredPatch: singleLineHunks('a', 'b', 'BEE', 'c') },
    { ts: ts(2), tool: 'Write', event: 'write_file', file_path: '/x/a.txt',
      originalFile: 'a\nBEE\nc\n', writtenContent: 'COMPLETELY\nNEW\n',
      structuredPatch: [] },
  ]));
  try {
    const [c] = getSessionFileChanges(id);
    assert.equal(c.mode, 'net');
    assert.match(c.unifiedDiff, /-a/);
    assert.match(c.unifiedDiff, /-c/);
    assert.match(c.unifiedDiff, /\+COMPLETELY/);
    assert.match(c.unifiedDiff, /\+NEW/);
    assert.doesNotMatch(c.unifiedDiff, /BEE/, 'intermediate Edit must be collapsed under final Write');
  } finally {
    removeSessionLog(id);
  }
});

test('getSessionFileChanges Write→Write keeps only last writtenContent', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, jsonl([
    { ts: ts(1), tool: 'Write', event: 'write_file', file_path: '/x/a.txt',
      originalFile: 'orig\n', writtenContent: 'first\n', structuredPatch: [] },
    { ts: ts(2), tool: 'Write', event: 'write_file', file_path: '/x/a.txt',
      originalFile: 'first\n', writtenContent: 'second\n', structuredPatch: [] },
  ]));
  try {
    const [c] = getSessionFileChanges(id);
    assert.equal(c.mode, 'net');
    assert.match(c.unifiedDiff, /-orig/);
    assert.match(c.unifiedDiff, /\+second/);
    assert.doesNotMatch(c.unifiedDiff, /\+first/);
  } finally {
    removeSessionLog(id);
  }
});

test('getSessionFileChanges create→Edit baseline is empty (full add)', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, jsonl([
    { ts: ts(1), tool: 'Write', event: 'write_file', file_path: '/x/new.md',
      originalFile: null, writtenContent: 'a\nb\n', structuredPatch: [] },
    { ts: ts(2), tool: 'Edit', event: 'edit_file', file_path: '/x/new.md',
      originalFile: 'a\nb\n',
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
        lines: [' a', '-b', '+B'] }] },
  ]));
  try {
    const [c] = getSessionFileChanges(id);
    assert.equal(c.mode, 'net');
    assert.match(c.unifiedDiff, /\+a/);
    assert.match(c.unifiedDiff, /\+B/);
  } finally {
    removeSessionLog(id);
  }
});

test('getSessionFileChanges degrades to raw hunks when patch context is broken (Write→external→Edit)', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, jsonl([
    { ts: ts(1), tool: 'Write', event: 'write_file', file_path: '/x/a.txt',
      originalFile: '', writtenContent: 'short\n', structuredPatch: [] },
    // External overwrote file to "TOTALLY\nDIFFERENT\nlines\n"; agent's next Edit hunks reference
    // those new lines. State accumulator only has 'short\n' so apply will fail (even with fuzz).
    { ts: ts(2), tool: 'Edit', event: 'edit_file', file_path: '/x/a.txt',
      originalFile: 'TOTALLY\nDIFFERENT\nlines\n',
      structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
        lines: [' TOTALLY', '-DIFFERENT', '+CHANGED', ' lines'] }] },
  ]));
  try {
    const [c] = getSessionFileChanges(id);
    assert.equal(c.mode, 'degraded');
    assert.match(c.unifiedDiff, /external concurrent modification/);
  } finally {
    removeSessionLog(id);
  }
});

test('getSessionFileChanges yields no-diff when records lack snapshot fields (legacy compat)', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, jsonl([
    { ts: ts(1), tool: 'Edit', event: 'edit_file', file_path: '/x/legacy.txt' } as MutationLine,
  ]));
  try {
    const [c] = getSessionFileChanges(id);
    assert.equal(c.mode, 'no-diff');
    assert.equal(c.unifiedDiff, '');
  } finally {
    removeSessionLog(id);
  }
});

test('getSessionFileChanges diffDegraded flag short-circuits to no-diff', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, jsonl([
    { ts: ts(1), tool: 'Write', event: 'write_file', file_path: '/x/big.bin',
      originalFile: null, structuredPatch: [], diffDegraded: true } as MutationLine,
  ]));
  try {
    const [c] = getSessionFileChanges(id);
    assert.equal(c.mode, 'no-diff');
  } finally {
    removeSessionLog(id);
  }
});

test('getSessionFileChanges groups by (device, file_path); same path on two devices stays separate', () => {
  const id = uniqueSessionId();
  writeSessionLog(id, jsonl([
    { ts: ts(1), tool: 'Edit', event: 'edit_file', file_path: '/srv/x.md', device: 'lab',
      originalFile: 'a\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] }] },
    { ts: ts(2), tool: 'Edit', event: 'edit_file', file_path: '/srv/x.md', // local, no device
      originalFile: 'a\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+B'] }] },
  ]));
  try {
    const changes = getSessionFileChanges(id);
    assert.equal(changes.length, 2);
    const labChange = changes.find(c => c.device === 'lab')!;
    const localChange = changes.find(c => !c.device)!;
    assert.match(labChange.unifiedDiff, /\+A/);
    assert.match(localChange.unifiedDiff, /\+B/);
  } finally {
    removeSessionLog(id);
  }
});

test('renderModifiedFilesWithDiff includes device tag for remote files and degraded tag', () => {
  const out = renderModifiedFilesWithDiff([
    { file_path: '/local.md', mode: 'net', unifiedDiff: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n' },
    { file_path: '/srv/x.md', device: 'lab', mode: 'degraded', unifiedDiff: 'raw stuff' },
    { file_path: '/big.bin', mode: 'no-diff', unifiedDiff: '' },
  ]);
  assert.match(out, /### \/local\.md\n```diff/);
  assert.match(out, /### \/srv\/x\.md \(device: lab\) \[diff unavailable: external concurrent modification\]/);
  assert.match(out, /### \/big\.bin \[diff unavailable: snapshot missing\]/);
});

test('renderModifiedFilesWithDiff returns empty string when there are no changes', () => {
  assert.equal(renderModifiedFilesWithDiff([]), '');
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
