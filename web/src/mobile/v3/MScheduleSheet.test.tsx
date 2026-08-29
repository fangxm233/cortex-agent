// input:  schedule sheet rows, real schedule DTOs, and a headless editor controller
// output: single-sheet transitions, pending-safe back/reopen and level-aware regressions
// pos:    Mobile Scheduled bottom-sheet state-machine specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ScheduleInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { buildScheduleRows } from '@/features/workbench/schedule-rail';
import type { ScheduleEditorController } from '@/features/schedule/useScheduleEditorController';

vi.mock('@/mobile/ui/kit', async () => ({
  ...(await vi.importActual<typeof import('@/mobile/ui/kit')>('@/mobile/ui/kit')),
  MBottomSheet: ({ children, onClose, onBack }: any) => (
    <div data-bottom-sheet>
      <button data-action="hardware-back" onClick={onBack ?? onClose} />
      <button data-action="escape" onClick={onBack ?? onClose} />
      {children}
    </div>
  ),
}));

import { MScheduleSheetView, type MScheduleSheetCopy } from './MScheduleSheet';

function schedule(p: Partial<ScheduleInfo> = {}): ScheduleInfo {
  return {
    id: 'sch-1', type: 'once', message: 'ship report', projectId: 'nimbus', profile: 'review',
    nextRun: '2030-01-01T08:00:00.000Z', lastRun: null, paused: false, pausedBy: null,
    intervalMs: null, time: null, dayOfWeek: null,
    target: { kind: 'project', projectId: 'nimbus' }, fallback: 'wait', ...p,
  };
}

function run(p: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'run-1', backendSessionId: null, name: 'run', projectId: 'nimbus', backend: 'claude',
    kind: 'scheduled', origin: 'scheduled', scheduleId: 'repeat-1', createdAt: '2030-01-01T07:00:00.000Z',
    lastUsedAt: '2030-01-01T07:00:00.000Z', resumable: true, label: null, profileName: null,
    running: false, backgroundRunning: false, awaitingInput: false, numTurns: null, costUsd: null,
    unread: false, ...p, commissionId: p.commissionId ?? null,
  };
}

const copy: MScheduleSheetCopy = {
  title: 'Scheduled', countUnit: '{n}', once: 'once', paused: 'paused', nextIn: 'next in {d}',
  allRuns: 'all {n} runs', runListHint: 'tap a run', edit: 'Edit schedule',
};

function editorFor(formSchedule: ScheduleInfo): ScheduleEditorController {
  return {
    form: {
      type: formSchedule.type,
      message: formSchedule.message,
      profile: formSchedule.profile ?? '',
      time: '09:00', dayOfWeek: 1, intervalValue: 30, intervalUnit: 'min',
      delayValue: 10, delayUnit: 'min', target: 'project', fallback: 'wait', projectId: formSchedule.projectId,
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
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    close: vi.fn(),
    onChange: vi.fn(),
    submit: vi.fn(async () => true),
  };
}

function mount(rows: ReturnType<typeof buildScheduleRows>, editor: ScheduleEditorController, onClose = vi.fn()) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider>
        <MScheduleSheetView rows={rows} copy={copy} editor={editor} onOpenSession={vi.fn()} onClose={onClose} now={Date.now()} />
      </LangProvider>,
    );
  });
  return { renderer, onClose };
}

describe('MScheduleSheetView', () => {
  it('pushes a pending row into an editor level in the same bottom sheet with real ScheduleInfo', () => {
    const real = schedule();
    const rows = buildScheduleRows([real], [], Date.now());
    const editor = editorFor(real);
    const { renderer } = mount(rows, editor);

    act(() => renderer.root.findByProps({ 'data-schedule-row': 'sch-1' }).props.onClick());

    expect(editor.openEdit).toHaveBeenCalledWith(real);
    expect(renderer.root.findAllByProps({ 'data-bottom-sheet': true })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-mobile-schedule-editor': true })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-schedule-delay': true })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-once-timing-note': true })).toHaveLength(1);
  });

  it('Escape and hardware back retreat one level, then close only from the list', () => {
    const real = schedule({ id: 'repeat-1', type: 'daily', time: '07:30' });
    const rows = buildScheduleRows([real], [run()], Date.now());
    const editor = editorFor(real);
    const { renderer, onClose } = mount(rows, editor);

    act(() => renderer.root.findByProps({ 'data-schedule-row': 'repeat-1' }).props.onClick());
    expect(renderer.root.findAllByProps({ 'data-run-row': 'run-1' })).toHaveLength(1);

    act(() => renderer.root.findByProps({ 'data-action': 'escape' }).props.onClick());
    expect(renderer.root.findAllByProps({ 'data-schedule-row': 'repeat-1' })).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();

    act(() => renderer.root.findByProps({ 'data-schedule-row': 'repeat-1' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-action': 'hardware-back' }).props.onClick());
    expect(renderer.root.findAllByProps({ 'data-schedule-row': 'repeat-1' })).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();

    act(() => renderer.root.findByProps({ 'data-action': 'hardware-back' }).props.onClick());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('allows back and reopening another editor while a save is pending', () => {
    const real = schedule();
    const rows = buildScheduleRows([real], [], Date.now());
    const editor = editorFor(real);
    editor.pending = true;
    const { renderer } = mount(rows, editor);

    act(() => renderer.root.findByProps({ 'data-schedule-row': 'sch-1' }).props.onClick());
    expect(renderer.root.findByProps({ 'data-action': 'save-schedule' }).props.disabled).toBe(true);
    act(() => renderer.root.findByProps({ 'data-action': 'hardware-back' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-schedule-row': 'sch-1' }).props.onClick());

    expect(editor.close).toHaveBeenCalledOnce();
    expect(editor.openEdit).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByProps({ 'data-mobile-schedule-editor': true })).toHaveLength(1);
  });

  it('opens the run-level manage action as an editor and back returns only to runs', () => {
    const real = schedule({ id: 'repeat-1', type: 'daily', time: '07:30' });
    const rows = buildScheduleRows([real], [run()], Date.now());
    const editor = editorFor(real);
    const { renderer } = mount(rows, editor);

    act(() => renderer.root.findByProps({ 'data-schedule-row': 'repeat-1' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-action': 'edit-schedule' }).props.onClick());
    expect(editor.openEdit).toHaveBeenCalledWith(real);
    expect(renderer.root.findAllByProps({ 'data-mobile-schedule-editor': true })).toHaveLength(1);

    act(() => renderer.root.findByProps({ 'data-action': 'sheet-back' }).props.onClick());
    expect(editor.close).toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'data-run-row': 'run-1' })).toHaveLength(1);

    act(() => renderer.root.findByProps({ 'data-action': 'sheet-back' }).props.onClick());
    expect(renderer.root.findAllByProps({ 'data-schedule-row': 'repeat-1' })).toHaveLength(1);
  });
});
