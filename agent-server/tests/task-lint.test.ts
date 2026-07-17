// input:  Node test runner + lintTasks unit
// output: validates unknown-template lint error gating
// pos:    Ensure lint throws error when X in [template:X] does not exist
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { lintTasks } from '../src/domain/tasks/lint.js';

function task(overrides: Record<string, any>) {
  return {
    id: 'h1',
    text: 'sample',
    project: 'demo',
    status: 'open' as const,
    why: 'why',
    done_when: 'done',
    template: '',
    plan: 'plan-id',
    priority: 'medium' as const,
    depends_on: [],
    gpu: null,
    gpu_count: 1,
    paused: false,
    claimed_by: null,
    claimed_at: null,
    blocked_by: null,
    approval_needed: false,
    approved_at: null,
    not_before: null,
    completed_at: null,
    completed_note: null,
    parent: null,
    pending_at: null,
    origin_session_id: null,
    origin_channel: null,
    origin_thread_id: null,
    ...overrides,
  };
}

test('lintTasks flags unknown-template error when validTemplateNames provided', () => {
  const tasks = [
    task({ id: 'aa', template: 'nonexistent' }),
    task({ id: 'bb', template: 'default' }),
  ];
  const result = lintTasks(tasks, { validTemplateNames: new Set(['default', 'scheduler']) });
  const unknown = result.errors.filter((e) => e.code === 'unknown-template');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].task_id, 'aa');
  assert.equal(unknown[0].template, 'nonexistent');
  assert.equal(result.ok, false);
});

test('lintTasks does not flag unknown-template when options omitted (back-compat)', () => {
  const tasks = [task({ id: 'aa', template: 'nonexistent' })];
  const result = lintTasks(tasks);
  assert.equal(result.errors.filter((e) => e.code === 'unknown-template').length, 0);
});

test('lintTasks does not flag unknown-template when validTemplateNames is null/empty', () => {
  const tasks = [task({ id: 'aa', template: 'nonexistent' })];
  const r1 = lintTasks(tasks, { validTemplateNames: null });
  assert.equal(r1.errors.filter((e) => e.code === 'unknown-template').length, 0);
});

test('lintTasks does not flag unknown-template on completed tasks', () => {
  const tasks = [task({ id: 'aa', template: 'nonexistent', status: 'done' })];
  const result = lintTasks(tasks, { validTemplateNames: new Set(['default']) });
  assert.equal(result.errors.filter((e) => e.code === 'unknown-template').length, 0);
});
