// input:  node:test, thread-manager, synthetic AgentSlotConfig and artifact
// output: coder-review template 3+2 stage transition graph e2e regression
// pos:    coder/coder-reviewer stage workflow configuration playback test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from '../src/core/utils.js';
import { threadStore } from '../src/store/thread-repo.js';
import {
  buildStepPrompt,
  createThread,
  evaluateTransitions,
  loadConfig,
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

test('coder-review template exposes 4 stage-qualified transitions + entryStage=plan', () => {
  const tpl = getTemplate('coder-review');
  assert.ok(tpl, 'coder-review template should exist after loadConfig');
  assert.equal(tpl!.entryAgent, 'coder');
  assert.equal(tpl!.entryStage, 'plan');
  const edges = tpl!.transitions.map(t => `${t.from}→${t.to}`);
  assert.deepEqual(edges.sort(), [
    'coder-reviewer:implReview→coder:retry',
    'coder:implement→coder-reviewer:implReview',
    'coder:plan→coder:implement',
    'coder:retry→coder-reviewer:implReview',
  ]);
});

// --- Entry / happy-path ---

test('coder-review entry: first step is coder:plan with a stage-specific prompt (not the legacy phase-branching blob)', () => {
  const thread = freshThread('C-entry');
  const next = resolveNextStep(thread.id)!;
  assert.equal(next.agentSlotId, 'coder');
  assert.equal(next.stage, 'plan');
  const prompt = buildStepPrompt(thread.id, next.agentConfig, next.stage);
  // Stage-specific text appears, legacy `## Phase A` branching blob does NOT.
  assert.match(prompt, /## Plan \(iteration 1\)/);
  assert.doesNotMatch(prompt, /## Phase A/);
});

test('coder-review happy path: plan → implement → implReview[IMPL-APPROVED] ends in 3 steps', async () => {
  const thread = freshThread('C-happy');

  // 1. coder:plan
  await simulateStep(thread.id, '## Plan (iteration 1)\nstep-plan\n\n');
  let transition = evaluateTransitions(thread.id);
  assert.equal(transition.shouldTransition, true);
  assert.equal(transition.nextAgent, 'coder');
  assert.equal(transition.nextStage, 'implement');

  // 2. coder:implement
  await simulateStep(thread.id, '## Implementation Summary (iteration 1)\nchanged files: a.ts\n\n');
  transition = evaluateTransitions(thread.id);
  assert.equal(transition.shouldTransition, true);
  assert.equal(transition.nextAgent, 'coder-reviewer');
  assert.equal(transition.nextStage, 'implReview');

  // 3. coder-reviewer:implReview — emits [IMPL-APPROVED] → convergence → loop ends.
  await simulateStep(thread.id, '## Impl Review (iteration 1)\nLGTM. [IMPL-APPROVED]\n');
  transition = evaluateTransitions(thread.id);
  assert.equal(transition.shouldTransition, false);
  assert.equal(transition.reason, 'converged');

  // Verify thread progressed exactly through 3 steps with the expected stages.
  const stored = threadStore.get(thread.id)!;
  assert.deepEqual(
    stored.steps.map(s => `${s.agentSlotId}:${s.stage}`),
    ['coder:plan', 'coder:implement', 'coder-reviewer:implReview'],
  );
});

// --- Retry path + iteration cap ---

test('coder-review retry path: impl review without [IMPL-APPROVED] transitions to coder:retry, then [REVISED] halts', async () => {
  const thread = freshThread('C-retry');

  await simulateStep(thread.id, '## Plan (iteration 1)\nstep-plan\n\n');
  evaluateTransitions(thread.id);
  await simulateStep(thread.id, '## Implementation Summary (iteration 1)\nfirst pass\n\n');
  evaluateTransitions(thread.id);

  // 3. reviewer blocks
  await simulateStep(thread.id, '## Impl Review (iteration 1)\nBlocker: foo\n');
  let transition = evaluateTransitions(thread.id);
  assert.equal(transition.shouldTransition, true);
  assert.equal(transition.nextAgent, 'coder');
  assert.equal(transition.nextStage, 'retry');
  assert.equal(
    threadStore.get(thread.id)!.iterationCounts['coder-reviewer:implReview→coder:retry'],
    1,
    'convergence edge counter should increment on retry transition',
  );

  // 4. coder:retry writes [REVISED] → no transition → end.
  await simulateStep(thread.id, '## Implementation Summary (iteration 2)\n## Response to Impl Review\n[REVISED]\n');
  transition = evaluateTransitions(thread.id);
  assert.equal(transition.shouldTransition, false);
  assert.equal(transition.reason, 'no_matching_transition');

  const stored = threadStore.get(thread.id)!;
  assert.deepEqual(
    stored.steps.map(s => `${s.agentSlotId}:${s.stage}`),
    ['coder:plan', 'coder:implement', 'coder-reviewer:implReview', 'coder:retry'],
  );
});

test('coder-review iteration cap: after 1 retry, a second would-retry stops with max_iterations', async () => {
  const thread = freshThread('C-cap');

  // Fast-forward through plan + implement + first implReview (Blocker) + retry
  await simulateStep(thread.id, '## Plan (iteration 1)\n'); evaluateTransitions(thread.id);
  await simulateStep(thread.id, '## Implementation Summary (iteration 1)\n'); evaluateTransitions(thread.id);
  await simulateStep(thread.id, '## Impl Review (iteration 1)\nBlocker\n');
  const t1 = evaluateTransitions(thread.id);
  assert.equal(t1.shouldTransition, true);
  // Retry writes something WITHOUT [REVISED] — simulating a missed terminator — and a reviewer picks it up.
  await simulateStep(thread.id, '## Implementation Summary (iteration 2)\nforgot revised marker\n');
  const t2 = evaluateTransitions(thread.id);
  assert.equal(t2.shouldTransition, true, 'coder:retry → implReview via output_not_contains when no [REVISED]');
  assert.equal(t2.nextStage, 'implReview');

  await simulateStep(thread.id, '## Impl Review (iteration 2)\nStill Blocker\n');
  const t3 = evaluateTransitions(thread.id);
  // Second reviewer→retry transition: counter already 1, max is 1 → max_iterations, no transition.
  assert.equal(t3.shouldTransition, false);
  assert.equal(t3.reason, 'max_iterations');
});

// --- Incremental-mode invariant across stages ---

test('coder-review incremental: second coder stage (implement) sees incremental prompt when session is live', async () => {
  const thread = freshThread('C-inc');

  // Step 1: coder:plan (first trigger, no session yet) — full bootstrap.
  const first = resolveNextStep(thread.id)!;
  const planPrompt = buildStepPrompt(thread.id, first.agentConfig, first.stage);
  assert.match(planPrompt, /Cortex Thread Protocol/);
  await simulateStep(thread.id, '## Plan (iteration 1)\n');
  evaluateTransitions(thread.id);

  // Step 2: coder:implement — coder's persistent session from step 1 is live and persistSession=true.
  // Stage has continuesSession=true, so prompt should be incremental (no directive, no preamble).
  const second = resolveNextStep(thread.id)!;
  assert.equal(second.agentSlotId, 'coder');
  assert.equal(second.stage, 'implement');
  const implPrompt = buildStepPrompt(thread.id, second.agentConfig, second.stage);
  assert.doesNotMatch(implPrompt, /Cortex Thread Protocol/);
  // The directive file content should NOT leak into the prompt body either.
  assert.doesNotMatch(implPrompt, /\n\n---\n\n/); // no prefix block separator
  // Stage-specific text appears (incremental prompt for implement stage).
  assert.match(implPrompt, /Implementation Summary \(iteration 1\)/);
});
