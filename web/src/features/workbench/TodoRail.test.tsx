// input:  task-list snapshots and persisted expand state
// output: collapsed-summary and expanded click-to-collapse interaction tests
// pos:    Tests the desktop task-list rail interaction
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodoSnapshot } from '@cortex-agent/ui-contract';
import { TodoRail } from './TodoRail';

const snapshot: TodoSnapshot = {
  items: [
    { content: 'Inspect the service', activeForm: 'Inspecting the service', status: 'in_progress' },
    { content: 'Apply the fix', activeForm: 'Applying the fix', status: 'pending' },
  ],
  total: 2,
  completed: 0,
  activeLabel: 'Inspecting the service',
  updatedAt: 1,
};

function renderExpanded() {
  const setItem = vi.fn();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: vi.fn(() => '1'),
      setItem,
    },
  });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<TodoRail sessionId="session-1" todos={snapshot} lang="en" />);
  });
  return { renderer, setItem };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TodoRail', () => {
  it('omits the summary header while expanded', () => {
    const { renderer } = renderExpanded();
    const rail = renderer.root.findByProps({ 'data-todo-rail': 'expanded' });

    const markup = JSON.stringify(renderer.toJSON());
    expect(rail.findAllByType('button')).toHaveLength(0);
    expect(markup).not.toContain('0/2');
    expect(markup).toContain('Inspecting the service');
  });

  it('collapses when any part of the expanded region is clicked', () => {
    const { renderer, setItem } = renderExpanded();
    const rail = renderer.root.findByProps({ 'data-todo-rail': 'expanded' });

    act(() => rail.props.onClick());

    expect(renderer.root.findByProps({ 'data-todo-rail': 'collapsed' })).toBeTruthy();
    expect(setItem).toHaveBeenLastCalledWith('cortex.todoRailOpen.session-1', '0');
  });
});
