import type { ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import { emptyCustomProviderForm } from '@/features/settings/vm/custom-provider-vm';
import { MSelect } from '@/mobile/ui/kit';
import { MCustomProviderSheet } from './MCustomProviderSheet';

vi.mock('@/design/BottomSheet', async importOriginal => ({
  ...await importOriginal<typeof import('@/design/BottomSheet')>(),
  MBottomSheet: ({ children, className }: { children: ReactNode; className?: string }) =>
    <div data-sheet-stub className={className}>{children}</div>,
}));

describe('mobile custom provider API picker', () => {
  it('keeps the editor open and settings styling scoped while picking an API', () => {
    const draft = emptyCustomProviderForm();
    const onChange = vi.fn();
    const onClose = vi.fn();
    const view = create(<LangProvider><MCustomProviderSheet draft={draft} creating errors={{}} pending={false}
      onChange={onChange} onClose={onClose} onSave={vi.fn()} /></LangProvider>);
    expect(view.root.findAllByType('select')).toHaveLength(0);
    const select = view.root.findByType(MSelect);
    expect(select.props.title).toBe(en.cpvFieldApi);
    act(() => select.findByType('button').props.onClick({ defaultPrevented: false }));
    const sheets = view.root.findAllByProps({ 'data-sheet-stub': true });
    expect(sheets).toHaveLength(2);
    expect(sheets.every(sheet => sheet.props.className === 'settings-surface mobile-settings mobile-settings-sheet')).toBe(true);
    act(() => view.root.findByProps({ 'data-m-select-option': 'openai-completions' }).props.onClick());
    expect(onChange).toHaveBeenCalledWith({ ...draft, api: 'openai-completions' });
    expect(view.root.findAllByProps({ 'data-sheet-stub': true })).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    view.unmount();
  });
});
