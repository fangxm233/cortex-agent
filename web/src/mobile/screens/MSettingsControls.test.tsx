import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MGroup, MSelect } from '@/mobile/ui/kit';
import { MSettingsField, MSettingsPage, MSettingsRow, MSettingsSection, MSettingsSelect, MSettingsToggle } from './MSettingsControls';

describe('mobile Settings primitives', () => {
  it('keeps the header outside the single content scroller', () => {
    const onBack = vi.fn();
    const view = create(<MSettingsPage title="Long settings title" onBack={onBack}>
      <MSettingsRow title="provider/model/with/a/long/identifier" stacked trailing={<button>Edit</button>} />
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

  it('preserves selector labels, hints, error feedback and the portaled settings scope', () => {
    const props = { label: 'Model', value: 'one', options: [{ value: 'one', label: 'First' }], onValueChange: vi.fn() };
    const view = create(<MSettingsSelect {...props} hint="Choose a model" />);
    expect(JSON.stringify(view.toJSON())).toContain('Choose a model');
    act(() => view.update(<MSettingsSelect {...props} hint="Choose a model" error="Required" data-field="model" />));
    const select = view.root.findByType(MSelect);
    expect(select.props.title).toBe('Model');
    expect(select.props.sheetClassName).toBe('settings-surface mobile-settings mobile-settings-sheet');
    expect(select.findByType('button').props).toMatchObject({ 'aria-invalid': true, 'data-field': 'model' });
    expect(view.root.findByProps({ 'data-settings-field-error': true }).children).toEqual(['Required']);
    expect(JSON.stringify(view.toJSON())).not.toContain('Choose a model');
    view.unmount();
  });

  it('lays a section straight on the mesh: a sentence-case label over rows split by inset hairlines', () => {
    const view = create(<MSettingsSection title="Built-in jobs" note="Applies on restart">
      <MSettingsRow title="One" />
      <MSettingsRow title="Two" />
    </MSettingsSection>);
    const section = view.root.findByProps({ 'data-settings-section': '' });
    const styles = JSON.stringify(section.findAll((node) => typeof node.type === 'string').map((node) => node.props.style));
    expect(styles).not.toContain('var(--m-float-bg)');
    expect(styles).not.toContain('boxShadow');
    expect(styles).not.toContain('textTransform');
    const group = section.findByType(MGroup);
    const rules = group.findAll((node) => node.type === 'div' && node.props['aria-hidden'] === 'true');
    expect(rules).toHaveLength(1);
    expect(rules[0].props.style).toMatchObject({ marginLeft: 12, background: 'var(--proto-line)' });
    expect(JSON.stringify(view.toJSON())).toContain('Built-in jobs');
    expect(JSON.stringify(view.toJSON())).toContain('Applies on restart');
  });
});
