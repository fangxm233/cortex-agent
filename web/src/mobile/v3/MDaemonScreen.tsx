// 1r Daemon 状态 — Daemon liveness + restart controls, drilled from 1l 设置 「Daemon ›」 (scheme-mobile
// .dc.html 1r L888-932). NON-Tab drill page. Real tRPC: system.daemonStatus (per-process name/label/
// status/pid/port/uptime/extras + lastRestart — same query as the desktop 17a modal), threads.list
// (active count), schedules.list (count), executions.list (recent activity), system.restart mutation
// (soft / hard). Only the daemon.log event stream lacks a query scope → the 最近事件 card surfaces the
// REAL lastRestart plus recent executions (see m-daemon-vm 守则11 note); nothing is fabricated.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { threadScopeFilter } from '@/features/workbench/scope';
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

export function MDaemonScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);

  const threadsQuery = useQuery(trpc.threads.list.queryOptions({ status: threadScopeFilter('active') }));
  const schedulesQuery = useQuery(trpc.schedules.list.queryOptions({}));
  const executionsQuery = useQuery(trpc.executions.list.queryOptions({ limit: 5 }));
  // Real per-process status (pid/port/uptime/liveness) + lastRestart — same query as the desktop 17a modal.
  const daemonQuery = useQuery(trpc.system.daemonStatus.queryOptions({}));

  // Daemon reachability — implied by the queries succeeding (drives the process-row fallback status).
  const ok = !threadsQuery.isError && !schedulesQuery.isError;
  // Real UI<->server connectivity (SSE link) — drives the header pill (connected / (re)connecting / down).
  const connStatus = useConnectionStatus();

  const vm = useMemo(
    () =>
      buildDaemonVm({
        threads: threadsQuery.data ?? [],
        schedules: schedulesQuery.data ?? [],
        executions: executionsQuery.data ?? [],
        daemon: daemonQuery.data ?? null,
        ok,
      }),
    [threadsQuery.data, schedulesQuery.data, executionsQuery.data, daemonQuery.data, ok],
  );

  const restartMut = useMutation(
    trpc.system.restart.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.threads.list.queryFilter());
        queryClient.invalidateQueries(trpc.system.daemonStatus.queryFilter());
      },
    }),
  );

  const restartState: RestartState = restartMut.isPending
    ? 'pending'
    : restartMut.isSuccess
      ? 'success'
      : restartMut.isError
        ? 'error'
        : 'idle';

  return (
    <MDaemonView
      vm={vm}
      copy={copy}
      connStatus={connStatus}
      restartState={restartState}
      showDisconnect={isNativeShell()}
      onBack={() => navigate('/m/settings')}
      onSoftRestart={() => restartMut.mutate({ kind: 'soft' })}
      onHardRestart={() => restartMut.mutate({ kind: 'hard' })}
      onDisconnect={() => void disconnectShell()}
    />
  );
}
