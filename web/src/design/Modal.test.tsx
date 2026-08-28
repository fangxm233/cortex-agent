// input:  Modal chrome, sizing, layers, visibility, styles, and passive data hooks
// output: Standard compatibility and accessible bare-dialog primitive regressions
// pos:    Shared Modal behavior specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { create, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@radix-ui/react-dialog', () => {
  const part = (name: string) => ({ children, ...props }: any) => (
    <div data-radix-part={name} {...props}>{children}</div>
  );
  return {
    Root: part('root'), Trigger: part('trigger'), Portal: part('portal'),
    Overlay: part('overlay'), Content: part('content'), Title: part('title'),
    Description: part('description'), Close: part('close'),
  };
});

import { Modal, modalContentClass, modalOverlayClass } from './Modal';

function part(root: ReactTestInstance, name: string): ReactTestInstance {
  return root.find((node) => node.props['data-radix-part'] === name);
}

describe('Modal standard chrome', () => {
  it('keeps the existing default classes, body scroll, and visible close control', () => {
    const tree = create(<Modal title="Details">Body</Modal>).root;

    expect(part(tree, 'overlay').props.className).toBe(modalOverlayClass('default'));
    expect(part(tree, 'content').props.className).toBe(modalContentClass('default', 'default'));
    expect(part(tree, 'title').props.className).toContain('text-body');
    expect(part(tree, 'close')).toBeTruthy();
    expect(part(tree, 'content').findByProps({ 'data-modal-body': true }).props.className)
      .toContain('overflow-y-auto');
  });

  it('supports custom width without changing the standard content chrome', () => {
    const className = modalContentClass('custom', 'nested');
    expect(className).toContain('rounded-card');
    expect(className).toContain('z-[90]');
    expect(className).not.toContain('max-w-lg');
    expect(className).not.toContain('max-w-3xl');
  });
});

describe('Modal bare chrome', () => {
  it('keeps Radix portal, overlay, hidden semantics, and controlled state ownership', () => {
    const onOpenChange = vi.fn();
    const tree = create(
      <Modal chrome="bare" size="custom" open title="Run history" description="Recent runs"
        showClose={false} onOpenChange={onOpenChange}>Rows</Modal>,
    ).root;

    expect(part(tree, 'root').props.open).toBe(true);
    expect(part(tree, 'root').props.onOpenChange).toBe(onOpenChange);
    expect(part(tree, 'portal')).toBeTruthy();
    expect(part(tree, 'overlay')).toBeTruthy();
    expect(part(tree, 'title').props.className).toBe('sr-only');
    expect(part(tree, 'description').props.className).toBe('sr-only');
    expect(tree.findAll((node) => node.props['data-radix-part'] === 'close')).toHaveLength(0);
  });

  it('applies only narrow style and data seams to bare overlay, content, and body', () => {
    const tree = create(
      <Modal chrome="bare" size="custom" layer="nested" title="Task" showClose={false}
        contentStyle={{ width: 760, background: 'var(--proto-alt)' }}
        bodyStyle={{ display: 'contents' }}
        contentDataAttributes={{ 'data-task-modal-id': 'T-9' }}
        overlayDataAttributes={{ 'data-backdrop': 'task' }}>
        Body
      </Modal>,
    ).root;
    const overlay = part(tree, 'overlay');
    const content = part(tree, 'content');
    const body = content.findByProps({ 'data-modal-body': true });

    expect(overlay.props['data-backdrop']).toBe('task');
    expect(overlay.props.style).toMatchObject({ background: 'var(--overlay-scrim)', zIndex: 80 });
    expect(content.props['data-task-modal-id']).toBe('T-9');
    expect(content.props.style).toMatchObject({ width: 760, background: 'var(--proto-alt)', zIndex: 90 });
    expect(content.props.className).not.toContain('rounded-card');
    expect(body.props.style).toEqual({ display: 'contents' });
  });
});
