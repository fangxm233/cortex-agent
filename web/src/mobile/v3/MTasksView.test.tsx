// input:  Mobile task groups, copy, and lifecycle task fixtures
// output: Mobile task sections and one-line blocker regressions
// pos:    Rendering tests for the mobile Tasks view
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { MTasksView, type MTasksCopy } from './MTasksView';
import type { MTaskGroupView } from './m-tasks-vm';

const copy: MTasksCopy = {
  title: 'Tasks',
  inProgress: 'In progress',
  actionable: 'Actionable',
  approvalNeeded: 'Approval needed',
  waiting: 'Waiting',
  blocked: 'Blocked',
  claim: 'claimed',
  needs: 'needs',
  doneWhen: 'done-when',
  doneWhenGap: 'no done-when recorded',
  openApprovals: 'open approvals',
  done: 'Done',
  empty: 'No tasks',
};

function task(overrides: Partial<TaskInfo>): TaskInfo {
  return {
    id: 'task-a',
    text: 'a task',
    project: 'nimbus',
    status: 'open',
    priority: 'medium',
    actionable: false,
    claimedBy: null,
    claimThreadId: null,
    blockedBy: null,
    approvalNeeded: false,
    dependsOn: [],
    plan: null,
    template: 'coder-review',
    why: null,
    doneWhen: null,
    ...overrides,
  };
}

function renderGroups(groups: MTaskGroupView[]): string {
  return renderToStaticMarkup(
    <MTasksView
      groups={groups}
      copy={copy}
      expandedIds={new Set()}
      onToggleExpand={() => {}}
      onOpenTask={() => {}}
      onOpenThread={() => {}}
      onOpenApprovals={() => {}}
    />,
  );
}

describe('MTasksView', () => {
  it('renders all six lifecycle sections without segmented scope controls', () => {
    const html = renderGroups([
      { key: 'in-progress', tasks: [task({ id: 'running', claimedBy: 'task-dispatcher', claimThreadId: 'thr_run' })] },
      { key: 'actionable', tasks: [task({ id: 'ready', actionable: true })] },
      { key: 'approval-needed', tasks: [task({ id: 'approval', approvalNeeded: true })] },
      { key: 'waiting-deps', tasks: [task({ id: 'waiting', dependsOn: ['dependency'] })] },
      { key: 'blocked', tasks: [task({ id: 'blocked', blockedBy: 'robot offline' })] },
      { key: 'done', tasks: [task({ id: 'done', status: 'done' })] },
    ]);

    for (const label of ['In progress', 'Actionable', 'Approval needed', 'Waiting', 'Blocked', 'Done']) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('Last 1 day');
  });

  it('shows the owning thread instead of task-dispatcher for in-progress cards', () => {
    const html = renderGroups([
      { key: 'in-progress', tasks: [task({ claimedBy: 'task-dispatcher', claimThreadId: 'thr_run' })] },
    ]);
    expect(html).toContain('claimed · thr_run');
    expect(html).not.toContain('task-dispatcher');
  });

  it('shows needs only on waiting cards', () => {
    const waiting = renderGroups([{ key: 'waiting-deps', tasks: [task({ dependsOn: ['dep-done', 'dep-open'], unmetDependencyIds: ['dep-open'] })] }]);
    const actionable = renderGroups([{ key: 'actionable', tasks: [task({ actionable: true, dependsOn: ['dep-a'] })] }]);
    const done = renderGroups([{ key: 'done', tasks: [task({ status: 'done', dependsOn: ['dep-a'] })] }]);

    expect(waiting).toContain('needs dep-open');
    expect(waiting).not.toContain('dep-done');
    expect(actionable).not.toContain('needs');
    expect(done).not.toContain('needs');
  });

  it('shows the completion time on done cards only', () => {
    const completedAt = new Date(2026, 7, 3, 14, 22, 33).toISOString();
    const done = renderGroups([{ key: 'done', tasks: [task({ status: 'done', completedAt })] }]);
    const unrecorded = renderGroups([{ key: 'done', tasks: [task({ status: 'done' })] }]);

    expect(done).toContain('2026-08-03 14:22');
    expect(unrecorded).not.toContain('2026-08-03');
  });

  it('keeps approval-needed and generic blocked metadata distinct', () => {
    const approval = renderGroups([{ key: 'approval-needed', tasks: [task({ approvalNeeded: true })] }]);
    const blocked = renderGroups([{ key: 'blocked', tasks: [task({ blockedBy: 'robot offline' })] }]);

    expect(approval).toContain('open approvals');
    expect(blocked).toContain('Blocked · robot offline');
    expect(blocked).not.toContain('open approvals');
  });

  it('truncates blocked details to one line', () => {
    const html = renderGroups([{ key: 'blocked', tasks: [task({ blockedBy: 'A long external blocker description' })] }]);
    const blockerStyle = html.match(/data-task-blocker="true" style="([^"]+)"/)?.[1];

    expect(blockerStyle).toBeDefined();
    expect(blockerStyle).toContain('white-space:nowrap');
    expect(blockerStyle).toContain('overflow:hidden');
    expect(blockerStyle).toContain('text-overflow:ellipsis');
  });
});
