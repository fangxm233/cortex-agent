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
    setCatalogOpen: vi.fn(), setDefault: vi.fn(), add: vi.fn(), remove: vi.fn(),
  };
}

describe('mobile models', () => {
  it('shares favorite add/remove and full default model keys with desktop', () => {
    const c = controller();
    const view = create(<LangProvider><MModelsView controller={c} onBack={vi.fn()} /></LangProvider>);
    const buttons = view.root.findAllByType('button');
    act(() => buttons.find(button => button.children.includes(en.stRemoveFavorite))!.props.onClick());
    expect(c.remove).toHaveBeenCalledWith(ref);
    act(() => buttons.find(button => button.children.includes(en.stAddFavorite))!.props.onClick());
    expect(c.add).toHaveBeenCalledWith({ ...ref, model: 'pro' });
    const select = view.root.findByType('select');
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
