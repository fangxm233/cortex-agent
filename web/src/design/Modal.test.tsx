// input:  Modal, react-test-renderer, Vitest
// output: Modal portaled styling regression checks
// pos:    Verify optional dialog scope without global changes
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@radix-ui/react-dialog', () => {
  const part = (name: string) => ({ children, ...props }: any) => (
    <div data-radix-part={name} {...props}>{children}</div>
  );
  return Object.fromEntries(['Root', 'Portal', 'Overlay', 'Content', 'Title', 'Description', 'Close', 'Trigger']
    .map((name) => [name, part(name)]));
});

import { Modal } from './Modal';

describe('Modal portal scope', () => {
  it.each(['standard', 'bare'] as const)('preserves the %s defaults and supports local content styles', (chrome) => {
    const plain = create(<Modal open title="Example" chrome={chrome} />);
    expect(plain.root.findByProps({ 'data-radix-part': 'Content' }).props.className).not.toContain('settings-surface');
    const scoped = create(<Modal open title="Example" chrome={chrome} layer="nested"
      contentClassName="settings-surface settings-nested-modal" />);
    const content = scoped.root.findByProps({ 'data-radix-part': 'Content' });
    expect(content.props.className).toContain('settings-surface settings-nested-modal');
    expect(content.props.contentClassName).toBeUndefined();
  });
});
