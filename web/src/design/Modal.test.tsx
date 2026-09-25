// input:  Modal, react-test-renderer, Vitest
// output: Modal materials, layers and portal styling checks
// pos:    Verify material dialogs preserve bare and nested modes
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
  it('applies material only to standard chrome while retaining nested layers', () => {
    const standard = create(<Modal open title="Example" layer="nested"><p>Body</p></Modal>).root;
    const content = standard.findByProps({ 'data-radix-part': 'Content' });
    const overlay = standard.findByProps({ 'data-radix-part': 'Overlay' });
    expect(content.props.className).toContain('[background:var(--material-overlay-bg)]');
    expect(content.props.className).toContain('z-[90]');
    expect(overlay.props.className).toContain('z-[80]');
    expect(overlay.props.className).toContain('[backdrop-filter:var(--material-scrim-filter)]');
    expect(standard.findByProps({ 'data-modal-body': true }).props.className).not.toContain('backdrop-filter');
    const bare = create(<Modal open title="Example" chrome="bare" layer="nested" />).root;
    const bareContent = bare.findByProps({ 'data-radix-part': 'Content' });
    expect(bareContent.props.style.zIndex).toBe(90);
    expect(bareContent.props.className).not.toContain('material-');
    expect(bare.findByProps({ 'data-radix-part': 'Overlay' }).props.style.zIndex).toBe(80);
  });

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
