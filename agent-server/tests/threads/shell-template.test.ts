// input:  Node test runner + domain/threads/shell-templates (generic interpolation engine)
// output: expandShell / isShellBinding coverage (interpolation / validation / error branches)
// pos:    DR-0017 D6 Phase 2.5 — shells are pure JSON data; the loader does GENERIC placeholder
//         interpolation + validation (no per-shell hardcoded expander). The worker-review shell
//         fixture below mirrors defaults/config/thread-templates/shells/worker-review.json.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { expandShell, isShellBinding } from '../../src/domain/threads/shell-templates.js';
import type { AgentDefinition, ShellDefinition } from '../../src/core/types/thread-types.js';

// --- worker-review shell fixture (mirrors the shipped shells/worker-review.json) ---
const WORKER_REVIEW: ShellDefinition = {
  params: ['worker', 'reviewer'],
  agents: ['{worker}', '{reviewer}'],
  transitions: [
    { from: '{worker}:{worker.entryStage}', to: '{reviewer}', condition: { type: 'always' } },
    { from: '{reviewer}', to: '{worker}:retry', condition: { type: 'convergence', marker: '[APPROVED]', maxIterations: 1 } },
    { from: '{worker}:retry', to: '{reviewer}', condition: { type: 'output_not_contains', pattern: '\\[REVISED\\]' } },
  ],
  entryAgent: '{worker}',
  entryStage: '{worker.entryStage}',
  maxTotalSteps: 4,
  hooks: { onEnd: { command: 'node ~/.cortex/hooks/post-task-hook.mjs', args: ['{worker}'], timeout: 10000 } },
};

// --- Fixture agents mirroring the real worker/reviewer agent shapes ---
function workerAgent(name: string, produceStage: string): AgentDefinition {
  return {
    name,
    profile: '__active__',
    persistSession: true,
    entryStage: produceStage,
    stages: {
      [produceStage]: { promptTemplate: `file:${name}-${produceStage}.md` },
      retry: { promptTemplate: `file:${name}-retry.md` },
    },
  };
}
function reviewerAgent(name: string): AgentDefinition {
  return { name, profile: '__active__', persistSession: true };
}

const AGENTS: Record<string, AgentDefinition> = {
  analyst: workerAgent('analyst', 'analyze'),
  'analyst-reviewer': reviewerAgent('analyst-reviewer'),
  surveyor: workerAgent('surveyor', 'survey'),
  'surveyor-reviewer': reviewerAgent('surveyor-reviewer'),
  writer: workerAgent('writer', 'write'),
  'writer-reviewer': reviewerAgent('writer-reviewer'),
  'doc-writer': workerAgent('doc-writer', 'write'),
  'doc-reviewer': reviewerAgent('doc-reviewer'),
  executor: workerAgent('executor', 'execute'),
  'executor-reviewer': reviewerAgent('executor-reviewer'),
};

// --- isShellBinding ---

test('isShellBinding distinguishes shell bindings from full templates', () => {
  assert.equal(isShellBinding({ shell: 'worker-review', worker: 'a', reviewer: 'b' }), true);
  assert.equal(isShellBinding({ name: 'x', agents: [], transitions: [], entryAgent: 'a', maxTotalSteps: 4 }), false);
  assert.equal(isShellBinding(null), false);
  assert.equal(isShellBinding('str'), false);
});

// --- Interpolation: behavior equivalence (independent golden literals) ---
// These two literals are the EXACT current defaults full templates (pre-conversion),
// pinning that shell expansion is behavior-preserving.

const GOLDEN_DOC_REVIEW = {
  name: 'doc-review',
  description: 'Generic produce-then-audit for documents (status / digest / decision / report / knowledge entry). Stages: doc-writer(write) → doc-reviewer → (if not [APPROVED]) doc-writer(retry, write [REVISED] at end) → END',
  agents: ['doc-writer', 'doc-reviewer'],
  transitions: [
    { from: 'doc-writer:write', to: 'doc-reviewer', condition: { type: 'always' } },
    { from: 'doc-reviewer', to: 'doc-writer:retry', condition: { type: 'convergence', marker: '[APPROVED]', maxIterations: 1 } },
    { from: 'doc-writer:retry', to: 'doc-reviewer', condition: { type: 'output_not_contains', pattern: '\\[REVISED\\]' } },
  ],
  entryAgent: 'doc-writer',
  entryStage: 'write',
  maxTotalSteps: 4,
  hooks: { onEnd: { command: 'node ~/.cortex/hooks/post-task-hook.mjs', args: ['doc-writer'], timeout: 10000 } },
};

const GOLDEN_EXECUTE_REVIEW = {
  name: 'execute-review',
  description: 'Execute-then-review: executor executes task → executor-reviewer audits → at most 1 retry. Suitable for any verifiable task (code changes, config changes, file edits, script execution, etc.)',
  agents: ['executor', 'executor-reviewer'],
  transitions: [
    { from: 'executor:execute', to: 'executor-reviewer', condition: { type: 'always' } },
    { from: 'executor-reviewer', to: 'executor:retry', condition: { type: 'convergence', marker: '[APPROVED]', maxIterations: 1 } },
    { from: 'executor:retry', to: 'executor-reviewer', condition: { type: 'output_not_contains', pattern: '\\[REVISED\\]' } },
  ],
  entryAgent: 'executor',
  entryStage: 'execute',
  maxTotalSteps: 4,
  hooks: { onEnd: { command: 'node ~/.cortex/hooks/post-task-hook.mjs', args: ['executor'], timeout: 10000 } },
};

test('expandShell(doc-review) equals the pre-conversion full template', () => {
  const out = expandShell('doc-review', {
    shell: 'worker-review', worker: 'doc-writer', reviewer: 'doc-reviewer',
    description: GOLDEN_DOC_REVIEW.description,
  }, WORKER_REVIEW, AGENTS);
  assert.deepEqual(out, GOLDEN_DOC_REVIEW);
});

test('expandShell(execute-review) equals the pre-conversion full template', () => {
  const out = expandShell('execute-review', {
    shell: 'worker-review', worker: 'executor', reviewer: 'executor-reviewer',
    description: GOLDEN_EXECUTE_REVIEW.description,
  }, WORKER_REVIEW, AGENTS);
  assert.deepEqual(out, GOLDEN_EXECUTE_REVIEW);
});

// --- Interpolation: structural coverage for the live-only workers ---

for (const [name, worker, reviewer, produce] of [
  ['analyst-review', 'analyst', 'analyst-reviewer', 'analyze'],
  ['surveyor-review', 'surveyor', 'surveyor-reviewer', 'survey'],
  ['writer-review', 'writer', 'writer-reviewer', 'write'],
] as const) {
  test(`expandShell(${name}) builds the standard convergence loop`, () => {
    const out = expandShell(name, { shell: 'worker-review', worker, reviewer }, WORKER_REVIEW, AGENTS);
    assert.equal(out.name, name);
    assert.deepEqual(out.agents, [worker, reviewer]);
    assert.equal(out.entryAgent, worker);
    assert.equal(out.entryStage, produce);
    assert.equal(out.maxTotalSteps, 4);
    assert.deepEqual(out.transitions, [
      { from: `${worker}:${produce}`, to: reviewer, condition: { type: 'always' } },
      { from: reviewer, to: `${worker}:retry`, condition: { type: 'convergence', marker: '[APPROVED]', maxIterations: 1 } },
      { from: `${worker}:retry`, to: reviewer, condition: { type: 'output_not_contains', pattern: '\\[REVISED\\]' } },
    ]);
    assert.deepEqual(out.hooks?.onEnd?.args, [worker]);
  });
}

test('expandShell honors a maxTotalSteps override', () => {
  const out = expandShell('x-review', { shell: 'worker-review', worker: 'analyst', reviewer: 'analyst-reviewer', maxTotalSteps: 6 }, WORKER_REVIEW, AGENTS);
  assert.equal(out.maxTotalSteps, 6);
});

test('expandShell falls back to a default description when the binding omits one', () => {
  const out = expandShell('x-review', { shell: 'worker-review', worker: 'analyst', reviewer: 'analyst-reviewer' }, WORKER_REVIEW, AGENTS);
  assert.equal(typeof out.description, 'string');
  assert.ok(out.description.length > 0);
});

// --- Error branches (the 7 validation semantics preserved from the code-expander) ---

test('missing worker param throws', () => {
  assert.throws(() => expandShell('x', { shell: 'worker-review', reviewer: 'analyst-reviewer' } as any, WORKER_REVIEW, AGENTS), /worker/i);
});

test('missing reviewer param throws', () => {
  assert.throws(() => expandShell('x', { shell: 'worker-review', worker: 'analyst' } as any, WORKER_REVIEW, AGENTS), /reviewer/i);
});

test('worker agent not found throws', () => {
  assert.throws(() => expandShell('x', { shell: 'worker-review', worker: 'ghost', reviewer: 'analyst-reviewer' }, WORKER_REVIEW, AGENTS), /agent .*ghost.* not found/i);
});

test('reviewer agent not found throws', () => {
  assert.throws(() => expandShell('x', { shell: 'worker-review', worker: 'analyst', reviewer: 'ghost' }, WORKER_REVIEW, AGENTS), /agent .*ghost.* not found/i);
});

test('worker agent without entryStage throws', () => {
  const agents = { ...AGENTS, noentry: { name: 'noentry', profile: '__active__', persistSession: true, stages: { retry: { promptTemplate: 'x' } } } as AgentDefinition };
  assert.throws(() => expandShell('x', { shell: 'worker-review', worker: 'noentry', reviewer: 'analyst-reviewer' }, WORKER_REVIEW, agents), /entryStage/i);
});

test('worker agent without retry stage throws', () => {
  const agents = { ...AGENTS, noretry: { name: 'noretry', profile: '__active__', persistSession: true, entryStage: 'go', stages: { go: { promptTemplate: 'x' } } } as AgentDefinition };
  assert.throws(() => expandShell('x', { shell: 'worker-review', worker: 'noretry', reviewer: 'analyst-reviewer' }, WORKER_REVIEW, agents), /retry/i);
});

test('unknown placeholder param throws', () => {
  const badShell: ShellDefinition = { ...WORKER_REVIEW, entryAgent: '{ghostParam}' };
  assert.throws(() => expandShell('x', { shell: 'worker-review', worker: 'analyst', reviewer: 'analyst-reviewer' }, badShell, AGENTS), /ghostParam|unknown placeholder/i);
});
