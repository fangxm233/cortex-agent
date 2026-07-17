import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { groupMobileTasks, executableCount, allCount } from '@/mobile/mobile-tasks';
import { buildMTaskGroups } from './m-tasks-vm';
import { MTasksView, type MTasksCopy } from './MTasksView';

const copy: MTasksCopy = {
  title: '任务',
  executable: '可执行',
  all: '全部',
  inProgress: '进行中',
  claimable: '可执行',
  blocked: '阻塞',
  claim: '认领',
  doneWhen: 'done-when',
  doneWhenGap: 'done-when 未记录',
  waitApproval: '等待审批',
  seeApprovals: '见项目页审批',
  done: '完成',
  empty: '暂无任务',
};

function task(over: Partial<TaskInfo>): TaskInfo {
  return {
    id: 'T-000',
    text: 'a task',
    project: 'nimbus',
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

function render(tasks: TaskInfo[], expanded: string[] = []) {
  const grouped = groupMobileTasks(tasks);
  return renderToStaticMarkup(
    <MTasksView
      groups={buildMTaskGroups(grouped, 'all')}
      segment="all"
      executableCount={executableCount(grouped)}
      allCount={allCount(grouped)}
      scope="NI"
      copy={copy}
      expandedIds={new Set(expanded)}
      onToggleExpand={() => {}}
      onSegment={() => {}}
      onOpenTask={() => {}}
      onOpenThread={() => {}}
      onOpenApprovals={() => {}}
    />,
  );
}

describe('MTasksView', () => {
  it('renders the header title, passive scope tag, and both segment counts', () => {
    const html = render([task({ id: 'A', actionable: true })]);
    expect(html).toContain('任务');
    expect(html).toContain('NI');
    expect(html).toContain('可执行 1');
    expect(html).toContain('全部 1');
  });

  it('in-progress row: T-id + 认领 pill with the real thread id, run color, no fabricated 步骤', () => {
    const html = render([task({ id: 'T-041', text: '跑 DR 扫描', claimedBy: 'thr_8f2c' })]);
    expect(html).toContain('T-041');
    expect(html).toContain('认领');
    expect(html).toContain('thr_8f2c');
    expect(html).toContain('#4655D4'); // running/run accent
    expect(html).not.toContain('步骤'); // no step fraction — no DTO source
  });

  it('claimable collapsed: ▸ chevron, no done-when box', () => {
    const html = render([task({ id: 'T-042', actionable: true, doneWhen: 'X' })]);
    expect(html).toContain('▸');
    expect(html).not.toContain('#F7F8FA'); // done-when box background not present when collapsed
  });

  it('claimable expanded: ▾ chevron + real done-when in the mono box', () => {
    const html = render(
      [task({ id: 'T-042', actionable: true, doneWhen: '报告落 reports/DR-sweep.md' })],
      ['T-042'],
    );
    expect(html).toContain('▾');
    expect(html).toContain('#F7F8FA'); // done-when box
    expect(html).toContain('报告落 reports/DR-sweep.md');
  });

  it('claimable expanded with null done-when: honest gap, no fabrication', () => {
    const html = render([task({ id: 'T-042', actionable: true, doneWhen: null })], ['T-042']);
    expect(html).toContain('done-when 未记录');
  });

  it('blocked row: dimmed, amber approval line with the real ref → 见项目页审批', () => {
    const html = render([task({ id: 'T-038', text: '消融扫描', blockedBy: 'APR-0007' })]);
    expect(html).toContain('opacity:0.75');
    expect(html).toContain('等待审批');
    expect(html).toContain('APR-0007');
    expect(html).toContain('见项目页审批');
    expect(html).toContain('#A96B0B'); // amber approval text
  });

  it('全部 segment shows a 完成 group with done rows and counts them in 全部', () => {
    const html = render([
      task({ id: 'T-050', actionable: true }),
      task({ id: 'T-051', text: '收尾报告', status: 'done' }),
    ]);
    expect(html).toContain('完成 · 1'); // done group header
    expect(html).toContain('T-051');
    expect(html).toContain('收尾报告');
    expect(html).toContain('全部 2'); // done counted in 全部
    expect(html).toContain('可执行 1'); // but not in the executable count
  });

  it('truncates the task text to a single line (ellipsis parity with desktop)', () => {
    const html = render([task({ id: 'T-052', actionable: true, text: 'a very long task title' })]);
    expect(html).toContain('ellipsis');
    expect(html).toContain('white-space:nowrap');
  });

  it('shows the empty state when there are no groups', () => {
    const html = render([]);
    expect(html).toContain('暂无任务');
  });
});
