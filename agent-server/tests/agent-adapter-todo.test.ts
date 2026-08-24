// input:  raw TodoWrite payloads and native tool names
// output: snapshot parsing, degradation and progress-rendering tests
// pos:    Tests the backend-neutral TodoWrite normalization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseTodoSnapshot,
  parseTodoWrite,
  parseTodoWriteByName,
  renderTodoProgress,
} from '../src/agent-adapter/normalize/todo.js';

const THREE = {
  todos: [
    { content: 'Read the adapter', activeForm: 'Reading the adapter', status: 'completed' },
    { content: 'Run the test suite', activeForm: 'Running the test suite', status: 'in_progress' },
    { content: 'Write the docs', activeForm: 'Writing the docs', status: 'pending' },
  ],
};

test('parses a well-formed list and derives its counters', () => {
  const snap = parseTodoSnapshot(THREE, 1000);
  assert.ok(snap);
  assert.equal(snap.total, 3);
  assert.equal(snap.completed, 1);
  assert.equal(snap.activeLabel, 'Running the test suite');
  assert.equal(snap.updatedAt, 1000);
  assert.equal(snap.items[2].status, 'pending');
});

test('an explicitly empty list is a valid snapshot, not a parse failure', () => {
  // The agent clearing its plan must reach the surfaces so they can hide, which a null
  // (indistinguishable from "no TodoWrite happened") would not do.
  const snap = parseTodoSnapshot({ todos: [] });
  assert.ok(snap);
  assert.equal(snap.total, 0);
  assert.equal(snap.activeLabel, null);
});

test('payloads that are not task lists degrade to null instead of throwing', () => {
  for (const bad of [null, undefined, 42, 'todos', {}, { todos: 'nope' }, { todos: null }]) {
    assert.equal(parseTodoSnapshot(bad), null);
  }
});

test('malformed entries never overstate progress', () => {
  const snap = parseTodoSnapshot({
    todos: [
      { content: 'No status at all' },
      { content: 'Bogus status', status: 'finished' },
      { content: 'Real one', activeForm: 'Doing it', status: 'completed' },
      null,
      'garbage',
    ],
  });
  assert.ok(snap);
  // Two salvageable entries plus the valid one; the unknown statuses count as pending, never done.
  assert.equal(snap.total, 3);
  assert.equal(snap.completed, 1);
});

test('a missing activeForm falls back to content so the label is never blank', () => {
  const snap = parseTodoSnapshot({ todos: [{ content: 'Ship it', status: 'in_progress' }] });
  assert.equal(snap?.activeLabel, 'Ship it');
});

test('multiple in-progress entries resolve to the first, without error', () => {
  const snap = parseTodoSnapshot({
    todos: [
      { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
    ],
  });
  assert.equal(snap?.activeLabel, 'Doing A');
});

test('only TodoWrite is recognized, under either backend spelling', () => {
  assert.ok(parseTodoWrite('claude', 'TodoWrite', THREE));
  assert.ok(parseTodoWrite('pi', 'todo_write', THREE));
  assert.equal(parseTodoWrite('claude', 'Bash', THREE), null);
  // The backendless form is what the shared continuation path uses.
  assert.ok(parseTodoWriteByName('TodoWrite', THREE));
  assert.ok(parseTodoWriteByName('todo_write', THREE));
  assert.equal(parseTodoWriteByName('Write', THREE), null);
});

test('progress rendering is compact, truncated, and empty when there is nothing to show', () => {
  assert.equal(renderTodoProgress(parseTodoSnapshot(THREE)), '1/3 · Running the test suite');
  assert.equal(renderTodoProgress(null), '');
  assert.equal(renderTodoProgress(parseTodoSnapshot({ todos: [] })), '');
  // Nothing in progress → counts only.
  const done = parseTodoSnapshot({ todos: [{ content: 'A', activeForm: 'A', status: 'completed' }] });
  assert.equal(renderTodoProgress(done), '1/1');
  const long = parseTodoSnapshot({
    todos: [{ content: 'x', activeForm: 'A'.repeat(80), status: 'in_progress' }],
  });
  const rendered = renderTodoProgress(long, 20);
  assert.ok(rendered.endsWith('…'));
  assert.ok(rendered.length <= '1/1 · '.length + 20);
});
