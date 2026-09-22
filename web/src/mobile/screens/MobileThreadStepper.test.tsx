// input:  React test renderer, mobile stepper and pill models
// output: Inline thread navigation and presentation tests
// pos:    Guard mobile stepper navigation and label alignment
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { threadPill } from '@/features/workbench/thread-card-proto';
import { MobileThreadStepper } from './MobileThreadStepper';
import type { MobileStepper } from './mobile-session-vm';

const card: MobileStepper = {
  name: 'coder-review-fix',
  pillText: 'coder 2/3',
  nodes: [
    { label: 'plan', state: 'done' },
    { label: 'coder', state: 'running' },
    { label: 'review', state: 'pending' },
  ],
  footer: { elapsed: '8m', cost: '$0.42', subCount: 2 },
};

function render(stepper: MobileStepper, onOpen: () => void): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MobileThreadStepper card={stepper} pill={threadPill('running')} running
        subthreadsLabel="sub-threads" openLabel="Open" onOpen={onOpen} />,
    );
  });
  return renderer;
}

// The `Open →` link is gone; losing it would silently strip the only way into the thread.
describe('MobileThreadStepper navigation', () => {
  it('opens the thread from a tap anywhere on the card', () => {
    const onOpen = vi.fn();
    const renderer = render(card, onOpen);
    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('opens the thread from the keyboard', () => {
    const onOpen = vi.fn();
    const renderer = render(card, onOpen);
    const node = renderer.root.findByProps({ role: 'button' });
    act(() => node.props.onKeyDown({ key: 'Enter' }));
    act(() => node.props.onKeyDown({ key: 'Escape' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('MobileThreadStepper labels', () => {
  it('keeps long labels in columns aligned with their progress bars', () => {
    const renderer = render({ ...card, nodes: card.nodes.map((node) => ({ ...node, label: node.label.repeat(20) })) }, vi.fn());
    const grid = renderer.root.findAllByType('div').find((node) => node.props.style?.display === 'grid');
    expect(grid?.props.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    expect(renderer.root.findByProps({ role: 'button' }).props.style.overflowWrap).toBe('anywhere');
    renderer.unmount();
  });

  it('marks done steps, clocks the running one and keeps cost/sub-threads', () => {
    const rendered = JSON.stringify(render(card, vi.fn()).toJSON());
    expect(rendered).toContain('plan ✓');
    expect(rendered).toContain('coder · 8m');
    expect(rendered).toContain('review');
    expect(rendered).toContain('$0.42 · 2 sub-threads');
  });

  it('keeps elapsed in the meta line when no step is running', () => {
    const settled: MobileStepper = {
      ...card,
      nodes: card.nodes.map((node) => ({ ...node, state: 'pending' as const })),
    };
    expect(JSON.stringify(render(settled, vi.fn()).toJSON())).toContain('8m · $0.42 · 2 sub-threads');
  });
});
