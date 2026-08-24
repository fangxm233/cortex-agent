// input:  raw session.todos payloads and task-list snapshots
// output: payload validation and rail row model tests
// pos:    Tests the task-list view model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { TodoSnapshot } from '@cortex-agent/ui-contract';
import { resolveTodos, todoRailViewModel, todoSnapshotFromLivePayload } from './todo-vm';

const snapshot: TodoSnapshot = {
  items: [
    { content: 'Read the adapter', activeForm: 'Reading the adapter', status: 'completed' },
    { content: 'Run the tests', activeForm: 'Running the tests', status: 'in_progress' },
    { content: 'Write the docs', activeForm: 'Writing the docs', status: 'pending' },
  ],
  total: 3,
  completed: 1,
  activeLabel: 'Running the tests',
  updatedAt: 1,
};

describe('todoSnapshotFromLivePayload', () => {
  it('accepts a well-formed event payload', () => {
    expect(todoSnapshotFromLivePayload({ snapshot })).toEqual(snapshot);
  });

  it('rejects anything that is not a task-list payload', () => {
    for (const bad of [null, undefined, 7, 'x', {}, { snapshot: null }, { snapshot: {} }]) {
      expect(todoSnapshotFromLivePayload(bad)).toBeNull();
    }
  });

  it('rejects a payload with an unknown item status rather than coercing it', () => {
    // Coercing here would let a server/client version skew silently render wrong progress; the
    // adapter already normalizes, so anything unexpected on the wire is a contract break.
    expect(todoSnapshotFromLivePayload({
      snapshot: { ...snapshot, items: [{ content: 'a', activeForm: 'a', status: 'blocked' }] },
    })).toBeNull();
  });

  it('rejects negative or non-numeric counters', () => {
    expect(todoSnapshotFromLivePayload({ snapshot: { ...snapshot, completed: -1 } })).toBeNull();
    expect(todoSnapshotFromLivePayload({ snapshot: { ...snapshot, total: '3' } })).toBeNull();
  });

  it('keeps a null activeLabel, which means nothing is in progress', () => {
    const idle = { ...snapshot, activeLabel: null };
    expect(todoSnapshotFromLivePayload({ snapshot: idle })?.activeLabel).toBeNull();
  });
});

describe('resolveTodos', () => {
  it('prefers the live event over the list snapshot', () => {
    const older = { ...snapshot, completed: 0 };
    expect(resolveTodos(snapshot, older)).toBe(snapshot);
  });

  it('falls back to the snapshot before any event arrives', () => {
    expect(resolveTodos(null, snapshot)).toBe(snapshot);
    expect(resolveTodos(null, null)).toBeNull();
    expect(resolveTodos(null, undefined)).toBeNull();
  });
});

describe('todoRailViewModel', () => {
  it('renders nothing when there is no list, so the composer keeps its space', () => {
    expect(todoRailViewModel(null)).toBeNull();
    expect(todoRailViewModel({ ...snapshot, items: [], total: 0, completed: 0 })).toBeNull();
  });

  it('labels in-progress rows with the continuous form and the rest with the imperative', () => {
    const vm = todoRailViewModel(snapshot)!;
    expect(vm.rows.map((r) => r.text)).toEqual([
      'Read the adapter', 'Running the tests', 'Write the docs',
    ]);
    expect(vm.counts).toBe('1/3');
    expect(vm.activeLabel).toBe('Running the tests');
    expect(vm.allDone).toBe(false);
  });

  it('drops the connector tail on the last row only', () => {
    expect(todoRailViewModel(snapshot)!.rows.map((r) => r.hasTail)).toEqual([true, true, false]);
  });

  it('flags an all-complete list so the rail can switch to the success tone', () => {
    const done: TodoSnapshot = {
      items: snapshot.items.map((i) => ({ ...i, status: 'completed' })),
      total: 3, completed: 3, activeLabel: null, updatedAt: 2,
    };
    expect(todoRailViewModel(done)!.allDone).toBe(true);
  });
});
