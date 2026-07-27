import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CostSummary } from '@cortex-agent/ui-contract';
import { MProjectView, type MProjectCopy, type MProjectViewProps } from './MProjectView';

const copy: MProjectCopy = {
  title: '项目',
  daemonConnected: 'daemon 已连接',
  daemonConnecting: 'daemon 连接中',
  daemonReconnecting: 'daemon 正在重连',
  daemonDisconnected: 'daemon 已断开',
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
    connStatus: 'connected',
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
      {
        id: 'atlas', initials: 'AT', running: 1, todayCost: 0.87,
        unread: 0, actionRequired: 0, badgeCount: 0, badgeTone: null,
      },
      {
        id: 'orchard', initials: 'OR', running: 0, todayCost: null,
        unread: 0, actionRequired: 0, badgeCount: 0, badgeTone: null,
      },
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

  it('renders the header title + daemon-connected status (green var(--m-done) dot, no qn tag)', () => {
    const html = render();
    expect(html).toContain('项目');
    expect(html).toContain('daemon 已连接');
    expect(html).toContain('var(--m-done)');
  });

  it('shows the reconnecting state (amber pulsing dot) when the link is reconnecting', () => {
    const html = render({ connStatus: 'reconnecting' });
    expect(html).toContain('daemon 正在重连');
    expect(html).toContain('var(--m-amber)');
    expect(html).toContain('cxpulse'); // dot pulses while (re)connecting
    expect(html).not.toContain('daemon 已连接');
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

  it('badges unread-only switch rows with the combined count in the accent tone', () => {
    const withUnread = render({
      switchRows: [{
        id: 'atlas', initials: 'AT', running: 0, todayCost: null,
        unread: 3, actionRequired: 0, badgeCount: 3, badgeTone: 'unread',
      } as never],
    });
    expect(withUnread).toMatch(
      /aria-label="project attention" style="[^"]*background:var\(--m-run\)/,
    );
    expect(withUnread).toContain('>3<');
  });

  it('adds action to unread and turns the same badge amber when action is required', () => {
    const withAction = render({
      switchRows: [{
        id: 'atlas', initials: 'AT', running: 0, todayCost: null,
        unread: 2, actionRequired: 1, badgeCount: 3, badgeTone: 'action',
      } as never],
    });
    expect(withAction).toMatch(
      /aria-label="project attention" style="[^"]*background:var\(--m-amber\)/,
    );
    expect(withAction).toContain('>3<');
  });

  it('hides the project attention badge when unread + action is zero', () => {
    expect(render()).not.toContain('aria-label="project attention"');
  });

  it('renders the 新建项目 dashed card without the removed hint/footer copy', () => {
    const html = render();
    expect(html).toContain('新建项目');
    expect(html).not.toContain('只填名字');
    expect(html).not.toContain('点行即切换');
  });

  it('shows the disconnected daemon state (red dot) when the link is down', () => {
    const html = render({ connStatus: 'disconnected' });
    expect(html).toContain('daemon 已断开');
    expect(html).toContain('var(--m-fail)');
    expect(html).not.toContain('daemon 已连接');
  });
});
