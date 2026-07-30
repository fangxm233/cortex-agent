// input:  Mobile task-detail view model and bilingual copy
// output: Approval, field, and dependency rendering tests
// pos:    Mobile task-detail view regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { MTaskDetailView, ZH_COPY } from './MTaskDetailView';
import { buildTaskDetailVm } from './m-task-detail-vm';

function task(over: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: 'a111',
    text: 'Inspect task details',
    project: 'atlas',
    status: 'open',
    priority: 'medium',
    actionable: false,
    claimedBy: null,
    blockedBy: null,
    dependsOn: [],
    plan: null,
    template: 'manager',
    why: null,
    doneWhen: null,
    ...over,
  };
}

function render(tasks: TaskInfo[]): string {
  return renderToStaticMarkup(
    <MTaskDetailView
      vm={buildTaskDetailVm('a111', tasks, null)}
      copy={ZH_COPY}
      onBack={() => {}}
      onOpenThread={() => {}}
    />,
  );
}

describe('MTaskDetailView fields', () => {
  it('renders the stored status and template and names the empty dependency state', () => {
    const html = render([task()]);
    expect(html).toContain('状态');
    expect(html).toContain('open');
    expect(html).toContain('模板');
    expect(html).toContain('manager');
    expect(html).toContain('无依赖');
  });

  it('renders pending and completed approval state', () => {
    const pending = render([task({ approvalNeeded: true, approvedAt: null })]);
    expect(pending).toContain('需要审批');
    expect(pending).toContain('approval-needed');
    expect(pending).toContain('批准时间');

    const approved = render([task({ approvalNeeded: false, approvedAt: '2026-07-30' })]);
    expect(approved).toContain('2026-07-30');
  });

  it('renders real dependencies instead of the empty-state copy', () => {
    const html = render([
      task({ dependsOn: ['b222'] }),
      task({ id: 'b222', text: 'Upstream task', status: 'done' }),
    ]);
    expect(html).toContain('T-b222');
    expect(html).not.toContain('无依赖');
  });
});
