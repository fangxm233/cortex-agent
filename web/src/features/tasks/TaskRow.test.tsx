// input:  TaskRow, language provider, and task DTO fixtures
// output: Desktop task-card metadata and affordance regressions
// pos:    Rendering tests for desktop task list cards
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { TaskRow } from './TaskRow';
import type { TaskGroupKind } from './group-tasks';

function task(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: 'task-a',
    text: 'A task',
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

function renderTask(overrides: Partial<TaskInfo>, kind: TaskGroupKind): string {
  return renderToStaticMarkup(
    <LangProvider>
      <TaskRow task={task(overrides)} kind={kind} onOpen={() => {}} />
    </LangProvider>,
  );
}

describe('TaskRow lifecycle metadata', () => {
  it('shows the owning thread instead of the persisted dispatcher claim owner', () => {
    const html = renderTask({ claimedBy: 'task-dispatcher', claimThreadId: 'thr_dispatch' }, 'in-progress');
    expect(html).toContain('claimed · thr_dispatch');
    expect(html).not.toContain('task-dispatcher');
  });

  it('never substitutes a non-thread claim owner when no thread link exists', () => {
    const html = renderTask({ claimedBy: 'agent1', claimThreadId: null }, 'in-progress');
    expect(html).toContain('claimed');
    expect(html).not.toContain('agent1');
  });

  it('shows approval-needed metadata before the legacy actionable flag', () => {
    const html = renderTask({ approvalNeeded: true, actionable: true }, 'approval-needed');
    expect(html).toContain('Approval needed');
    expect(html).not.toContain('medium');
  });

  it('shows needs only for waiting tasks', () => {
    const waiting = renderTask({ actionable: false, dependsOn: ['dep-done', 'dep-open'], unmetDependencyIds: ['dep-open'] }, 'waiting-deps');
    const actionable = renderTask({ actionable: true, dependsOn: ['dep-a'] }, 'actionable');
    const done = renderTask({ status: 'done', dependsOn: ['dep-a'] }, 'done');

    expect(waiting).toContain('needs dep-open');
    expect(waiting).not.toContain('dep-done');
    expect(waiting).not.toContain('✓');
    expect(actionable).not.toContain('needs');
    expect(actionable).not.toContain('medium');
    expect(done).not.toContain('needs');
  });

  it('clamps blocked details to two lines', () => {
    const html = renderTask({ blockedBy: 'A long external blocker description' }, 'blocked');

    expect(html).toContain('display:-webkit-box');
    expect(html).toContain('-webkit-line-clamp:2');
    expect(html).toContain('-webkit-box-orient:vertical');
    expect(html).toContain('overflow:hidden');
  });

  it('does not render an inert overflow-menu affordance', () => {
    expect(renderTask({}, 'actionable')).not.toContain('⋯');
  });
});
