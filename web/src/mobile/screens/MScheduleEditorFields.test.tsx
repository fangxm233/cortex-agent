import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import { MSelect } from '@/mobile/ui/kit';
import { modelKey } from '@/lib/model-selection';
import { EditorFields, type MScheduleEditorProps } from './MScheduleEditorFields';

vi.mock('@/design/BottomSheet', async importOriginal => ({
  ...await importOriginal<typeof import('@/design/BottomSheet')>(),
  MBottomSheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const selection = { backend: 'pi' as const, provider: 'deepseek', model: 'flash', thinking: 'high', mode: 'deepseek' };

function props(type: MScheduleEditorProps['form']['type']): MScheduleEditorProps {
  return {
    form: { type, message: 'Report', selection, time: '09:00', dayOfWeek: 1,
      intervalValue: 30, intervalUnit: 'min', delayValue: 10, delayUnit: 'min', projectId: 'alpha' },
    mode: 'create', valid: true, pending: false, error: null,
    editableFields: { type: true, time: true, interval: true, delay: true, dayOfWeek: true, message: true, selection: true, projectId: true },
    modelOptions: [
      { value: modelKey(selection), label: 'Flash', selection, favorite: true },
      { value: 'unavailable', label: 'Unavailable', selection: { ...selection, mode: '' }, favorite: false },
    ],
    thinkingOptions: ['', 'high'], onChange: vi.fn(), onSubmit: vi.fn(), onBack: vi.fn(),
  };
}

function mount(input: MScheduleEditorProps) {
  return create(<LangProvider><EditorFields {...input} copy={en} /></LangProvider>);
}

function open(view: ReactTestRenderer, title: string) {
  const select = view.root.findAllByType(MSelect).find(node => node.props.title === title)!;
  act(() => select.findByType('button').props.onClick({ defaultPrevented: false }));
  return (value: string) => view.root.findByProps({ 'data-m-select-option': value });
}

describe('mobile schedule sheet selectors', () => {
  it.each([
    ['interval', en.scEvery, 'hr', { intervalUnit: 'hr' }],
    ['once', en.scIn, 'hr', { delayUnit: 'hr' }],
    ['weekly', en.scDay, '3', { dayOfWeek: 3 }],
  ] as const)('writes %s timing through a picker without changing the paired field layout', (type, title, value, patch) => {
    const input = props(type);
    const view = mount(input);
    expect(view.root.findAllByType('select')).toHaveLength(0);
    const row = open(view, title);
    act(() => row(value).props.onClick());
    expect(input.onChange).toHaveBeenCalledWith(patch);
    view.unmount();
  });

  it('keeps the model placeholder and unroutable models disabled, with favorite labels intact', () => {
    const input = props('interval');
    input.form.selection = null;
    const view = mount(input);
    const row = open(view, en.scModel);
    expect(row('').props.disabled).toBe(true);
    expect(row('unavailable').props.disabled).toBe(true);
    expect(JSON.stringify(view.toJSON())).toContain('★ Flash');
    act(() => row('unavailable').props.onClick());
    expect(input.onChange).not.toHaveBeenCalled();
    act(() => row(modelKey(selection)).props.onClick());
    expect(input.onChange).toHaveBeenCalledWith({ selection });
    view.unmount();
  });

  it('preserves the full selection while clearing thinking', () => {
    const input = props('daily');
    const view = mount(input);
    const row = open(view, en.scThinking);
    act(() => row('').props.onClick());
    expect(input.onChange).toHaveBeenCalledWith({ selection: { ...selection, thinking: null } });
    view.unmount();
  });

  it('keeps read-only timing and selection fields disabled', () => {
    const input = props('weekly');
    input.editableFields = { ...input.editableFields, dayOfWeek: false, selection: false };
    const view = mount(input);
    for (const select of view.root.findAllByType(MSelect)) expect(select.findByType('button').props.disabled).toBe(true);
    view.unmount();
  });
});
