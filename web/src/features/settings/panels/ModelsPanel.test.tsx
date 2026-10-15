import { act, create } from 'react-test-renderer';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import { modelKey } from '@/lib/model-selection';
import type { ModelsController } from '@/features/settings/controllers/useModelsController';
import { ModelsPanelView } from './ModelsPanel';

vi.mock('@/design', async importOriginal => ({
  ...await importOriginal<typeof import('@/design')>(),
  Select: ({ value, onValueChange, options, ...props }: { value: string; onValueChange: (value: string) => void; options: { value: string; label: string }[] }) =>
    <select {...props} value={value} onChange={event => onValueChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>,
}));

const ref = { backend: 'pi' as const, provider: 'deepseek', model: `flash-${'long-identifier-'.repeat(8)}` };
function controller(): ModelsController {
  return { snapshot: { models: { default: { ...ref, thinking: 'high', mode: 'deepseek' }, favorites: [ref], memory: {} } } as ConfigSnapshot,
    facts: [{ ref, key: modelKey(ref), thinking: 'high', current: true }], options: [ref],
    loading: false, error: null, catalogOpen: false, catalogModels: [], catalogPending: false, catalogError: null,
    pending: false, setCatalogOpen: vi.fn(), setDefault: vi.fn(), add: vi.fn(), remove: vi.fn(),
  };
}
function render(c: ModelsController) { return create(<LangProvider><ModelsPanelView controller={c} /></LangProvider>); }

describe('desktop models', () => {
  it('renders complete identifiers and remembered thinking; default favorites can be removed', () => {
    const c = controller();
    const view = render(c);
    const row = view.root.findByProps({ 'data-model-row': modelKey(ref) });
    expect(JSON.stringify(view.toJSON())).toContain(ref.model);
    expect(row.findByProps({ 'data-label': en.stColThinking }).children).toEqual(['high']);
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
