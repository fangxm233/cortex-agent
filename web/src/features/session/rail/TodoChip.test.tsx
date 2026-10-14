import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodoSnapshot } from '@cortex-agent/ui-contract';
import { ActivityStrip } from './ActivityStrip';

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
const done: TodoSnapshot = {
  items: snapshot.items.map((item) => ({ ...item, status: 'completed' })),
  total: 2, completed: 2, activeLabel: null, updatedAt: 2,
};

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

function mount(todos: TodoSnapshot | null, running = true): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<ActivityStrip todos={todos} running={running} waitpoints={null} lang="en" />); });
  return renderer;
}

const chip = (r: ReactTestRenderer) => r.root.findByProps({ 'data-activity-chip': 'todo' });
const popovers = (r: ReactTestRenderer) => r.root.findAll((n) => n.type === 'div' && n.props['data-activity-popover'] !== undefined);

describe('task capsule', () => {
  it('renders nothing without a task list', () => {
    expect(mount(null).toJSON()).toBeNull();
  });

  it('summarizes position and the current task on one line', () => {
    const r = mount(snapshot);
    expect(chip(r).props['aria-label']).toBe('Task list · 1/2 · Inspecting the service');
    expect(chip(r).props['aria-expanded']).toBe(false);
    expect(popovers(r)).toHaveLength(0);
  });

  it('opens the whole list above the composer and closes it again', () => {
    const r = mount(snapshot);
    act(() => chip(r).props.onClick({ stopPropagation: vi.fn() }));
    expect(chip(r).props['aria-expanded']).toBe(true);
    expect(popovers(r)).toHaveLength(1);
    expect(JSON.stringify(r.toJSON())).toContain('Apply the fix');
    act(() => chip(r).props.onClick({ stopPropagation: vi.fn() }));
    expect(popovers(r)).toHaveLength(0);
  });

  it('keeps a finished list up only while its turn runs', () => {
    expect(chip(mount(done, true)).props['aria-label']).toBe('Task list · 2/2');
    expect(mount(done, false).toJSON()).toBeNull();
  });
});
