// input:  mobile profile editor drafts, controller validation facts and callbacks
// output: field-local error copy and backend-change delegation regressions
// pos:    Verifies the independent presentational mobile profile editor
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import {
  emptyProfileForm, validateProfileForm, type ProfileBackend, type ProfileFormState,
} from '@/features/settings/profiles-panel-vm';
import { MProfileEditor } from './MProfilesScreen';

function mount(
  draft: ProfileFormState,
  onChange = vi.fn(),
  onBackendChange = vi.fn<(backend: ProfileBackend) => void>(),
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider>
        <MProfileEditor
          state={{ mode: 'create', draft }}
          errors={validateProfileForm(draft, { mode: 'create', existingNames: [] })}
          pending={false}
          onChange={onChange}
          onBackendChange={onBackendChange}
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

  it('delegates backend changes to the shared controller callback', () => {
    const onBackendChange = vi.fn<(backend: ProfileBackend) => void>();
    const draft = { ...emptyProfileForm(), name: 'valid', model: 'model', thinking: 'max' };
    const renderer = mount(draft, vi.fn(), onBackendChange);

    act(() => renderer.root.findByProps({ 'data-profile-field': 'backend' }).props.onChange({
      target: { value: 'pi' },
    }));

    expect(onBackendChange).toHaveBeenCalledWith('pi');
  });
});
