// input:  mobile profile editor drafts, shared validation and change callbacks
// output: field-local validation copy and backend-transition interaction regressions
// pos:    Verifies the presentational mobile profile editor behavior
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { emptyProfileForm, type ProfileFormState } from '@/features/settings/profiles-panel-vm';
import { MProfileEditor } from './MProfilesScreen';

function mount(draft: ProfileFormState, onChange = vi.fn()): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider>
        <MProfileEditor
          state={{ mode: 'create', draft }}
          names={[]}
          pending={false}
          onChange={onChange}
          onCancel={() => {}}
          onSave={() => {}}
        />
      </LangProvider>,
    );
  });
  return renderer;
}

function fieldError(renderer: ReactTestRenderer, field: string): string | undefined {
  const control = renderer.root.find(
    node => (node.type === 'input' || node.type === 'select') && node.props['data-profile-field'] === field,
  );
  return control.parent?.findAllByProps({ 'data-settings-field-error': true })[0]?.children.join('');
}

describe('MProfileEditor', () => {
  it('shows each validation error beside the field it describes', () => {
    const renderer = mount({
      ...emptyProfileForm(),
      name: 'valid',
      backend: 'pi',
      mode: 'bad/mode',
      extraOption: [{ key: 'thinking', value: '' }],
    });

    expect(fieldError(renderer, 'model')).toBe('A model is required');
    expect(fieldError(renderer, 'mode')).toBe('Only letters, digits, - and _ are allowed');
    expect(fieldError(renderer, 'provider')).toBe('A pi profile must declare a provider');
    expect(renderer.root.findByProps({ 'data-profile-extra-options': true })
      .findAllByProps({ 'data-settings-field-error': true })[0]?.children.join(''))
      .toBe('A flag must start with --');
  });

  it('uses the shared backend transition to clear unsupported thinking', () => {
    const onChange = vi.fn();
    const draft = { ...emptyProfileForm(), name: 'valid', model: 'model', thinking: 'max' };
    const renderer = mount(draft, onChange);

    act(() => renderer.root.findByProps({ 'data-profile-field': 'backend' }).props.onChange({
      target: { value: 'pi' },
    }));

    expect(onChange).toHaveBeenCalledWith({ ...draft, backend: 'pi', thinking: '' });
  });
});
