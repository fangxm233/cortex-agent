// input:  Vitest, thread manager, shipped reviewer directive
// output: Coder-review stage and commit-evidence policy regressions
// pos:    Verifies coder/coder-reviewer workflow and review policy
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR, DATA_DIR, DEFAULTS_DIR } from '../src/core/utils.js';
import { threadStore } from '../src/store/thread-repo.js';
import {
  buildStepPrompt,
  createThread,
  evaluateTransitions,
  loadConfig,
  mergeThreadTemplates,
  recordStepResult,
  resolveNextStep,
  getTemplate,
} from '../src/domain/threads/index.js';
import type { ThreadRecord } from '../src/core/types/thread-types.js';

// --- threads.json backup / restore so tests do not pollute production state ---

const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
let threadsBackup: string | null = null;
let threadsBackupExisted = false;
const testThreadIds = new Set<string>();

beforeAll(() => {
  try {
    threadsBackup = fs.readFileSync(THREADS_FILE, 'utf8');
    threadsBackupExisted = true;
  } catch {
    threadsBackup = null;
    threadsBackupExisted = false;
  }
  // The per-file temp CORTEX_HOME has no thread-templates when run standalone (test:file):
  // seed the shipped defaults so the coder-review template resolves, then load.
  mergeThreadTemplates(
    path.join(DEFAULTS_DIR, 'config', 'thread-templates'),
    path.join(CONFIG_DIR, 'thread-templates'),
  );
  loadConfig();
});

afterAll(async () => {
  if (threadsBackupExisted && threadsBackup != null) {
    fs.writeFileSync(THREADS_FILE, threadsBackup);
  } else {
    try { fs.unlinkSync(THREADS_FILE); } catch {}
  }
  for (const id of testThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

process.on('exit', () => {
  if (threadsBackupExisted && threadsBackup != null) {
    try { fs.writeFileSync(THREADS_FILE, threadsBackup); } catch {}
  }
});

// --- Helpers ---

/** Create a fresh coder-review thread, append a sentinel to `artifact.md` for each recorded step. */
function freshThread(channel: string): ThreadRecord {
  const thread = createThread(channel, {
    templateName: 'coder-review',
    userMessage: 'implement task X',
    userMessageTs: 'ts',
  });
  testThreadIds.add(thread.id);
  return thread;
}

/** Simulate an agent turn: write the synthetic output to artifact, record the step with that output. */
async function simulateStep(threadId: string, output: string): Promise<void> {
  const thread = threadStore.get(threadId)!;
  const next = resolveNextStep(threadId);
  if (!next) throw new Error('no next step available');
  fs.appendFileSync(thread.artifactPath, output);
  await recordStepResult(threadId, next.agentSlotId, {
    sessionId: `sess-${next.agentSlotId}-${next.stage}`,
    sessionName: `s-${next.stage}`,
    executionId: null,
    input: '',
    startedAt: new Date().toISOString(),
    output,
    costUsd: 0,
    numTurns: 1,
    durationS: 1,
    stage: next.stage,
  });
}

// --- Template structural sanity ---

test('coder-review template exposes a single stage-qualified transition + entryStage=implement', () => {
  const tpl = getTemplate('coder-review');
  assert.ok(tpl, 'coder-review template should exist after loadConfig');
  assert.equal(tpl!.entryAgent, 'coder');
  assert.equal(tpl!.entryStage, 'implement');
  const edges = tpl!.transitions.map(t => `${t.from}→${t.to}`);
  assert.deepEqual(edges, ['coder:implement→coder-reviewer:implReview']);
});

test('coder-reviewer policy accepts verified public commits without internal identifiers', () => {
  const directive = fs.readFileSync(
    path.join(DEFAULTS_DIR, 'prompts', 'directives', 'coder-reviewer.md'),
    'utf8',
  );

  assert.match(directive, /explicit SHA evidence/);
  assert.match(directive, /Missing or unverifiable attribution is a \*\*Blocker\*\*/);
  assert.match(directive, /Uncommitted changes at handoff are \*\*Blockers\*\*/);
  assert.match(directive, /repository policy forbids internal or context identifiers/);
  assert.match(directive, /must not be treated as a Blocker/);
  assert.match(directive, /must not require a metadata-only follow-up commit/);
});

test('coder-reviewer policy makes the reviewer fix the Blockers it finds', () => {
  const directive = fs.readFileSync(
    path.join(DEFAULTS_DIR, 'prompts', 'directives', 'coder-reviewer.md'),
    'utf8',
  );

  assert.match(directive, /fix every Blocker you find/);
  assert.doesNotMatch(directive, /\[IMPL-APPROVED\]/);
  assert.doesNotMatch(directive, /Plan Review/);
});

// --- Entry / happy-path ---

test('coder-review entry: first step is coder:implement with a stage-specific prompt', () => {
  const thread = freshThread('C-entry');
  const next = resolveNextStep(thread.id)!;
  assert.equal(next.agentSlotId, 'coder');
  assert.equal(next.stage, 'implement');
  const prompt = buildStepPrompt(thread.id, next.agentConfig, next.stage);
  assert.match(prompt, /## Implementation Summary/);
  assert.match(prompt, /Cortex Thread Protocol/); // fresh session → full bootstrap
});

test('coder-review happy path: implement → implReview ends in 2 steps', async () => {
  const thread = freshThread('C-happy');

  // 1. coder:implement
  await simulateStep(thread.id, '## Implementation Summary\nchanged files: a.ts\n\n');
  let transition = evaluateTransitions(thread.id);
  assert.equal(transition.shouldTransition, true);
  assert.equal(transition.nextAgent, 'coder-reviewer');
  assert.equal(transition.nextStage, 'implReview');

  // 2. coder-reviewer:implReview — reviews and fixes, then the graph is exhausted.
  await simulateStep(thread.id, '## Impl Review\nBlocker: foo — fixed in a1b2c3d.\n');
  transition = evaluateTransitions(thread.id);
  assert.equal(transition.shouldTransition, false);
  assert.equal(transition.reason, 'no_matching_transition');

  // Verify thread progressed exactly through 2 steps with the expected stages.
  const stored = threadStore.get(thread.id)!;
  assert.deepEqual(
    stored.steps.map(s => `${s.agentSlotId}:${s.stage}`),
    ['coder:implement', 'coder-reviewer:implReview'],
  );
});

test('coder-review reviewer step: no artifact marker gates the handoff to the reviewer', async () => {
  const thread = freshThread('C-nomarker');

  // A summary with no terminator of any kind still reaches the reviewer.
  await simulateStep(thread.id, '## Implementation Summary\nno markers anywhere\n');
  const transition = evaluateTransitions(thread.id);
  assert.equal(transition.shouldTransition, true);
  assert.equal(transition.nextStage, 'implReview');

  const next = resolveNextStep(thread.id)!;
  assert.equal(next.agentSlotId, 'coder-reviewer');
  const prompt = buildStepPrompt(thread.id, next.agentConfig, next.stage);
  assert.doesNotMatch(prompt, /\[IMPL-APPROVED\]/);
  assert.doesNotMatch(prompt, /\[REVISED\]/);
});
