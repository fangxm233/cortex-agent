// input:  mobile Settings controls, react-test-renderer, vitest
// output: Scoped shell and control regression tests
// pos:    Verify mobile Settings structure and interactions
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MSettingsField, MSettingsPage, MSettingsRow, MSettingsToggle } from './MSettingsControls';

describe('mobile Settings primitives', () => {
  it('keeps the header outside the single content scroller', () => {
    const onBack = vi.fn();
    const view = create(<MSettingsPage title="Long settings title" onBack={onBack}>
      <MSettingsRow title="profile/model/with/a/long/identifier" stacked trailing={<button>Edit</button>} />
    </MSettingsPage>);
    const frame = view.root.findByProps({ className: 'settings-surface mobile-settings mobile-settings-frame' });
    const scroll = view.root.findByProps({ className: 'mobile-settings-scroll' });
    expect(frame.findAllByType('header')).toHaveLength(1);
    expect(scroll.findAllByType('header')).toHaveLength(0);
    expect(scroll.findAllByProps({ className: 'mobile-settings-row mobile-settings-row-stacked' })).toHaveLength(1);
    act(() => view.root.findByProps({ 'aria-label': 'Back' }).props.onClick());
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('retains switch semantics and blocks disabled writes', () => {
    const onChange = vi.fn();
    const view = create(<MSettingsToggle label="Enabled" value onChange={onChange} />);
    const toggle = () => view.root.findByProps({ role: 'switch' });
    expect(toggle().props['aria-checked']).toBe(true);
    expect(toggle().props.className).toBe('mobile-settings-toggle');
    act(() => toggle().props.onClick());
    expect(onChange).toHaveBeenCalledWith(false);
    act(() => view.update(<MSettingsToggle label="Enabled" value disabled onChange={onChange} />));
    act(() => toggle().props.onClick());
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('keeps field labels, invalid feedback, and touch-sized input text', () => {
    const view = create(<MSettingsField label="Model" value="long-model" error="Required" readOnly />);
    const input = view.root.findByType('input');
    expect(input.props['aria-invalid']).toBe(true);
    expect(input.props.style.fontSize).toBe(16);
    expect(input.props.style.minHeight).toBe(44);
    expect(view.root.findByType('label').findByType('input')).toBe(input);
    expect(view.root.findByProps({ 'data-settings-field-error': true }).children).toEqual(['Required']);
  });
});
