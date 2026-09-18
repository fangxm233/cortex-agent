import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@radix-ui/react-select', () => {
  const part = (name: string) => ({ children, ...props }: any) => (
    <div data-radix-part={name} {...props}>{children}</div>
  );
  return {
    Root: part('root'),
    Trigger: part('trigger'),
    Value: part('value'),
    Icon: part('icon'),
    Portal: part('portal'),
    Content: part('content'),
    Viewport: part('viewport'),
    Item: part('item'),
    ItemText: part('item-text'),
    ItemIndicator: part('item-indicator'),
    ScrollUpButton: part('scroll-up'),
    ScrollDownButton: part('scroll-down'),
  };
});

import { Select, type SelectOption } from './Select';

function mount<T extends string | number>(
  value: T,
  options: readonly SelectOption<T>[],
  onValueChange = vi.fn(),
): ReactTestRenderer {
  return create(
    <Select
      data-field="fixture"
      aria-label="Fixture choice"
      value={value}
      options={options}
      onValueChange={onValueChange}
    />,
  );
}

function part(renderer: ReactTestRenderer, name: string) {
  return renderer.root.findByProps({ 'data-radix-part': name });
}

describe('Select', () => {
  it('maps empty public values to non-empty Radix keys and back', () => {
    const onValueChange = vi.fn();
    const renderer = mount('', [
      { value: '', label: 'Not declared' },
      { value: 'xhigh', label: 'xhigh' },
    ], onValueChange);

    expect(part(renderer, 'root').props.value).toBe('option-0');
    expect(renderer.root.findAllByProps({ 'data-radix-part': 'item' })
      .map((item) => item.props.value)).toEqual(['option-0', 'option-1']);

    act(() => { part(renderer, 'root').props.onValueChange('option-1'); });
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith('xhigh');
  });

  it('keeps an unmatched public value controlled until a real option is chosen', () => {
    const onValueChange = vi.fn();
    const renderer = mount('', [{ value: 'us', label: 'US' }], onValueChange);

    expect(part(renderer, 'root').props.value).toBe('selection-unset');
    act(() => { part(renderer, 'root').props.onValueChange('option-0'); });
    expect(onValueChange).toHaveBeenCalledWith('us');
  });

  it('round-trips numeric options without string coercion', () => {
    const onValueChange = vi.fn();
    const renderer = mount(1, [
      { value: 0, label: 'Sun' },
      { value: 1, label: 'Mon' },
    ], onValueChange);

    act(() => { part(renderer, 'root').props.onValueChange('option-0'); });
    expect(onValueChange).toHaveBeenCalledWith(0);
  });
});
