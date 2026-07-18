import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CostSummary } from '@cortex-agent/ui-contract';
import { MProjectView, type MProjectCopy, type MProjectViewProps } from './MProjectView';

const copy: MProjectCopy = {
  title: '项目',
  daemonConnected: 'daemon 已连接',
  daemonDisconnected: 'daemon 未连接',
  current: '当前',
  threadsRunning: '线程运行中',
  needsYou: '需要你',
  perDay: '日',
  week: '本周',
  month: '本月',
  forecastToday: '预测今日',
  approvals: '审批',
  pending: '待处理',
  threadsWaiting: '线程暂停等待',
  handle: '处理',
  memory: '项目记忆',
  machines: '机器',
  machinesOk: '台正常',
  settings: '设置',
  switchProject: '切换项目',
  running: '运行中',
  today: '今日',
  idle: '空闲',
  newProject: '新建项目',
  newProjectHint: '只填名字，初始化在对话里做',
  footer: '点行即切换：会话 / 运行 / 任务同步换到该项目，会话落到最近一条',
  issuesTitle: 'Issues',
};

function cost(over: Partial<CostSummary> = {}): CostSummary {
  return {
    today: 4.21,
    week: 18.6,
    month: 61.13,
    total: 100,
    byMode: {},
    byProject: {},
    byTrigger: {},
    bySource: {},
    byBackend: {},
    tokens: {
      today: { input: 0, output: 0 },
      month: { input: 0, output: 0 },
      total: { input: 0, output: 0 },
    },
    entryCount: 0,
    dailyBudget: 10,
    forecastToday: 8.9,
    dailyCost: [],
    byTriggerScoped: {},
    ...over,
  };
}

const noop = () => {};

function baseProps(over: Partial<MProjectViewProps> = {}): MProjectViewProps {
  return {
    copy,
    connected: true,
    current: {
      id: 'nimbus',
      initials: 'NI',
      runningThreads: 2,
      waitingThreads: 1,
      needsYou: 2,
      cost: cost(),
    },
    pendingApprovals: 2,
    onlineMachines: 3,
    switchRows: [
      { id: 'atlas', initials: 'AT', running: 1, todayCost: 0.87, unread: 0 },
      { id: 'orchard', initials: 'OR', running: 0, todayCost: null, unread: 0 },
    ],
    issues: { count: 4, previews: ['EXP-023 验证集 return 回落', 'gpu-02 磁盘剩余 6%'] },
    onIssues: noop,
    onApprovals: noop,
    onMemory: noop,
    onMachines: noop,
    onSettings: noop,
    onSwitch: noop,
    onNewProject: noop,
    ...over,
  };
}

function render(over: Partial<MProjectViewProps> = {}) {
  return renderToStaticMarkup(<MProjectView {...baseProps(over)} />);
}

describe('MProjectView', () => {
  it('renders the Issues card (24a): title + count pill + previews + `+ N more`', () => {
    const html = render();
    expect(html).toContain('Issues');
    expect(html).toContain('>4<');
    expect(html).toContain('EXP-023 验证集 return 回落');
    expect(html).toContain('gpu-02 磁盘剩余 6%');
    expect(html).toContain('+ 2 more');
  });

  it('hides the Issues card at 0 issues (为 0 时整项隐藏)', () => {
    const html = render({ issues: { count: 0, previews: [] } });
    expect(html).not.toContain('Issues');
  });

  it('renders the header title + daemon-connected status (green var(--proto-success) dot, no qn tag)', () => {
    const html = render();
    expect(html).toContain('项目');
    expect(html).toContain('daemon 已连接');
    expect(html).toContain('var(--m-done)');
  });

  it('renders the current-project card: name (=id), 当前 badge, real thread + needs-you sub-line', () => {
    const html = render();
    expect(html).toContain('nimbus');
    expect(html).toContain('当前');
    expect(html).toContain('2 线程运行中');
    expect(html).toContain('2 需要你');
  });

  it('renders the budget row from REAL cost fields only (today / dailyBudget / week / month / forecast)', () => {
    const html = render();
    expect(html).toContain('$4.21');
    expect(html).toContain('/ $10.00 日');
    expect(html).toContain('本周');
    expect(html).toContain('$18.60');
    expect(html).toContain('本月');
    expect(html).toContain('$61.13');
    expect(html).toContain('预测今日 $8.90');
    // bar width = budgetPercent(4.21, 10) = 42.1%
    expect(html).toContain('42.1%');
  });

  it('omits the budget row entirely when scoped cost is unavailable (no fabricated $0)', () => {
    const html = render({ current: { ...baseProps().current!, cost: null } });
    expect(html).not.toContain('$4.21');
    expect(html).not.toContain(' 日');
  });

  it('renders the amber approval bar when pending > 0 (待处理 count + waiting threads + 处理)', () => {
    const html = render();
    expect(html).toContain('审批 · 2 待处理');
    expect(html).toContain('1 线程暂停等待');
    expect(html).toContain('处理');
    expect(html).toContain('var(--m-amber)'); // amber dot
  });

  it('hides the amber approval bar when there are no pending approvals', () => {
    const html = render({ pendingApprovals: 0, current: { ...baseProps().current!, needsYou: 0 } });
    expect(html).not.toContain('待处理');
  });

  it('renders the info list: 项目记忆 / 机器 · N 台正常 / 设置', () => {
    const html = render();
    expect(html).toContain('项目记忆');
    expect(html).toContain('机器 · 3 台正常');
    expect(html).toContain('设置');
  });

  it('renders the 切换项目 divider and the OTHER projects with honest sub-lines', () => {
    const html = render();
    expect(html).toContain('切换项目');
    expect(html).toContain('atlas');
    expect(html).toContain('AT');
    expect(html).toContain('1 运行中');
    expect(html).toContain('今日 $0.87');
    expect(html).toContain('orchard');
    expect(html).toContain('空闲');
  });

  it('badges a switch row that has unread sessions (accent count), and none when unread=0', () => {
    const withUnread = render({
      switchRows: [{ id: 'atlas', initials: 'AT', running: 0, todayCost: null, unread: 3 }],
    });
    expect(withUnread).toContain('aria-label="unread"');
    expect(withUnread).toContain('>3<');

    const noUnread = render();
    expect(noUnread).not.toContain('aria-label="unread"');
  });

  it('renders the 新建项目 dashed card + footer line', () => {
    const html = render();
    expect(html).toContain('新建项目');
    expect(html).toContain('只填名字');
    expect(html).toContain('点行即切换');
  });

  it('shows the disconnected daemon state honestly when not connected', () => {
    const html = render({ connected: false });
    expect(html).toContain('daemon 未连接');
    expect(html).not.toContain('daemon 已连接');
  });
});
