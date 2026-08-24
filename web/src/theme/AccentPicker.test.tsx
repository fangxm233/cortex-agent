// input:  AccentPicker controls and localized labels
// output: Preset, slider, reset, and selected-state regression coverage
// pos:    Interaction tests for the shared accent picker
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { AccentPicker, type AccentPickerCopy } from './AccentPicker';

const COPY: AccentPickerCopy = {
  label: 'Accent color',
  default: 'Default',
  blue: 'Blue',
  teal: 'Teal',
  violet: 'Violet',
  rose: 'Rose',
  orange: 'Orange',
  custom: 'Custom hue',
  reset: 'Reset',
};

describe('AccentPicker', () => {
  it('selects presets and continuous hue values', () => {
    const onChange = vi.fn();
    const renderer = create(<AccentPicker hue={null} copy={COPY} onChange={onChange} />);

    expect(renderer.root.findByProps({ 'data-accent-preset': 'default' }).props['aria-pressed']).toBe(true);
    act(() => renderer.root.findByProps({ 'data-accent-preset': 'blue' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-accent-hue-slider': true }).props.onChange({ target: { value: '190' } }));

    expect(onChange).toHaveBeenNthCalledWith(1, 255);
    expect(onChange).toHaveBeenNthCalledWith(2, 190);
  });

  it('shows reset only for a custom accent', () => {
    const onChange = vi.fn();
    const renderer = create(<AccentPicker hue={305} copy={COPY} onChange={onChange} compact />);
    const reset = renderer.root.findByProps({ 'data-accent-reset': true });

    act(() => reset.props.onClick());

    expect(onChange).toHaveBeenCalledWith(null);
    expect(renderer.root.findByProps({ 'data-accent-preset': 'violet' }).props['aria-pressed']).toBe(true);
  });
});
