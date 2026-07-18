import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ThreadInfo,
  ScheduleInfo,
  ExecutionInfo,
  SystemDaemonStatus,
  DaemonProcessInfo,
} from '@cortex-agent/ui-contract';
import { MDaemonView, type MDaemonCopy } from './MDaemonView';
import { buildDaemonVm } from './m-daemon-vm';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

const copy: MDaemonCopy = {
  title: 'Daemon',
  statusOk: '运行正常',
  statusErr: '连接异常',
  threadsRunning: (n) => `${n} 线程运行中`,
  schedules: (n) => `schedules ${n}`,
  uptimeLabel: 'uptime',
  dash: '—',
  lastRestartLabel: '上次重启',
  recentTitle: '最近事件',
  recentGap: 'Web 未提供 daemon 事件日志，以下为最近执行',
  recentEmpty: '暂无最近活动',
  status: { running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', stale: '过期' },
  softRestart: '软重启',
  forceKill: '强制终止',
  softNote: (n) => `先暂停 ${n} 个运行中线程`,
  holdHint: '继续按住…',
  footerNote: '软重启不丢线程状态，恢复后自动续跑 · 强制终止需长按 2s 确认，运行中线程标记 interrupted',
  sent: '重启信号已发送',
  failed: '重启失败',
};

function thread(p: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: 'thr_1', templateName: 'coder', currentStep: null, status: 'running', projectId: 'proj',
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), totalSteps: 0, artifactPath: null, ...p,
  };
}
function sched(p: Partial<ScheduleInfo> = {}): ScheduleInfo {
  return { id: 's1', type: 'interval', message: 'scan', projectId: 'proj', profile: null, nextRun: null, lastRun: null, paused: false, pausedBy: null, ...p };
}
function exec(p: Partial<ExecutionInfo> = {}): ExecutionInfo {
  return {
    id: 'exec_1', type: 'dispatch', status: 'running', taskId: null, sessionId: null, projectId: 'proj',
    machine: null, startedAt: new Date(NOW).toISOString(), finishedAt: null, durationMs: null, cost: null, ...p,
  };
}
function proc(p: Partial<DaemonProcessInfo> = {}): DaemonProcessInfo {
  return { name: 'cortex-server', label: 'server', status: 'running', pid: 3021, uptime: '6d 4h', port: 7433, extras: null, ...p };
}
function daemon(p: Partial<SystemDaemonStatus> = {}): SystemDaemonStatus {
  return {
    processes: [proc(), proc({ name: 'cortex-daemon', label: 'daemon', pid: 3038, port: null })],
    lastRestart: { at: null, reason: null },
    ...p,
  };
}

function render(opts: {
  threads?: ThreadInfo[];
  schedules?: ScheduleInfo[];
  executions?: ExecutionInfo[];
  daemon?: SystemDaemonStatus | null;
  ok?: boolean;
  restartState?: 'idle' | 'pending' | 'success' | 'error';
}) {
  const vm = buildDaemonVm({
    threads: opts.threads ?? [],
    schedules: opts.schedules ?? [],
    executions: opts.executions ?? [],
    daemon: opts.daemon ?? null,
    ok: opts.ok ?? true,
    now: NOW,
  });
  return renderToStaticMarkup(
    <MDaemonView
      vm={vm}
      copy={copy}
      restartState={opts.restartState ?? 'idle'}
      onBack={() => {}}
      onSoftRestart={() => {}}
      onHardRestart={() => {}}
    />,
  );
}

const baseThreads = [thread(), thread({ id: 'thr_2', status: 'waiting' })];
const baseScheds = [sched(), sched({ id: 's2' }), sched({ id: 's3' }), sched({ id: 's4' })];

describe('MDaemonView', () => {
  it('renders the drill header title and the 运行正常 pill when reachable', () => {
    const html = render({ ok: true });
    expect(html).toContain('Daemon');
    expect(html).toContain('运行正常');
  });

  it('shows the 连接异常 pill when the daemon is unreachable', () => {
    const html = render({ ok: false });
    expect(html).toContain('连接异常');
    expect(html).not.toContain('运行正常');
  });

  it('renders both process rows with the real counts summary line', () => {
    const html = render({ threads: baseThreads, schedules: baseScheds });
    expect(html).toContain('cortex-server');
    expect(html).toContain('cortex-daemon');
    expect(html).toContain('2 线程运行中');
    expect(html).toContain('schedules 4');
  });

  it('renders REAL pid / port / uptime from a daemonStatus payload', () => {
    const html = render({ daemon: daemon() });
    expect(html).toContain('pid 3021');
    expect(html).toContain(':7433');
    expect(html).toContain('uptime');
    expect(html).toContain('6d 4h');
    expect(html).toContain('pid 3038'); // daemon process pid
    expect(html).toContain('server'); // process label
    expect(html).toContain('daemon'); // process label
  });

  it('colors the process dot by DTO status (running=green, stopped=red, unknown=amber)', () => {
    const html = render({
      daemon: daemon({
        processes: [
          proc({ name: 'cortex-server', status: 'running' }),
          proc({ name: 'cortex-daemon', status: 'stopped' }),
        ],
      }),
    });
    expect(html).toContain('var(--m-done)'); // running green dot
    expect(html).toContain('var(--m-fail)'); // stopped red dot (also force-kill ink, present regardless)
    const amber = render({
      daemon: daemon({ processes: [proc({ status: 'unknown' })] }),
    });
    expect(amber).toContain('var(--m-amber)'); // unknown amber dot
  });

  it('renders honest — for null pid / port / uptime, never fabricated', () => {
    const html = render({
      daemon: daemon({
        processes: [proc({ name: 'cortex-server', pid: null, port: null, uptime: null })],
      }),
    });
    expect(html).toContain('pid —');
    expect(html).toContain('uptime —');
    expect(html).not.toContain('pid 3021');
    expect(html).not.toContain(':7433');
  });

  it('renders process extras (e.g. ws connection count) from the DTO', () => {
    const html = render({
      daemon: daemon({ processes: [proc({ name: 'cortex-server', extras: { ws: 3 } })] }),
    });
    expect(html).toContain('ws');
    expect(html).toContain('3');
  });

  it('surfaces the real lastRestart (at + reason) as an event row in the 最近事件 card', () => {
    const html = render({
      daemon: daemon({
        lastRestart: { at: new Date(NOW - 60 * 60_000).toISOString(), reason: 'manual soft restart' },
      }),
    });
    expect(html).toContain('上次重启');
    expect(html).toContain('1 小时');
    expect(html).toContain('manual soft restart');
  });

  it('does not render a lastRestart row when the daemon recorded none', () => {
    const html = render({ daemon: daemon({ lastRestart: { at: null, reason: null } }) });
    expect(html).not.toContain('上次重启');
  });

  it('renders the recent-activity card from executions with an honest gap disclosure', () => {
    const html = render({
      executions: [exec({ id: 'exec_a', type: 'dispatch', status: 'running', taskId: 't-9f' })],
    });
    expect(html).toContain('最近事件');
    expect(html).toContain('Web 未提供 daemon 事件日志');
    expect(html).toContain('dispatch');
    expect(html).toContain('t-9f');
    expect(html).toContain('运行中'); // status word
  });

  it('shows the empty state when there is no recent activity and no lastRestart', () => {
    const html = render({ executions: [] });
    expect(html).toContain('暂无最近活动');
  });

  it('renders both restart buttons and the footer note', () => {
    const html = render({ threads: baseThreads });
    expect(html).toContain('软重启');
    expect(html).toContain('强制终止');
    expect(html).toContain('先暂停 2 个运行中线程');
    expect(html).toContain('软重启不丢线程状态');
    expect(html).toContain('var(--m-fail)'); // red force-kill ink
  });

  it('surfaces restart result feedback', () => {
    expect(render({ restartState: 'success' })).toContain('重启信号已发送');
    expect(render({ restartState: 'error' })).toContain('重启失败');
  });

  it('does NOT fabricate the scheme daemon.log mocks (api p50 / watchdog / daemon.log / home-server)', () => {
    const html = render({ threads: baseThreads, schedules: baseScheds, daemon: daemon() });
    expect(html).not.toContain('api p50');
    expect(html).not.toContain('daemon.log');
    expect(html).not.toContain('watchdog');
    expect(html).not.toContain('home-server');
    expect(html).not.toContain('backend fallback');
  });
});
