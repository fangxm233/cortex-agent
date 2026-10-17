import { act, create } from 'react-test-renderer';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import { modelKey } from '@/lib/model-selection';
import type { ModelsController } from '@/features/settings/controllers/useModelsController';
import { ModelsPanelView } from './ModelsPanel';

vi.mock('@/design', async importOriginal => ({
  ...await importOriginal<typeof import('@/design')>(),
  Select: ({ value, onValueChange, options, ...props }: { value: string; onValueChange: (value: string) => void; options: { value: string; label: string; disabled?: boolean }[] }) =>
    <select {...props} value={value} onChange={event => onValueChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>,
}));

const ref = { backend: 'pi' as const, provider: 'deepseek', model: `flash-${'long-identifier-'.repeat(8)}` };
function controller(): ModelsController {
  return { snapshot: { models: { default: { ...ref, thinking: 'high', mode: 'deepseek' }, favorites: [ref], memory: {} } } as ConfigSnapshot,
    facts: [{ ref, key: modelKey(ref), thinking: 'high', current: true }], options: [ref],
    loading: false, error: null, catalogOpen: false, catalogModels: [], catalogPending: false, catalogError: null,
    catalog: { piPending: false, routes: [], thinkingLevels: { pi: ['off', 'high'], claude: ['high'] } },
    pending: false, setCatalogOpen: vi.fn(), setDefault: vi.fn(), setThinking: vi.fn(), add: vi.fn(), remove: vi.fn(),
  };
}
function render(c: ModelsController) { return create(<LangProvider><ModelsPanelView controller={c} /></LangProvider>); }

describe('desktop favorite thinking', () => {
  it.each([['off', 'off'], ['', null]])('maps %s to %s without changing default or optimistic memory', (value, thinking) => {
    const c = controller();
    const view = render(c);
    const select = view.root.findByProps({ 'data-model-row': modelKey(ref) }).findByType('select');
    expect(select.props.disabled).toBe(false);
    act(() => select.props.onChange({ target: { value } }));
    expect(c.setThinking).toHaveBeenCalledWith(ref, thinking);
    expect(c.setDefault).not.toHaveBeenCalled();
    expect(select.props.value).toBe('high');
    expect(select.findAllByType('option')[0].children).toEqual([en.stThinkingBackendDefault]);
    view.unmount();
  });
  it.each(['write', 'missing', 'scan'])('disables the thinking picker during %s', state => {
    const c = controller();
    c.pending = state === 'write';
    c.catalog = state === 'missing' ? null : { ...c.catalog!, piPending: state === 'scan' };
    const view = render(c);
    const select = view.root.findByProps({ 'data-model-row': modelKey(ref) }).findByType('select');
    expect(select.props.disabled).toBe(true);
    expect(select.props.value).toBe('high');
    expect(c.setThinking).not.toHaveBeenCalled();
    view.unmount();
  });
  it('keeps unsupported memory visible and disabled while offering backend default', () => {
    const c = controller();
    c.facts[0].thinking = 'max';
    const view = render(c);
    const select = view.root.findByProps({ 'data-model-row': modelKey(ref) }).findByType('select');
    expect(select.props.value).toBe('max');
    const legacy = select.findByProps({ value: 'max', disabled: true });
    expect(legacy.children).toEqual([`max · ${en.stThinkingUnsupported}`]);
    expect(select.props.disabled).toBe(false);
    view.unmount();
  });
});

describe('desktop models', () => {
  it.each([
    { backend: 'pi' as const, provider: 'deepseek', brand: 'deepseek' },
    { backend: 'pi' as const, provider: 'openai-codex', brand: 'codex' },
    { backend: 'pi' as const, provider: 'custom-proxy', brand: 'server' },
    { backend: 'claude' as const, provider: '', brand: 'claude' },
  ])('shows $brand icons in the favorite heading and catalog', ({ backend, provider, brand }) => {
    const model = { backend, provider, model: 'test-model' };
    const c = { ...controller(), catalogOpen: true, catalogModels: [model],
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
  it('renders complete identifiers and remembered thinking; default favorites can be removed', () => {
    const c = controller();
    const view = render(c);
    const row = view.root.findByProps({ 'data-model-row': modelKey(ref) });
    expect(JSON.stringify(view.toJSON())).toContain(ref.model);
    expect(row.findByType('select').props.value).toBe('high');
    const buttons = row.findAllByType('button');
    expect(buttons[0].props.disabled).toBe(true);
    expect(buttons[1].props.disabled).toBe(false);
    act(() => buttons[1].props.onClick());
    expect(c.remove).toHaveBeenCalledWith(ref);
    view.unmount();
  });
  it('offers adding from the catalog and disables existing favorites', () => {
    const c = { ...controller(), catalogOpen: true, catalogModels: [ref, { ...ref, model: 'pro' }] };
    const view = render(c);
    const buttons = view.root.findAllByType('button');
    const add = buttons.find(button => button.children.includes(en.stAddFavorite))!;
    act(() => add.props.onClick());
    expect(c.add).toHaveBeenCalledWith({ ...ref, model: 'pro' });
    expect(buttons.find(button => button.children.includes(en.stFavorited))?.props.disabled).toBe(true);
    view.unmount();
  });
  it('keeps same-provider favorites in one card with divider rows', () => {
    const c = controller();
    const second = { ...ref, model: 'pro' };
    c.facts.push({ ref: second, key: modelKey(second), thinking: null, current: false });
    const view = render(c);
    const group = view.root.find(node => node.type === 'div' && node.props['data-model-group'] === 'pi · deepseek');
    expect(group.findAll(node => node.type === 'div' && !!node.props['data-model-row'])).toHaveLength(2);
    expect(group.children).toHaveLength(2);
    expect(view.root.findAllByProps({ 'data-provider-icon': 'deepseek' })).toHaveLength(1);
    const dividers = group.findAll(node => node.type === 'div' && node.props.style?.borderBottom);
    expect(dividers).toHaveLength(1);
    view.unmount();
  });
  it('filters the add list with trimmed case-insensitive model matching, without changing favorites', () => {
    const c = { ...controller(), catalogOpen: true, catalogModels: [ref, { ...ref, model: 'Pro-2' }] };
    const view = render(c);
    const input = view.root.findByProps({ 'data-model-filter': true });
    act(() => input.props.onChange({ target: { value: ' PRO ' } }));
    const add = view.root.findAllByType('button').find(button => button.children.includes(en.stAddFavorite))!;
    act(() => add.props.onClick());
    expect(c.add).toHaveBeenCalledWith({ ...ref, model: 'Pro-2' });
    expect(view.root.findAllByType('button').some(button => button.children.includes(en.stFavorited))).toBe(false);
    expect(view.root.findAll(node => node.type === 'div' && !!node.props['data-model-row'])).toHaveLength(1);
    act(() => input.props.onChange({ target: { value: 'no-match' } }));
    expect(view.root.findAllByType('button').some(button => button.children.includes(en.stAddFavorite))).toBe(false);
    view.unmount();
  });

});
