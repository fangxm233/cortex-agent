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

  it('collapses when any part of the expanded region is clicked', () => {
    const { renderer, setItem } = renderExpanded();
    const rail = renderer.root.findByProps({ 'data-todo-rail': 'expanded' });

    act(() => rail.props.onClick());

    expect(renderer.root.findByProps({ 'data-todo-rail': 'collapsed' })).toBeTruthy();
    expect(setItem).toHaveBeenLastCalledWith('cortex.todoRailOpen.session-1', '0');
  });
});
