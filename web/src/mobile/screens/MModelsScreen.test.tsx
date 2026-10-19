import { act, create } from 'react-test-renderer';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import type { ReactNode } from 'react';
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

// The sheet's own motion and back-guard need a browser; here it only has to render its content.
vi.mock('@/design', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/design')>(),
  MBottomSheet: ({ children }: { children: ReactNode }) => <div data-sheet-stub="">{children}</div>,
}));

function render(c: ModelsController) { return create(<LangProvider><MModelsView controller={c} onBack={vi.fn()} /></LangProvider>); }

/** Favorites are rows; their thinking level, default and removal live in the row's bottom sheet. */
function openSheet(view: ReturnType<typeof render>, c: ModelsController) {
  act(() => view.root.findByProps({ 'data-model-favorite': c.facts[0].key }).props.onClick());
  return view.root.findByProps({ 'data-model-sheet': c.facts[0].key });
}
const radios = (sheet: ReturnType<typeof openSheet>) => sheet.findAllByProps({ role: 'radio' });
const radioLabel = (radio: ReturnType<typeof radios>[number]) => radio.findAllByType('span')[0].children.join('');
const checkedLabel = (sheet: ReturnType<typeof openSheet>) => radios(sheet).filter(r => r.props['aria-checked']).map(radioLabel);

describe('mobile favorite thinking', () => {
  it('shows each favorite as one row: name, thinking level, default marker', () => {
    const c = controller();
    const view = render(c);
    const row = view.root.findByProps({ 'data-model-favorite': c.facts[0].key });
    const text = row.findAllByType('span').map(span => span.children.filter(child => typeof child === 'string').join(''));
    expect(text).toEqual(expect.arrayContaining(['flash', en.default, 'xhigh']));
    expect(view.root.findAll(node => node.props['data-model-sheet'] !== undefined)).toHaveLength(0);
    view.unmount();
  });
  it.each([['high', 'high'], ['off', 'off'], [en.stThinkingBackendDefault, null]])('maps %s to %s without changing default or optimistic memory', (label, thinking) => {
    const c = controller();
    const view = render(c);
    const sheet = openSheet(view, c);
    expect(radios(sheet).map(radioLabel)[0]).toBe(en.stThinkingBackendDefault);
    const radio = radios(sheet).find(r => radioLabel(r) === label)!;
    expect(radio.props.disabled).toBe(false);
    act(() => radio.props.onClick());
    expect(c.setThinking).toHaveBeenCalledWith(ref, thinking);
    expect(c.setDefault).not.toHaveBeenCalled();
    expect(checkedLabel(sheet)).toEqual(['xhigh']);
    view.unmount();
  });
  it.each(['write', 'missing', 'scan'])('disables the thinking picker during %s', state => {
    const c = controller();
    c.pending = state === 'write';
    c.catalog = state === 'missing' ? null : { ...c.catalog!, piPending: state === 'scan' };
    const view = render(c);
    const sheet = openSheet(view, c);
    expect(radios(sheet).every(r => r.props.disabled)).toBe(true);
    expect(checkedLabel(sheet)).toEqual(['xhigh']);
    expect(c.setThinking).not.toHaveBeenCalled();
    view.unmount();
  });
  it('keeps unsupported memory visible as a disabled option', () => {
    const c = controller();
    c.facts[0].thinking = 'max';
    const view = render(c);
    const sheet = openSheet(view, c);
    const unsupported = radios(sheet).find(r => radioLabel(r) === `max · ${en.stThinkingUnsupported}`)!;
    expect(unsupported.props.disabled).toBe(true);
    expect(unsupported.props['aria-checked']).toBe(true);
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
    const sheet = openSheet(view, c);
    act(() => sheet.findAllByType('button').find(button => button.children.includes(en.stRemoveFavorite))!.props.onClick());
    expect(c.remove).toHaveBeenCalledWith(ref);
    expect(view.root.findAll(node => node.props['data-model-sheet'] !== undefined)).toHaveLength(0);
    act(() => view.root.findAllByType('button').find(button => button.children.includes(en.stAddFavorite))!.props.onClick());
    expect(c.add).toHaveBeenCalledWith({ ...ref, model: 'pro' });
    const select = view.root.findAllByType('select')[0];
    expect(select.props.value).toBe(modelKey(ref));
    act(() => select.props.onChange({ target: { value: modelKey(ref) } }));
    expect(c.setDefault).toHaveBeenCalledWith(modelKey(ref));
    view.unmount();
  });
  it('sets a non-default favorite as default from its sheet', () => {
    const c = controller();
    c.facts[0].current = false;
    const view = render(c);
    const sheet = openSheet(view, c);
    const button = sheet.findAllByType('button').find(b => b.children.includes(en.stSetDefaultModel))!;
    expect(button.props.disabled).toBe(false);
    act(() => button.props.onClick());
    expect(c.setDefault).toHaveBeenCalledWith(c.facts[0].key);
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
