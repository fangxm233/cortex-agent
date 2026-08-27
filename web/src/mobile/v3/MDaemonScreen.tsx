// input:  shared daemon resource, independent mobile summaries, connection and shell helpers
// output: mobile daemon drill screen with long-press restart control
// pos:    Mobile adapter for canonical daemon lifecycle and mobile-only activity
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { threadScopeFilter } from '@/features/workbench/scope';
import { useDaemonResource } from '@/features/daemon/useDaemonResource';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { isNativeShell } from '@/lib/desktop-config';
import { disconnectShell } from '@/lib/shell-connection';
import { MDaemonView, type MDaemonCopy, type RestartState } from './MDaemonView';
import { buildDaemonVm } from './m-daemon-vm';

const COPY: { en: MDaemonCopy; zh: MDaemonCopy } = {
  en: {
    title: 'Daemon',
    connConnected: 'connected',
    connConnecting: 'connecting',
    connReconnecting: 'reconnecting',
    connDisconnected: 'disconnected',
    threadsRunning: (n) => `${n} threads running`,
    schedules: (n) => `schedules ${n}`,
    uptimeLabel: 'uptime',
    dash: '—',
    lastRestartLabel: 'Last restart',
    recentTitle: 'Recent events',
    recentGap: 'daemon event log not exposed on web — showing recent executions',
    recentEmpty: 'No recent activity',
    status: { running: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled', stale: 'stale' },
    softRestart: 'Soft restart',
    forceKill: 'Force kill',
    softNote: (n) => `pauses ${n} running thread(s)`,
    holdHint: 'Keep holding…',
    footerNote:
      'Soft restart keeps thread state and auto-resumes · Force kill needs a 2s long-press; running threads are marked interrupted',
    sent: 'Restart signal sent',
    failed: 'Restart failed',
    disconnect: 'Disconnect',
    disconnectNote: 'Clears the saved server & token, returns to the login screen',
  },
  zh: {
    title: 'Daemon',
    connConnected: '已连接',
    connConnecting: '连接中',
    connReconnecting: '正在重连',
    connDisconnected: '已断开',
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
    disconnect: '断开连接',
    disconnectNote: '清除已保存的服务器与令牌，返回登录页',
  },
};

const ACTIVE_THREAD_PARAMS = { status: threadScopeFilter('active') };

function useMobileDaemonVm() {
  const trpc = useTRPC();
  const threads = useQuery(trpc.threads.list.queryOptions(ACTIVE_THREAD_PARAMS));
  const schedules = useQuery(trpc.schedules.list.queryOptions({}));
  const executions = useQuery(trpc.executions.list.queryOptions({ limit: 5 }));
  const daemon = useDaemonResource();
  const ok = !threads.isError && !schedules.isError;
  const vm = useMemo(() => buildDaemonVm({
    threads: threads.data ?? [],
    schedules: schedules.data ?? [],
    executions: executions.data ?? [],
    daemon: daemon.daemon,
    ok,
  }), [threads.data, schedules.data, executions.data, daemon.daemon, ok]);
  return { daemon, vm };
}

export function MDaemonScreen() {
  const navigate = useNavigate();
  const copy = pickCopy(useLang(), COPY);
  const connStatus = useConnectionStatus();
  const { daemon, vm } = useMobileDaemonVm();
  const restartState: RestartState = daemon.restartState;
  return <MDaemonView
    vm={vm}
    copy={copy}
    connStatus={connStatus}
    restartState={restartState}
    showDisconnect={isNativeShell()}
    onBack={() => navigate('/m/settings')}
    onSoftRestart={() => daemon.restart('soft')}
    onHardRestart={() => daemon.restart('hard')}
    onDisconnect={() => void disconnectShell()}
  />;
}
