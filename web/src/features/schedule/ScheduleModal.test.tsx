// input:  ScheduleModal, editable-field gates, custom Select stub, and form fixtures
// output: typed patches, API locks, honest once timing, and Escape regressions
// pos:    Desktop shared-controller schedule presentation specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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

  it('locks target and fallback selections while editing', () => {
    const renderer = mount(defaultScheduleForm(null), vi.fn(), 'edit');

    expect(renderer.root.findByProps({ 'data-schedule-select': 'target' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ 'data-schedule-select': 'fallback' }).props.disabled).toBe(true);
  });

  it('hides the fabricated delay editor for once edits and explains the API limitation', () => {
    const renderer = mount({ ...defaultScheduleForm(null), type: 'once' }, vi.fn(), 'edit');

    expect(renderer.root.findAllByProps({ 'data-schedule-select': 'delayUnit' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-once-timing-note': true })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-schedule-next-run': true })).toHaveLength(0);
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
