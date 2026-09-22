// input:  ScheduleModal, schedule form fixtures, React renderer
// output: Schedule control and overlay regression tests
// pos:    Schedule editor presentation coverage
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { defaultScheduleForm, editableScheduleFields, type ScheduleForm } from './schedule-modal-vm';

vi.mock('@/design', async () => ({
  ...(await vi.importActual<typeof import('@/design/controls')>('@/design/controls')),
  Select: ({ options, value, ...props }: any) => (
    <div data-select-control data-select-value={String(value)} data-option-count={options.length} {...props} />
  ),
}));

import { ScheduleModal } from './ScheduleModal';

let onWindowKeyDown: ((event: { key: string; defaultPrevented: boolean }) => void) | null;

function mount(
  form: ScheduleForm,
  onChange = vi.fn(),
  mode: 'create' | 'edit' = 'create',
  onCancel = vi.fn(),
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider>
        <ScheduleModal
          form={form}
          mode={mode}
          editableFields={editableScheduleFields(mode, form.type)}
          onChange={onChange}
          onCancel={onCancel}
          onCreate={() => {}}
          valid
          pending={false}
          profileOptions={['default', 'review']}
          now={new Date('2030-01-01T00:00:00.000Z')}
        />
      </LangProvider>,
    );
  });
  return renderer;
}

function pick(renderer: ReactTestRenderer, field: string, value: string | number): void {
  act(() => {
    renderer.root.findByProps({ 'data-schedule-select': field }).props.onValueChange(value);
  });
}

beforeEach(() => {
  onWindowKeyDown = null;
  vi.stubGlobal('window', {
    addEventListener: vi.fn((type: string, handler: typeof onWindowKeyDown) => {
      if (type === 'keydown') onWindowKeyDown = handler;
    }),
    removeEventListener: vi.fn(),
  });
});

describe('ScheduleModal custom selections', () => {
  it('keeps read-only edit controls readable and keyboard semantics explicit', () => {
    const renderer = mount(defaultScheduleForm(null), vi.fn(), 'edit');
    const type = renderer.root.findByProps({ 'data-sched-type-opt': 'daily' });
    expect(type.type).toBe('button');
    expect(type.props.disabled).toBe(true);
    expect(type.props.style.opacity).toBeUndefined();
    expect(type.props.className).toContain('focus-visible:outline');
    const target = renderer.root.findByProps({ 'data-schedule-select': 'target' });
    expect(target.props.disabled).toBe(true);
    expect(renderer.root.findByProps({ role: 'dialog' }).props.style).toMatchObject({
      width: 560, maxWidth: 'calc(100vw - 40px)', backdropFilter: 'var(--glass-filter)',
    });
  });

  it('emits typed patches for interval, profile, target and fallback fields', () => {
    const onChange = vi.fn();
    const form = { ...defaultScheduleForm('nimbus'), type: 'interval' as const };
    const renderer = mount(form, onChange);
    pick(renderer, 'intervalUnit', 'hr');
    pick(renderer, 'profile', 'review');
    pick(renderer, 'target', 'project');
    pick(renderer, 'fallback', 'skip');

    expect(onChange.mock.calls.map(([patch]) => patch)).toEqual([
      { intervalUnit: 'hr' },
      { profile: 'review' },
      { target: 'project' },
      { fallback: 'skip' },
    ]);
  });

  it('keeps delay units as strings and weekday values as numbers', () => {
    const onChange = vi.fn();
    const once = mount({ ...defaultScheduleForm(null), type: 'once' }, onChange);
    pick(once, 'delayUnit', 'min');

    const weekly = mount({ ...defaultScheduleForm(null), type: 'weekly' }, onChange);
    pick(weekly, 'dayOfWeek', 5);

    expect(onChange.mock.calls.map(([patch]) => patch)).toEqual([
      { delayUnit: 'min' },
      { dayOfWeek: 5 },
    ]);
  });

  it('keeps the modal open when an inner Select consumes Escape', () => {
    const onCancel = vi.fn();
    mount(defaultScheduleForm(null), vi.fn(), 'create', onCancel);

    act(() => { onWindowKeyDown?.({ key: 'Escape', defaultPrevented: true }); });
    expect(onCancel).not.toHaveBeenCalled();

    act(() => { onWindowKeyDown?.({ key: 'Escape', defaultPrevented: false }); });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
