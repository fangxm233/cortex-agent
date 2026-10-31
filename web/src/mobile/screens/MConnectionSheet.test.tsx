import type { ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import { emptyConnectionForm } from '@/features/settings/vm/connections-vm';
import { MSelect } from '@/mobile/ui/kit';
import { MConnectionSheet } from './MConnectionSheet';

vi.mock('@/design/BottomSheet', async importOriginal => ({
  ...await importOriginal<typeof import('@/design/BottomSheet')>(),
  MBottomSheet: ({ children, className }: { children: ReactNode; className?: string }) =>
    <div data-sheet-stub className={className}>{children}</div>,
}));

const KINDS = ['claude', 'pi-override', 'pi-custom'] as const;

function mount(draft = emptyConnectionForm('pi-custom'), creating = true) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  const view = create(<LangProvider><MConnectionSheet draft={draft} creating={creating} errors={{}} pending={false}
    kinds={[...KINDS]} overridable={['openai']} onChange={onChange} onClose={onClose} onSave={vi.fn()} /></LangProvider>);
  return { view, onChange, onClose };
}

function select(view: ReturnType<typeof create>, field: string) {
  return view.root.findAllByType(MSelect).find(node => node.props['data-conn-field'] === field)!;
}

describe('mobile connection editor', () => {
  it('keeps the editor open and settings styling scoped while picking a protocol', () => {
    const draft = emptyConnectionForm('pi-custom');
    const { view, onChange, onClose } = mount(draft);
    expect(view.root.findAllByType('select')).toHaveLength(0);
    const api = select(view, 'api');
    expect(api.props.title).toBe(en.connFieldApi);
    act(() => api.findByType('button').props.onClick({ defaultPrevented: false }));
    const sheets = view.root.findAllByProps({ 'data-sheet-stub': true });
    expect(sheets).toHaveLength(2);
    expect(sheets.every(sheet => sheet.props.className === 'settings-surface mobile-settings mobile-settings-sheet')).toBe(true);
    act(() => view.root.findByProps({ 'data-m-select-option': 'openai-completions' }).props.onClick());
    expect(onChange).toHaveBeenCalledWith({ ...draft, api: 'openai-completions' });
    expect(view.root.findAllByProps({ 'data-sheet-stub': true })).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    view.unmount();
  });

  it('shows the fields of the kind being edited', () => {
    const claude = mount(emptyConnectionForm('claude')).view;
    expect(select(claude, 'auth')).toBeDefined();
    expect(select(claude, 'api')).toBeUndefined();
    claude.unmount();

    const override = mount(emptyConnectionForm('pi-override')).view;
    expect(select(override, 'name').props.options).toEqual([{ value: 'openai', label: 'openai' }]);
    expect(override.root.findAllByProps({ 'data-conn-field': 'models' })).toHaveLength(0);
    override.unmount();

    const editing = mount({ ...emptyConnectionForm('claude'), name: 'relay' }, false).view;
    expect(select(editing, 'kind')).toBeUndefined();
    expect(editing.root.findByProps({ 'data-conn-field': 'name' }).props.disabled).toBe(true);
    editing.unmount();
  });
});
