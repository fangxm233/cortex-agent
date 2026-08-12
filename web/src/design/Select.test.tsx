// input:  Select with mocked Radix parts and typed option fixtures
// output: value mapping, trigger forwarding, option-state and sizing regressions
// pos:    Verifies the shared custom selection adapter
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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

import { Select, type SelectDensity, type SelectOption } from './Select';
import type { CSSProperties } from 'react';

function mount<T extends string | number>(
  value: T,
  options: readonly SelectOption<T>[],
  onValueChange = vi.fn(),
  chrome: { density?: SelectDensity; style?: CSSProperties } = {},
): ReactTestRenderer {
  return create(
    <Select
      data-field="fixture"
      aria-label="Fixture choice"
      value={value}
      options={options}
      onValueChange={onValueChange}
      {...chrome}
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

  it('forwards accessible trigger metadata and renders selected and disabled states', () => {
    const options = [
      { value: 'active', label: 'Active', description: 'current backend' },
      { value: 'locked', label: 'Locked', disabled: true, disabledReason: 'Unavailable' },
    ] as const;
    const renderer = mount('active', options);
    const trigger = part(renderer, 'trigger');
    const items = renderer.root.findAllByProps({ 'data-radix-part': 'item' });

    expect(trigger.props['data-field']).toBe('fixture');
    expect(trigger.props['aria-label']).toBe('Fixture choice');
    expect(part(renderer, 'value').children.join('')).toBe('Active');
    expect(items[0].props.textValue).toBe('Active');
    expect(items[1].props.disabled).toBe(true);
    expect(items[1].props.title).toBe('Unavailable');
    expect(JSON.stringify(renderer.toJSON())).toContain('current backend');
  });

  it('uses the compact profile-selector density for trigger and popup', () => {
    const renderer = mount('active', [{ value: 'active', label: 'Active' }]);
    const trigger = part(renderer, 'trigger');
    const content = part(renderer, 'content');

    expect(trigger.props.style).toMatchObject({
      fontFamily: "'IBM Plex Mono',monospace",
      fontSize: 10.5,
      fontWeight: 500,
      lineHeight: 1.2,
      padding: '2px 7px',
      borderRadius: 6,
    });
    expect(content.props.className).toContain('border-proto-line');
    expect(content.props.className).toContain('rounded-menu');
    expect(content.props.className).toContain('shadow-menu');
    expect(content.props.style.minWidth).toBe(
      'max(160px, var(--radix-select-trigger-width))',
    );
  });

  // Radix 2.3.2 drops `className`/`style` from ItemText (it forwards only the remaining props to a
  // span), so a size set there renders nothing and the row falls back to the inherited body size.
  // The popup row size therefore has to live on the Item, matching the profile menu: 10px semibold
  // label, 9px description, 5px/8px padding.
  it('sizes popup rows on the item so they match the profile menu', () => {
    const renderer = mount('active', [
      { value: 'active', label: 'Active', description: 'current backend' },
    ]);
    const item = part(renderer, 'item');

    expect(part(renderer, 'content').props.className).toContain('text-[10px]');
    expect(item.props.className).toContain('font-semibold');
    expect(item.props.className).toContain('px-1g');
    expect(item.props.className).toContain('py-menu-row-y');
    expect(part(renderer, 'item-text').props.className).toBeUndefined();
  });

  it('lets a call site override the density so a select matches its neighbouring input', () => {
    const style = {
      padding: '5px 9px',
      borderRadius: 7,
      height: 24,
      font: "400 11px 'IBM Plex Mono',monospace",
    } satisfies CSSProperties;
    const trigger = part(mount('active', [{ value: 'active', label: 'Active' }], vi.fn(), { style }), 'trigger');
    const keys = Object.keys(trigger.props.style);

    expect(trigger.props.style).toMatchObject(style);
    // The `font` shorthand resets fontSize/lineHeight, so it must be written after the density
    // longhands or the call site's size is silently discarded.
    expect(keys.indexOf('font')).toBeGreaterThan(keys.indexOf('fontSize'));
  });

  it('leaves every visual to the call site at bare density', () => {
    const bare = mount('active', [{ value: 'active', label: 'Active' }], vi.fn(), { density: 'bare' });

    expect(part(bare, 'trigger').props.style).toEqual({});
  });
});
