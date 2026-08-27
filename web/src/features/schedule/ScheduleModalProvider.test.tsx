// input:  desktop provider context requests and a mocked shared editor controller
// output: controller delegation and controller-backed modal prop regressions
// pos:    Desktop schedule modal provider integration specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

const fakes = vi.hoisted(() => ({
  openCreate: vi.fn(),
  openEdit: vi.fn(),
  close: vi.fn(),
  onChange: vi.fn(),
  submit: vi.fn(async () => true),
  toast: vi.fn(),
}));

vi.mock('@/design', () => ({ useToast: () => ({ toast: fakes.toast }) }));
vi.mock('./useScheduleEditorController', () => ({
  useScheduleEditorController: () => ({
    form: {
      type: 'once', message: 'ship report', profile: 'review', time: '09:00', dayOfWeek: 1,
      intervalValue: 30, intervalUnit: 'min', delayValue: 10, delayUnit: 'min', target: 'project',
      fallback: 'wait', projectId: 'nimbus',
    },
    mode: 'edit',
    profileOptions: ['review'],
    editableFields: {
      type: false, time: false, interval: false, dayOfWeek: false, delay: false,
      target: false, fallback: false, message: true, profile: true, projectId: true,
    },
    valid: true,
    pending: false,
    error: null,
    openCreate: fakes.openCreate,
    openEdit: fakes.openEdit,
    close: fakes.close,
    onChange: fakes.onChange,
    submit: fakes.submit,
  }),
}));
vi.mock('./ScheduleModal', () => ({
  ScheduleModal: (props: any) => (
    <button
      data-provider-modal
      data-mode={props.mode}
      data-delay-editable={props.editableFields.delay}
      onClick={props.onCreate}
    />
  ),
}));

import { ScheduleModalProvider, useScheduleModal } from './ScheduleModalProvider';

let context: ReturnType<typeof useScheduleModal> | null = null;
function Probe() {
  context = useScheduleModal();
  return null;
}

function schedule(): ScheduleInfo {
  return {
    id: 'once-1', type: 'once', message: 'ship report', projectId: 'nimbus', profile: 'review',
    nextRun: null, lastRun: null, paused: false, pausedBy: null, intervalMs: null, time: null,
    dayOfWeek: null, target: null, fallback: null,
  };
}

describe('ScheduleModalProvider', () => {
  it('delegates context actions and renders controller-owned editability', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <ScheduleModalProvider><Probe /></ScheduleModalProvider>
        </LangProvider>,
      );
    });

    const real = schedule();
    act(() => {
      context?.open({ projectId: 'nimbus' });
      context?.openEdit(real);
      context?.close();
    });
    expect(fakes.openCreate).toHaveBeenCalledWith({ projectId: 'nimbus' });
    expect(fakes.openEdit).toHaveBeenCalledWith(real);
    expect(fakes.close).toHaveBeenCalled();

    const modal = renderer.root.findByProps({ 'data-provider-modal': true });
    expect(modal.props['data-mode']).toBe('edit');
    expect(modal.props['data-delay-editable']).toBe(false);
    act(() => modal.props.onClick());
    expect(fakes.submit).toHaveBeenCalled();
  });
});
