import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MC } from '@/design/mobile-tokens';
import { MSelect, type MSelectProps } from './MSelect';

vi.mock('@/design/BottomSheet', () => ({
  MBottomSheet: ({ children, className, onClose }: { children: ReactNode; className?: string; onClose: () => void }) =>
    <div className={className} data-picker-sheet onClick={onClose}>{children}</div>,
}));

const options = [
  { value: 'one', label: 'First', description: 'First description' },
  { value: 'two', label: 'Second' },
  { value: 'locked', label: 'Unavailable', disabled: true },
];
const trigger = (view: ReactTestRenderer) => view.root.findAllByType('button')[0];
const option = (view: ReactTestRenderer, value: string) => view.root.findByProps({ 'data-m-select-option': value });
const open = (view: ReactTestRenderer) => act(() => trigger(view).props.onClick({ defaultPrevented: false }));

function mount(props: Partial<MSelectProps> = {}) {
  const onValueChange = vi.fn();
  const focus = vi.fn();
  const view = create(<MSelect title="Choice" value="one" options={options} onValueChange={onValueChange} {...props} />,
    { createNodeMock: element => element.type === 'button' ? { focus } : null });
  return { view, onValueChange, focus };
}

describe('MSelect', () => {
  it('renders a touch-sized app field with ellipsis and passthrough attributes, not a native select', () => {
    const { view } = mount({ id: 'choice', 'aria-label': 'Choose a value', style: { maxWidth: 200 } });
    const button = trigger(view);
    expect(view.root.findAllByType('select')).toHaveLength(0);
    expect(button.props).toMatchObject({ id: 'choice', title: 'Choice', type: 'button', 'aria-label': 'Choose a value', 'aria-haspopup': 'dialog', 'aria-expanded': false });
    expect(button.props.style).toMatchObject({ minHeight: 44, width: '100%', fontSize: 16, borderRadius: 8, maxWidth: 200 });
    expect(button.findAllByType('span')[0].props.style).toMatchObject({ overflow: 'hidden', textOverflow: 'ellipsis' });
    expect(button.findAllByType('span')[0].children).toEqual(['First']);
    view.unmount();
  });

  it('opens labeled rows, marks the selected value, and closes/restores focus after a pick', () => {
    const { view, onValueChange, focus } = mount();
    open(view);
    expect(trigger(view).props['aria-expanded']).toBe(true);
    expect(view.root.findByProps({ role: 'dialog' }).props.id).toBe(trigger(view).props['aria-controls']);
    expect(view.root.findByType('h2').children).toEqual(['Choice']);
    expect(option(view, 'one').props['aria-checked']).toBe(true);
    expect(option(view, 'one').props.autoFocus).toBe(true);
    expect(option(view, 'one').findAllByType('span').some(span => span.children.includes('First description'))).toBe(true);
    act(() => option(view, 'two').props.onClick());
    expect(onValueChange.mock.calls).toEqual([['two']]);
    expect(view.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    expect(focus).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('blocks disabled options and disabled triggers', () => {
    const { view, onValueChange } = mount();
    open(view);
    expect(option(view, 'locked').props.disabled).toBe(true);
    act(() => option(view, 'locked').props.onClick());
    expect(onValueChange).not.toHaveBeenCalled();
    expect(trigger(view).props['aria-expanded']).toBe(true);
    view.unmount();
    const disabled = mount({ disabled: true });
    open(disabled.view);
    expect(trigger(disabled.view).props.disabled).toBe(true);
    expect(disabled.view.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    disabled.view.unmount();
  });

  it('dismisses without writing and preserves the settings scope in the portal', () => {
    const className = 'settings-surface mobile-settings mobile-settings-sheet';
    const { view, onValueChange } = mount({ sheetClassName: className });
    open(view);
    const sheet = view.root.findByProps({ 'data-picker-sheet': true });
    expect(sheet.props.className).toBe(className);
    act(() => sheet.props.onClick());
    expect(onValueChange).not.toHaveBeenCalled();
    expect(trigger(view).props['aria-expanded']).toBe(false);
    view.unmount();
  });

  it('shows a placeholder or unknown value and supports empty-string selections', () => {
    const { view } = mount({ value: '', placeholder: 'Choose' });
    expect(trigger(view).findAllByType('span')[0].children).toEqual(['Choose']);
    expect(trigger(view).findAllByType('span')[0].props.style.color).toBe(MC.muted);
    act(() => view.update(<MSelect title="Choice" value="unknown" options={options} onValueChange={vi.fn()} />));
    expect(trigger(view).findAllByType('span')[0].children).toEqual(['unknown']);
    act(() => view.update(<MSelect title="Choice" value="" options={[{ value: '', label: 'Default' }]} onValueChange={vi.fn()} />));
    expect(trigger(view).findAllByType('span')[0].children).toEqual(['Default']);
    view.unmount();
  });

  it.each([true, 'true', 'grammar'] as const)('paints an invalid border for aria-invalid=%s', invalid => {
    const { view } = mount({ 'aria-invalid': invalid });
    expect(trigger(view).props['aria-invalid']).toBe(invalid);
    expect(trigger(view).props.style.borderColor).toBe(MC.failBorder);
    view.unmount();
  });

  it('does not treat the aria-invalid string false as invalid', () => {
    const { view } = mount({ 'aria-invalid': 'false' });
    expect(trigger(view).props.style.borderColor).toBeUndefined();
    view.unmount();
  });
});
