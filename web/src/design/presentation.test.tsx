// input:  Design primitives, react-test-renderer, Vitest
// output: Semantic foreground and feedback presentation checks
// pos:    Guard readable feedback and unfiltered drawer bodies
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@radix-ui/react-dialog', () => {
  const part = (name: string) => ({ children, ...props }: any) => (
    <div data-dialog-part={name} {...props}>{children}</div>
  );
  return Object.fromEntries(['Root', 'Trigger', 'Portal', 'Overlay', 'Content', 'Title', 'Description', 'Close']
    .map(name => [name, part(name)]));
});

import { Button } from './Button';
import { DegradedState } from './DegradedState';
import { Drawer } from './Drawer';
import { EmptyState } from './EmptyState';

function classes(node: { props: { className?: string } }): string {
  return node.props.className ?? '';
}

describe('Shared presentation', () => {
  it('pairs filled buttons with semantic foregrounds without suppressing keyboard outlines', () => {
    const primary = create(<Button variant="primary">Save</Button>).root.findByType('button');
    const danger = create(<Button variant="danger">Delete</Button>).root.findByType('button');
    expect(classes(primary)).toContain('text-[var(--accent-fg)]');
    expect(classes(primary)).toContain('hover:bg-proto-accent-strong');
    expect(classes(danger)).toContain('text-[var(--ink-solid-fg)]');
    expect(classes(primary)).not.toContain('outline-none');
    expect(primary.props.type).toBe('button');
  });

  it('keeps empty-state guidance opaque and actions intact', () => {
    const root = create(<EmptyState title="No entries" description="Create an entry to begin."
      action={<button>Create</button>} />).root;
    expect(classes(root.findByType('p'))).toContain('text-proto-muted');
    expect(classes(root.findByType('p'))).toContain('leading-relaxed');
    expect(root.findByType('button').children).toEqual(['Create']);
  });

  it('preserves recovery details, metadata and actions without dimming the metadata', () => {
    const root = create(<DegradedState severity="human" title="Unavailable" meta="Retry now"
      detail="Check the connection." actions={<button>Retry</button>} />).root;
    const meta = root.findAllByType('span').find(node => node.children.includes('Retry now'))!;
    expect(classes(meta)).not.toContain('opacity-');
    expect(root.findAllByType('div').some(node => classes(node).includes('text-proto-ink-2'))).toBe(true);
    expect(root.findByType('button').children).toEqual(['Retry']);
  });

  it('keeps blur on the drawer sheet and preserves its dialog wiring', () => {
    const onOpenChange = vi.fn();
    const root = create(<Drawer title="Details" description="More information" side="left" open
      onOpenChange={onOpenChange} footer={<button>Done</button>}><p>Body</p></Drawer>).root;
    const part = (name: string) => root.findByProps({ 'data-dialog-part': name });
    expect(part('Root').props.onOpenChange).toBe(onOpenChange);
    expect(part('Root').props.open).toBe(true);
    expect(classes(part('Content'))).toContain('left-0');
    expect(classes(part('Content'))).toContain('[backdrop-filter:var(--glass-filter)]');
    expect(classes(part('Close'))).not.toContain('outline-none');
    const body = root.findAllByType('div').find(node => classes(node).includes('overflow-y-auto'))!;
    expect(classes(body)).not.toContain('backdrop-filter');
    expect(root.findByType('button').children).toEqual(['Done']);
  });
});
