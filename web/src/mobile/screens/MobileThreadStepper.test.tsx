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
