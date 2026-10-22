import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@radix-ui/react-popover', () => {
  const part = (name: string) => ({ children, ...props }: any) => <div data-part={name} {...props}>{children}</div>;
  return { Root: part('root'), Anchor: part('anchor'), Portal: part('portal'), Content: part('content') };
});

import { Combobox } from './Combobox';
import { preventSelectOutsideInteraction } from './select-outside-interaction';

const options = ['SessionStart', 'SessionEnd', 'ToolResult'];
function Fixture({ initial = '', disabled = false, change = vi.fn() }) {
  const [value, setValue] = useState(initial);
  return <Combobox aria-label="Event" data-hook-field="event" value={value} options={options} disabled={disabled}
    onValueChange={next => { setValue(next); change(next); }} popupClassName="settings-surface settings-select-popup" />;
}
function input(view: ReactTestRenderer) { return view.root.findByType('input'); }
function rows(view: ReactTestRenderer) { return view.root.findAllByProps({ role: 'option' }); }
function key(view: ReactTestRenderer, value: string) {
  const event = { key: value, preventDefault: vi.fn(), defaultPrevented: false, nativeEvent: {} };
  act(() => input(view).props.onKeyDown(event));
  return event;
}
function focus(view: ReactTestRenderer) { act(() => input(view).props.onFocus({})); }

describe('Combobox', () => {
  it('preserves arbitrary text and filters case-insensitive contains, showing all on exact match', () => {
    const change = vi.fn(); const view = create(<Fixture change={change} />);
    focus(view);
    expect(rows(view)).toHaveLength(3);
    act(() => input(view).props.onChange({ target: { value: 'sIoNe' } }));
    expect(rows(view).map(row => row.children.join(''))).toEqual(['SessionEnd']);
    act(() => input(view).props.onChange({ target: { value: 'sessionend' } }));
    expect(rows(view)).toHaveLength(3);
    act(() => input(view).props.onChange({ target: { value: 'custom:event' } }));
    expect(rows(view)).toHaveLength(0);
    expect(change).toHaveBeenLastCalledWith('custom:event');
    expect(input(view).props.value).toBe('custom:event');
  });

  it('opens by keyboard, navigates with active descendants and picks without submitting', () => {
    const change = vi.fn(); const view = create(<Fixture change={change} />);
    expect(input(view).props['aria-expanded']).toBe(false);
    key(view, 'ArrowDown');
    expect(input(view).props['aria-expanded']).toBe(true);
    expect(input(view).props['aria-activedescendant']).toBe(rows(view)[0].props.id);
    key(view, 'ArrowUp');
    expect(input(view).props['aria-activedescendant']).toBe(rows(view)[2].props.id);
    expect(rows(view)[2].props['aria-selected']).toBe(true);
    expect(key(view, 'Enter').preventDefault).toHaveBeenCalled();
    expect(change).toHaveBeenLastCalledWith('ToolResult');
    expect(input(view).props['aria-expanded']).toBe(false);
    expect(input(view).props['aria-activedescendant']).toBeUndefined();
  });

  it('opens on typing and leaves Enter untouched when no suggestion is active', () => {
    const view = create(<Fixture />);
    act(() => input(view).props.onChange({ target: { value: 'custom' } }));
    expect(input(view).props['aria-expanded']).toBe(true);
    expect(key(view, 'Enter').preventDefault).not.toHaveBeenCalled();
    key(view, 'ArrowDown');
    expect(input(view).props['aria-activedescendant']).toBeUndefined();
  });

  it('retains input focus on click selection and prevents popup autofocus', () => {
    const focusInput = vi.fn();
    const view = create(<Fixture />, { createNodeMock: node => node.type === 'input' ? { focus: focusInput } : null });
    focus(view);
    const preventDefault = vi.fn();
    act(() => rows(view)[1].props.onPointerDown({ preventDefault }));
    expect(preventDefault).toHaveBeenCalled();
    const content = view.root.findByProps({ 'data-part': 'content' });
    content.props.onOpenAutoFocus({ preventDefault });
    content.props.onCloseAutoFocus({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(3);
    act(() => rows(view)[1].props.onClick());
    expect(input(view).props.value).toBe('SessionEnd');
    expect(input(view).props['aria-expanded']).toBe(false);
    expect(focusInput).toHaveBeenCalledOnce();
  });

  it('keeps input interactions open but allows outside focus to dismiss', () => {
    const anchor = { focus: vi.fn() };
    const view = create(<Fixture />, { createNodeMock: node => node.type === 'input' ? anchor : null });
    focus(view);
    const content = view.root.findByProps({ 'data-part': 'content' });
    const inside = { target: anchor, preventDefault: vi.fn() };
    const outside = { target: {}, preventDefault: vi.fn() };
    content.props.onInteractOutside(inside);
    content.props.onInteractOutside(outside);
    expect(inside.preventDefault).toHaveBeenCalledOnce();
    expect(outside.preventDefault).not.toHaveBeenCalled();
    act(() => view.root.findByProps({ 'data-part': 'root' }).props.onOpenChange(false));
    expect(input(view).props['aria-expanded']).toBe(false);
  });

  it('opens an empty popup from ArrowDown without an invalid active descendant', () => {
    const view = create(<Fixture initial="custom:event" />);
    key(view, 'ArrowDown');
    expect(input(view).props['aria-expanded']).toBe(true);
    expect(rows(view)).toHaveLength(0);
    expect(input(view).props['aria-activedescendant']).toBeUndefined();
  });

  it('contains Escape at the popup layer and marks outside interaction for enclosing dialogs', () => {
    const view = create(<Fixture />); focus(view);
    const content = view.root.findByProps({ 'data-part': 'content' });
    const outside = { detail: { originalEvent: new Event('pointerdown') }, preventDefault: vi.fn() };
    content.props.onPointerDownOutside(outside);
    preventSelectOutsideInteraction(outside);
    expect(outside.preventDefault).toHaveBeenCalledOnce();
    const escape = { preventDefault: vi.fn() };
    act(() => content.props.onEscapeKeyDown(escape));
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(input(view).props['aria-expanded']).toBe(false);
  });

  it('forwards field attributes and popup styles and never opens when disabled', () => {
    const view = create(<Fixture disabled />);
    expect(input(view).props['data-hook-field']).toBe('event');
    expect(input(view).props.role).toBe('combobox');
    expect(input(view).props['aria-autocomplete']).toBe('list');
    focus(view); key(view, 'ArrowDown');
    expect(input(view).props['aria-expanded']).toBe(false);
    act(() => view.update(<Fixture />)); focus(view);
    const list = view.root.findByProps({ role: 'listbox' });
    expect(input(view).props['aria-controls']).toBe(list.props.id);
    expect(list.props.className).toContain('settings-surface settings-select-popup');
  });
});
