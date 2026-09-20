import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import type { ScheduleRow } from './schedule-rail';

const harness = vi.hoisted(() => ({
  modalProps: null as any,
  createCalls: [] as string[],
  copyCalls: [] as Array<[string, string]>,
}));

vi.mock('@/design/Modal', () => ({
  Modal: (props: any) => {
    harness.modalProps = props;
    return <div data-shared-modal data-chrome={props.chrome}>{props.children}</div>;
  },
}));

vi.mock('@/design/useClipboardFeedback', () => ({
  useClipboardFeedback: () => ({
    copiedKey: null,
    copy: async (value: string, key: string) => { harness.copyCalls.push([value, key]); },
  }),
}));

vi.mock('@/features/projects/useCreateProject', () => ({
  useCreateProject: () => ({
    createProject: async (name: string) => { harness.createCalls.push(name); },
    clearError: vi.fn(), error: null, isPending: false,
  }),
}));

vi.mock('@/i18n', () => ({
  useVocab: () => ({
    newProject: 'New project', npProjectName: 'Project name', npHint: 'Pick a name',
    cancel: 'Cancel', npCreate: 'Create', wbCortexId: 'Cortex ID',
    wbBackendUuid: 'Backend UUID', wbSessionId: 'Session ID', wbCopied: 'Copied',
    wbCopy: 'Copy', wbSchedPausedPill: 'paused', wbSchedNextRun: 'next {d}',
    wbSchedManage: 'manage ↗', wbAllRuns: '{n} runs', wbSchedRunListHint: 'Select a run',
    wbSchedMarkAllRead: 'mark {n} read',
    wbSessionStats: 'Session stats', wbSessionStatsHint: 'Totals for the whole conversation.',
  }),
}));

import { NewProjectModal } from './NewProjectModal';
import { RunListModal } from './RunListModal';
import { SessionIdModal } from './SessionIdModal';

function render(node: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(node); });
  return tree;
}

function run(sessionId: string): SessionInfo {
  return {
    sessionId, backendSessionId: null, name: sessionId, projectId: 'proj', backend: 'claude',
    kind: 'scheduled', origin: 'scheduled', scheduleId: 'sch-1',
    createdAt: '2030-01-01T00:00:00.000Z', lastUsedAt: '2030-01-01T00:00:00.000Z',
    resumable: true, label: null, profileName: null, running: false,
    backgroundRunning: false, awaitingInput: false, numTurns: null, costUsd: 1, unread: false,
    commissionId: null,
  };
}

function row(): ScheduleRow {
  return {
    scheduleId: 'sch-1', schedule: null, runs: [run('run-1')], latest: run('run-1'),
    title: 'Nightly scan', kind: 'once', unread: false,
  };
}

beforeEach(() => {
  harness.modalProps = null;
  harness.createCalls.length = 0;
  harness.copyCalls.length = 0;
});

describe('NewProjectModal shared shell', () => {
  it('uses controlled bare chrome and keeps Enter submission', () => {
    const onClose = vi.fn();
    const tree = render(<NewProjectModal onClose={onClose} />);

    act(() => harness.modalProps.onOpenChange(false));
    expect(onClose).toHaveBeenCalledOnce();

    const input = tree.root.findByType('input');
    act(() => input.props.onChange({ target: { value: 'atlas' } }));
    act(() => input.props.onKeyDown({ key: 'Enter' }));
    expect(harness.createCalls).toEqual(['atlas']);
  });
});

describe('SessionIdModal shared shell', () => {
  it('keeps data hooks and copy actions while Radix owns dismissal', () => {
    const onClose = vi.fn();
    const tree = render(<SessionIdModal cortexId="cortex-7" backendUuid="uuid-7" onClose={onClose} />);

    act(() => harness.modalProps.onOpenChange(false));
    expect(onClose).toHaveBeenCalledOnce();

    const copy = tree.root.findAllByType('span').find((node) => node.children.includes('Copy'))!;
    act(() => copy.props.onClick());
    expect(harness.copyCalls).toEqual([['cortex-7', 'cortexId']]);
  });
});

describe('RunListModal shared shell', () => {
  it('preserves backdrop hook, run opening, and manage handoff', () => {
    const onClose = vi.fn();
    const onOpenRun = vi.fn();
    const onManage = vi.fn();
    const value = { ...row(), schedule: {
      id: 'sch-1', type: 'daily', message: 'Nightly scan', projectId: 'proj', profile: null,
      nextRun: null, lastRun: null, paused: false, pausedBy: null, intervalMs: null,
      time: '00:00', dayOfWeek: null, target: null, fallback: null,
    } } as ScheduleRow;
    const tree = render(<RunListModal row={value} selectedSessionId={null}
      onOpenRun={onOpenRun} onManage={onManage} onClose={onClose} />);

    act(() => harness.modalProps.onOpenChange(false));
    act(() => tree.root.findByProps({ 'data-run-row': 'run-1' }).props.onClick());
    act(() => tree.root.findByProps({ 'data-action': 'run-list-manage' }).props.onClick());
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenRun).toHaveBeenCalledWith('run-1');
    expect(onManage).toHaveBeenCalledOnce();
  });

  it('offers mark-all-read for the unread runs only, and hides it once nothing is unread', () => {
    const onMarkAllRead = vi.fn();
    const unreadRow = {
      ...row(),
      runs: [{ ...run('run-1'), unread: true }, run('run-2')],
      unread: true,
    } as ScheduleRow;
    const tree = render(<RunListModal row={unreadRow} selectedSessionId={null}
      onOpenRun={vi.fn()} onMarkAllRead={onMarkAllRead} onClose={vi.fn()} />);
    act(() => tree.root.findByProps({ 'data-action': 'run-list-mark-read' }).props.onClick());
    expect(onMarkAllRead).toHaveBeenCalledWith(['run-1']);

    const readTree = render(<RunListModal row={row()} selectedSessionId={null}
      onOpenRun={vi.fn()} onMarkAllRead={onMarkAllRead} onClose={vi.fn()} />);
    expect(readTree.root.findAllByProps({ 'data-action': 'run-list-mark-read' })).toHaveLength(0);
  });
});
