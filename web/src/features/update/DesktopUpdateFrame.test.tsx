// input:  desktop frame slots, close callback, and lightweight Radix primitives
// output: preserved modal chrome, animation classes, accessibility link, and close semantics
// pos:    Desktop-only shared update frame characterization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@radix-ui/react-dialog', () => ({
  Root: ({ children, ...props }: any) => <div data-radix-root {...props}>{children}</div>,
  Portal: ({ children }: any) => <>{children}</>,
  Overlay: (props: any) => <div data-radix-overlay {...props} />,
  Content: ({ children, ...props }: any) => <section data-radix-content {...props}>{children}</section>,
  Title: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Description: ({ children, ...props }: any) => <p {...props}>{children}</p>,
}));

import { DesktopUpdateFrame } from './DesktopUpdateFrame';

const props = {
  title: '新版本已就绪',
  summary: 'a → b · 8.4 MB',
  descriptionId: 'hot-update-desc',
  description: '后台下载完成。',
  onDismiss: vi.fn(),
};

describe('DesktopUpdateFrame', () => {
  it('preserves the desktop frame and shared header DOM', () => {
    const renderer = create(<DesktopUpdateFrame {...props}><button>Apply</button></DesktopUpdateFrame>);
    const overlay = renderer.root.findByProps({ 'data-radix-overlay': true });
    const content = renderer.root.findByProps({ 'data-radix-content': true });

    expect(overlay.props.className).toContain('bg-state-ink/[0.44]');
    expect(overlay.props.className).toContain('data-[state=open]:animate-fade-in');
    expect(content.props.className).toContain('w-[420px]');
    expect(content.props.className).toContain('data-[state=open]:animate-zoom-in');
    expect(content.props['aria-describedby']).toBe('hot-update-desc');
    expect(renderer.root.findByType('p').children).toEqual(['后台下载完成。']);
    expect(renderer.root.findByType('svg').props.width).toBe('16');
  });

  it('maps Radix close requests to dismissal', () => {
    props.onDismiss.mockClear();
    const renderer = create(<DesktopUpdateFrame {...props}>body</DesktopUpdateFrame>);
    const root = renderer.root.findByProps({ 'data-radix-root': true });
    act(() => root.props.onOpenChange(true));
    expect(props.onDismiss).not.toHaveBeenCalled();
    act(() => root.props.onOpenChange(false));
    expect(props.onDismiss).toHaveBeenCalledOnce();
  });
});
