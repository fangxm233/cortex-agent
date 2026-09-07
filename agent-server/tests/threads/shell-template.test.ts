// input:  Vitest, shell expander, shipped worker-review config
// output: Shell expansion and shipped dependency regressions
// pos:    Verifies generic worker-review shell expansion
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULTS_DIR } from '../../src/core/paths.js';
import { expandShell, isShellBinding } from '../../src/domain/threads/shell-templates.js';
import { rawRegistryFromDir, validateRegistry } from '../../src/domain/threads/template-validate.js';
import type { AgentDefinition, ShellDefinition } from '../../src/core/types/thread-types.js';

// --- Custom worker-review fixture with a lifecycle hook ---
const WORKER_REVIEW: ShellDefinition = {
  params: ['worker', 'reviewer'],
  agents: ['{worker}', '{reviewer}'],
  transitions: [
    { from: '{worker}:{worker.entryStage}', to: '{reviewer}', condition: { type: 'always' } },
    { from: '{reviewer}', to: '{worker}:retry', condition: { type: 'convergence', marker: '[APPROVED]', maxIterations: 1 } },
    { from: '{worker}:retry', to: '{reviewer}', condition: { type: 'output_contains', pattern: '\\[REVISED\\]' } },
  ],
  entryAgent: '{worker}',
  entryStage: '{worker.entryStage}',
  maxTotalSteps: 4,
  hooks: { onEnd: { command: 'node /custom/completion-hook.mjs', args: ['{worker}'], timeout: 10000 } },
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

test('shipped worker-review shell sends a revised retry back to its reviewer', () => {
  const shellPath = path.join(
    DEFAULTS_DIR,
    'config', 'thread-templates', 'shells', 'worker-review.json',
  );
  const shipped = JSON.parse(readFileSync(shellPath, 'utf8'));
  assert.deepEqual(shipped.transitions[2], WORKER_REVIEW.transitions[2]);
});

test('shipped thread registry has valid references and no retired plugins or completion hook', () => {
  const registry = rawRegistryFromDir(path.join(DEFAULTS_DIR, 'config/thread-templates'), {
    existsSync, readdirSync, readFileSync, join: path.join,
  });
  const results = validateRegistry(registry, {
    promptsDir: path.join(DEFAULTS_DIR, 'prompts'), pluginBaseDir: DEFAULTS_DIR,
    join: path.join, exists: existsSync, isAbsolute: path.isAbsolute,
  });
  for (const [name, result] of results) {
    assert.deepEqual(result.errors, [], name);
    assert.deepEqual(result.warnings, [], name);
  }
  assert.doesNotMatch(JSON.stringify(registry), /cortex-(common|stage-gate|coder)|post-task-hook/);
  assert.equal(existsSync(path.join(DEFAULTS_DIR, 'hooks/post-task-hook.mjs')), false);
  const shell = registry.shells['worker-review'] as ShellDefinition;
  assert.equal(shell.hooks?.onEnd, undefined);
  const out = expandShell('doc-review', {
    shell: 'worker-review', worker: 'doc-writer', reviewer: 'doc-reviewer',
  }, shell, registry.agents as Record<string, AgentDefinition>);
  assert.equal(out.hooks?.onEnd, undefined);
  assert.equal(out.transitions.length, 3);
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
      { from: `${worker}:retry`, to: reviewer, condition: { type: 'output_contains', pattern: '\\[REVISED\\]' } },
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
