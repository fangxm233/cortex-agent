import { act, create } from 'react-test-renderer';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import { modelKey } from '@/lib/model-selection';
import type { ModelsController } from '@/features/settings/controllers/useModelsController';
import { MModelsView } from './MModelsScreen';
import { buildMSettingsVm } from './m-settings-vm';

const ref = { backend: 'pi' as const, provider: 'deepseek', model: 'flash' };
const snapshot = { models: { default: { ...ref, thinking: 'xhigh', mode: 'deepseek' }, favorites: [ref], memory: {} } } as ConfigSnapshot;
function controller(): ModelsController {
  return { snapshot, facts: [{ ref, key: modelKey(ref), thinking: 'xhigh', current: true }], options: [ref],
    loading: false, error: null, catalogOpen: true, catalogModels: [{ ...ref, model: 'pro' }],
    catalogPending: false, catalogError: null, pending: false,
    catalog: { piPending: false, routes: [], thinkingLevels: { pi: ['off', 'high', 'xhigh'], claude: ['high'] } },
    setCatalogOpen: vi.fn(), setDefault: vi.fn(), setThinking: vi.fn(), add: vi.fn(), remove: vi.fn(),
  };
}

function render(c: ModelsController) { return create(<LangProvider><MModelsView controller={c} onBack={vi.fn()} /></LangProvider>); }

describe('mobile favorite thinking', () => {
  it.each([['high', 'high'], ['off', 'off'], ['', null]])('maps %s to %s without changing default or optimistic memory', (value, thinking) => {
    const c = controller();
    const view = render(c);
    const select = view.root.findAllByType('select')[1];
    expect(select.props.disabled).toBe(false);
    act(() => select.props.onChange({ target: { value } }));
    expect(c.setThinking).toHaveBeenCalledWith(ref, thinking);
    expect(c.setDefault).not.toHaveBeenCalled();
    expect(select.props.value).toBe('xhigh');
    expect(select.findAllByType('option')[0].children).toEqual([en.stThinkingBackendDefault]);
    view.unmount();
  });
  it.each(['write', 'missing', 'scan'])('disables the thinking picker during %s', state => {
    const c = controller();
    c.pending = state === 'write';
    c.catalog = state === 'missing' ? null : { ...c.catalog!, piPending: state === 'scan' };
    const view = render(c);
    const select = view.root.findAllByType('select')[1];
    expect(select.props.disabled).toBe(true);
    expect(select.props.value).toBe('xhigh');
    expect(c.setThinking).not.toHaveBeenCalled();
    view.unmount();
  });
  it('keeps unsupported memory visible as a disabled option', () => {
    const c = controller();
    c.facts[0].thinking = 'max';
    const view = render(c);
    const select = view.root.findAllByType('select')[1];
    expect(select.props.value).toBe('max');
    expect(select.findByProps({ value: 'max', disabled: true }).children).toEqual([`max · ${en.stThinkingUnsupported}`]);
    view.unmount();
  });
});

describe('mobile models', () => {
  it.each([
    { backend: 'pi' as const, provider: 'deepseek', brand: 'deepseek' },
    { backend: 'pi' as const, provider: 'openai-codex', brand: 'codex' },
    { backend: 'pi' as const, provider: 'custom-proxy', brand: 'server' },
    { backend: 'claude' as const, provider: '', brand: 'claude' },
  ])('shows $brand icons in the favorite heading and catalog', ({ backend, provider, brand }) => {
    const model = { backend, provider, model: 'test-model' };
    const c = { ...controller(), catalogModels: [model],
      facts: [{ ref: model, key: modelKey(model), thinking: null, current: false }] };
    const view = render(c);
    const icons = view.root.findAllByProps({ 'data-provider-icon': provider || backend });
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(icon.props['data-provider-brand']).toBe(brand);
      expect(icon.props['aria-hidden']).toBe(true);
      expect(icon.props.style.fontSize).toBe(16);
    }
    view.unmount();
  });
  it('shares favorite add/remove and full default model keys with desktop', () => {
    const c = controller();
    const view = create(<LangProvider><MModelsView controller={c} onBack={vi.fn()} /></LangProvider>);
    const buttons = view.root.findAllByType('button');
    act(() => buttons.find(button => button.children.includes(en.stRemoveFavorite))!.props.onClick());
    expect(c.remove).toHaveBeenCalledWith(ref);
    act(() => buttons.find(button => button.children.includes(en.stAddFavorite))!.props.onClick());
    expect(c.add).toHaveBeenCalledWith({ ...ref, model: 'pro' });
    const select = view.root.findAllByType('select')[0];
    expect(select.props.value).toBe(modelKey(ref));
    act(() => select.props.onChange({ target: { value: modelKey(ref) } }));
    expect(c.setDefault).toHaveBeenCalledWith(modelKey(ref));
    view.unmount();
  });
  it('shows the actual default even when no favorites remain', () => {
    expect(buildMSettingsVm(snapshot)).toEqual({ modelLabel: 'flash', thinking: 'xhigh' });
    const c = { ...controller(), facts: [], catalogOpen: false };
    const view = create(<LangProvider><MModelsView controller={c} onBack={vi.fn()} /></LangProvider>);
    expect(JSON.stringify(view.toJSON())).toContain(en.stNoFavorites);
    expect(view.root.findByType('select').props.value).toBe(modelKey(ref));
    view.unmount();
  });
});
