import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { zh } from '@/i18n';
import { groupMobileTasks, orderedGroups } from '../mobile-tasks';
import { MobileTasksView } from './MobileTasksView';

function task(over: Partial<TaskInfo>): TaskInfo {
  return {
    id: 'T-000',
    text: 'a task',
    project: 'cortex-self',
    status: 'open',
    priority: 'medium',
    actionable: false,
    claimedBy: null,
    blockedBy: null,
    dependsOn: [],
    plan: null,
    template: 'coder-review',
    why: null,
    doneWhen: null,
    ...over,
  };
}

const tasks = [
  task({ id: 'A', claimedBy: 'thr_abcd' }), // in-progress
  task({ id: 'B', actionable: true, priority: 'high' }), // claimable
  task({ id: 'C', dependsOn: ['A'] }), // waiting-deps
  task({ id: 'D', blockedBy: 'robot SSH unreachable' }), // blocked
];

function view(opts: { segment?: 'executable' | 'all'; expanded?: string[] } = {}) {
  const segment = opts.segment ?? 'all';
  const grouped = groupMobileTasks(tasks);
  return renderToStaticMarkup(
    <MobileTasksView
      vocab={zh}
      groups={orderedGroups(grouped, segment)}
      segment={segment}
      executableCount={2}
      allCount={4}
      onSegment={() => {}}
      expandedIds={new Set(opts.expanded ?? [])}
      onToggleExpand={() => {}}
      pendingId={null}
      onUnblock={() => {}}
      empty={zh.mNoTasks}
    />,
  );
}

describe('MobileTasksView', () => {
  it('renders the 5c slot marker and reserves the status-bar gutter', () => {
    const html = view();
    expect(html).toContain('data-screen-label="5c"');
    expect(html).toContain('padding-top:env(safe-area-inset-top)');
  });

  it('renders the 任务 title and the 可执行/全部 segmented control with counts', () => {
    const html = view();
    expect(html).toContain('任务');
    expect(html).toContain('可执行 2');
    expect(html).toContain('全部 4');
  });

  it('renders all four group headers with counts in the all segment', () => {
    const html = view({ segment: 'all' });
    expect(html).toContain('进行中 · 1');
    expect(html).toContain('可认领 · 1');
    expect(html).toContain('等依赖 · 1');
    expect(html).toContain('已阻塞 · 1');
  });

  it('shows only 进行中 + 可认领 in the executable segment', () => {
    const html = view({ segment: 'executable' });
    expect(html).toContain('进行中 · 1');
    expect(html).toContain('可认领 · 1');
    expect(html).not.toContain('等依赖');
    expect(html).not.toContain('已阻塞');
  });

  it('renders real task ids/text and the claimed-by pill with the 认领 label (scheme L3130)', () => {
    const html = view();
    expect(html).toContain('认领 · thr_abcd'); // scheme pill = "认领 · <claimedBy>"
    expect(html).not.toContain('T-041'); // scheme mock id must not leak
  });

  it('expands a claimable card to the DONE-WHEN section with an honest placeholder when the task has none', () => {
    const html = view({ expanded: ['B'] });
    expect(html).toContain('完成标准（DONE WHEN）');
    expect(html).toContain(zh.mDoneWhenGap);
    expect(html).toContain('aria-expanded="true"');
  });

  it('renders the real done-when text (not the placeholder) when the claimable task has one', () => {
    const withDoneWhen = [task({ id: 'B', actionable: true, priority: 'high', doneWhen: 'suite passes and build is green' })];
    const html = renderToStaticMarkup(
      <MobileTasksView
        vocab={zh}
        groups={orderedGroups(groupMobileTasks(withDoneWhen), 'all')}
        segment="all"
        executableCount={1}
        allCount={1}
        onSegment={() => {}}
        expandedIds={new Set(['B'])}
        onToggleExpand={() => {}}
        pendingId={null}
        onUnblock={() => {}}
        empty={zh.mNoTasks}
      />,
    );
    expect(html).toContain('suite passes and build is green');
    expect(html).not.toContain(zh.mDoneWhenGap);
  });

  it('does not show the DONE-WHEN section when the claimable card is collapsed', () => {
    const html = view();
    expect(html).not.toContain('完成标准（DONE WHEN）');
  });

  it('renders the blocked reason + 解除 unblock action', () => {
    const html = view();
    expect(html).toContain('robot SSH unreachable');
    expect(html).toContain('阻塞');
    expect(html).toContain('解除');
  });

  it('renders the dependency + auto-unlock meta for waiting-deps', () => {
    const html = view();
    expect(html).toContain('依赖 A');
    expect(html).toContain('自动解锁');
  });

  it('renders the empty note when no groups', () => {
    const html = renderToStaticMarkup(
      <MobileTasksView
        vocab={zh}
        groups={[]}
        segment="executable"
        executableCount={0}
        allCount={0}
        onSegment={() => {}}
        expandedIds={new Set()}
        onToggleExpand={() => {}}
        pendingId={null}
        onUnblock={() => {}}
        empty={zh.mNoTasks}
      />,
    );
    expect(html).toContain('暂无任务');
  });
});
