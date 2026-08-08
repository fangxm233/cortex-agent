// input:  G5-W5's ten strict broker argument schemas
// output: required/type/non-empty/nested-strict/code-point boundary tests
// pos:    Exact model-facing argument contract tests for the task broker
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { describe, expect, it } from 'vitest';

import type { BenchmarkBrokerCapability } from '../../../src/domain/benchmark/capabilities.js';
import {
  BrokerArgumentsError, assertBrokerArguments,
} from '../../../src/domain/benchmark/task-broker-arguments.js';

type PayloadCase = readonly [string, BenchmarkBrokerCapability, Record<string, unknown>];

function expectInvalid(cases: readonly PayloadCase[]): void {
  for (const [label, action, payload] of cases) {
    expect(() => assertBrokerArguments(action, payload), label).toThrow(BrokerArgumentsError);
  }
}

describe('§18 G5-W5 strict broker argument schemas', () => {
  it('requires every mandatory field and rejects wrong value types for all ten actions', () => {
    expectInvalid([
      ['read.task_id', 'task.read', { task_id: 1 }],
      ['create.text', 'task.create', {}],
      ['decompose.subtask.text', 'task.decompose', { subtasks: [{}] }],
      ['claim.task_id', 'task.claim', {}],
      ['propose_complete.note', 'task.propose_complete', { note: 1 }],
      ['propose_block.reason', 'task.propose_block', {}],
      ['artifact.content', 'artifact.write', { content: null }],
      ['dependency.task_id', 'dependency.declare', { depends_on: ['dddd'] }],
      ['ask.question', 'qa.ask', {}],
      ['answer.answer', 'qa.answer', { question_id: 'q1' }],
    ]);
  });

  it('enforces non-empty arrays and strict top-level and nested objects', () => {
    expectInvalid([
      ['create.depends_on[]', 'task.create', { text: 'x', depends_on: [1] }],
      ['create.undeclared', 'task.create', { text: 'x', undeclared: true }],
      ['decompose.nonempty', 'task.decompose', { subtasks: [] }],
      ['decompose.strict', 'task.decompose', { subtasks: [{ text: 'x', undeclared: true }] }],
      ['dependency.nonempty', 'dependency.declare', { task_id: 'aaaa', depends_on: [] }],
      ['dependency.depends_on[]', 'dependency.declare', { task_id: 'aaaa', depends_on: [1] }],
    ]);
  });

  it('bounds every string field to 2,000 Unicode code points', () => {
    const over = 'x'.repeat(2_001);
    expectInvalid([
      ['read.task_id', 'task.read', { task_id: over }],
      ['create.text', 'task.create', { text: over }],
      ['create.why', 'task.create', { text: 'x', why: over }],
      ['create.done_when', 'task.create', { text: 'x', done_when: over }],
      ['create.template', 'task.create', { text: 'x', template: over }],
      ['create.priority', 'task.create', { text: 'x', priority: over }],
      ['create.plan', 'task.create', { text: 'x', plan: over }],
      ['create.depends_on[]', 'task.create', { text: 'x', depends_on: [over] }],
      ['decompose.key', 'task.decompose', { subtasks: [{ key: over, text: 'x' }] }],
      ['decompose.text', 'task.decompose', { subtasks: [{ text: over }] }],
      ['decompose.template', 'task.decompose', { subtasks: [{ text: 'x', template: over }] }],
      ['decompose.why', 'task.decompose', { subtasks: [{ text: 'x', why: over }] }],
      ['decompose.done_when', 'task.decompose', { subtasks: [{ text: 'x', done_when: over }] }],
      ['decompose.priority', 'task.decompose', { subtasks: [{ text: 'x', priority: over }] }],
      ['decompose.plan', 'task.decompose', { subtasks: [{ text: 'x', plan: over }] }],
      ['decompose.depends_on[]', 'task.decompose', { subtasks: [{ text: 'x', depends_on: [over] }] }],
      ['claim.task_id', 'task.claim', { task_id: over }],
      ['propose_complete.note', 'task.propose_complete', { note: over }],
      ['propose_block.reason', 'task.propose_block', { reason: over }],
      ['artifact.content', 'artifact.write', { content: over }],
      ['dependency.task_id', 'dependency.declare', { task_id: over, depends_on: ['dddd'] }],
      ['dependency.depends_on[]', 'dependency.declare', { task_id: 'aaaa', depends_on: [over] }],
      ['ask.question', 'qa.ask', { question: over }],
      ['answer.question_id', 'qa.answer', { question_id: over, answer: 'a' }],
      ['answer.answer', 'qa.answer', { question_id: 'q1', answer: over }],
    ]);
  });

  it('counts Unicode code points rather than UTF-16 code units at the boundary', () => {
    expect(() => assertBrokerArguments('artifact.write', {
      content: '😀'.repeat(2_000),
    })).not.toThrow();
    expect(() => assertBrokerArguments('artifact.write', {
      content: '😀'.repeat(2_001),
    })).toThrow(BrokerArgumentsError);
  });
});
