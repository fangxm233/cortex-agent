import { create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { Button } from './Button';
import { Card } from './Card';
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

  it('gives cards unblurred material', () => {
    const glass = create(<Card padded>Details</Card>).root.findByType('div');
    expect(classes(glass)).toContain('[background:var(--material-card-bg)]');
    expect(classes(glass)).toContain('shadow-[shadow:var(--material-card-shadow)]');
    expect(classes(glass)).not.toContain('backdrop-filter');
    expect(classes(glass)).toContain('p-2g');
  });

  it('gives controls flat materials without boxing ghost actions', () => {
    const secondary = create(<Button>Cancel</Button>).root.findByType('button');
    const ghost = create(<Button variant="ghost">More</Button>).root.findByType('button');
    expect(classes(secondary)).toContain('[background:var(--material-control-bg)]');
    expect(classes(secondary)).not.toContain('backdrop-filter');
    expect(classes(ghost)).not.toContain('material-');
  });

  it('keeps empty-state guidance opaque and actions intact', () => {
    const root = create(<EmptyState title="No entries" description="Create an entry to begin."
      action={<button>Create</button>} />).root;
    expect(classes(root.findByType('p'))).toContain('text-proto-muted');
    expect(classes(root.findByType('p'))).toContain('leading-relaxed');
    expect(root.findByType('button').children).toEqual(['Create']);
  });
});
