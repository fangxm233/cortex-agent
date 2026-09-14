import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import type { ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import {
  emptyProfileForm, validateProfileForm, type ProfileBackend, type ProfileFormState,
} from '@/features/settings/profiles-panel-vm';
import { MProfileEditor } from './MProfilesScreen';

const CATALOG: ModelCatalogSnapshot = {
  routes: [
    { endpoint: 'deepseek', backend: 'pi', provider: 'deepseek', modes: ['deepseek'],
      models: ['deepseek-v4-flash'], source: 'pi' },
  ],
  piPending: false,
};

function mount(
  draft: ProfileFormState,
  onChange = vi.fn(),
  onBackendChange = vi.fn<(backend: ProfileBackend) => void>(),
  over: { catalog?: ModelCatalogSnapshot; onProviderChange?: (provider: string) => void } = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider>
        <MProfileEditor
          state={{ mode: 'create', draft }}
          errors={validateProfileForm(draft, { mode: 'create', existingNames: [] })}
          pending={false}
          catalog={over.catalog ?? null}
          catalogPending={false}
          onChange={onChange}
          onBackendChange={onBackendChange}
          onProviderChange={over.onProviderChange ?? (() => {})}
          onCancel={() => {}}
          onSave={() => {}}
        />
      </LangProvider>,
    );
  });
  return renderer;
}

function choiceKind(renderer: ReactTestRenderer, field: string): string {
  return renderer.root.findByProps({ 'data-profile-field': field }).props['data-profile-choice'];
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

describe('MProfileEditor / catalog pickers', () => {
  it('types every catalog-backed field when nothing can be offered', () => {
    const renderer = mount({ ...emptyProfileForm(), name: 'valid', model: 'private-model' });
    for (const field of ['model', 'provider', 'mode']) {
      expect(choiceKind(renderer, field)).toBe('custom');
    }
  });

  it('picks from the catalog and routes a provider pick through the shared transition', () => {
    const onProviderChange = vi.fn<(provider: string) => void>();
    const draft = { ...emptyProfileForm(), name: 'valid', backend: 'pi' as const, provider: 'deepseek', model: 'deepseek-v4-flash', mode: 'deepseek' };
    const renderer = mount(draft, vi.fn(), vi.fn(), { catalog: CATALOG, onProviderChange });
    for (const field of ['model', 'provider', 'mode']) {
      expect(choiceKind(renderer, field)).toBe('select');
    }

    act(() => renderer.root.findByProps({ 'data-profile-field': 'provider' }).props.onChange({
      target: { value: 'deepseek' },
    }));
    expect(onProviderChange).toHaveBeenCalledWith('deepseek');
  });

  it('falls back to a text box when the user asks to type a value the catalog lacks', () => {
    const onChange = vi.fn();
    const draft = { ...emptyProfileForm(), name: 'valid', backend: 'pi' as const, provider: 'deepseek', model: 'deepseek-v4-flash', mode: 'deepseek' };
    const renderer = mount(draft, onChange, vi.fn(), { catalog: CATALOG });

    act(() => renderer.root.findByProps({ 'data-profile-field': 'model' }).props.onChange({
      target: { value: '\u0000custom' },
    }));
    expect(onChange).not.toHaveBeenCalled();
    expect(choiceKind(renderer, 'model')).toBe('custom');

    act(() => renderer.root.findByProps({ 'data-profile-field': 'model' }).props.onChange({
      target: { value: 'private-model' },
    }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ model: 'private-model' }));
  });
});
