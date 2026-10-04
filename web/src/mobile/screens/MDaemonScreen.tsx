import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { useDaemonResource } from '@/features/daemon/useDaemonResource';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { isNativeShell } from '@/lib/desktop-config';
import { disconnectShell } from '@/lib/shell-connection';
import { MDaemonView, type MDaemonCopy } from './MDaemonView';
import { buildDaemonVm } from './m-daemon-vm';

const COPY: { en: MDaemonCopy; zh: MDaemonCopy } = {
  en: {
    title: 'Daemon',
    connConnected: 'connected',
    connConnecting: 'connecting',
    connReconnecting: 'reconnecting',
    connDisconnected: 'disconnected',
    schedules: (n) => `schedules ${n}`,
    uptimeLabel: 'uptime',
    dash: '—',
    lastRestartLabel: 'Last restart',
    recentTitle: 'Recent events',
    recentEmpty: 'No recent activity',
    rebuildTitle: 'rebuild',
    rebuildProgress: (done, total) => `${done}/${total} steps`,
    rebuildTriggerLabel: 'trigger:',
    status: { running: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled', stale: 'stale' },
    rebuildStatus: { running: 'running', succeeded: 'succeeded', aborted: 'aborted', deferred: 'deferred' },
    softRestart: 'Soft restart',
    forceKill: 'Force kill',
    holdHint: 'Keep holding…',
    footerNote: 'Soft restart waits for idle agents · Force kill: hold 2s, interrupts running agents',
    sent: 'Restart signal sent',
    failed: 'Restart failed',
    disconnect: 'Disconnect',
    disconnectNote: 'Clears the saved login and returns to sign-in',
  },
  zh: {
    title: 'Daemon',
    connConnected: '已连接',
    connConnecting: '连接中',
    connReconnecting: '正在重连',
    connDisconnected: '已断开',
    schedules: (n) => `${n} 个定时任务`,
    uptimeLabel: '运行时长',
    dash: '—',
    lastRestartLabel: '上次重启',
    recentTitle: '最近事件',
    recentEmpty: '暂无最近活动',
    rebuildTitle: '热重建',
    rebuildProgress: (done, total) => `${done}/${total} 步`,
    rebuildTriggerLabel: '触发：',
    status: { running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', stale: '过期' },
    rebuildStatus: { running: '运行中', succeeded: '成功', aborted: '已中止', deferred: '已推迟' },
    softRestart: '软重启',
    forceKill: '强制终止',
    holdHint: '继续按住…',
    footerNote: '软重启等 Agent 空闲后执行 · 强制终止需长按 2s，会打断运行中的 Agent',
    sent: '重启信号已发送',
    failed: '重启失败',
    disconnect: '断开连接',
    disconnectNote: '清除已保存的登录信息并返回登录页',
  },
};

function useMobileDaemonVm() {
  const trpc = useTRPC();
  const schedules = useQuery(trpc.schedules.list.queryOptions({}));
  const executions = useQuery(trpc.executions.list.queryOptions({ limit: 5 }));
  const daemon = useDaemonResource();
  const lang = useLang();
  const ok = !schedules.isError;
  const vm = useMemo(() => buildDaemonVm({
    schedules: schedules.data ?? [],
    executions: executions.data ?? [],
    daemon: daemon.daemon,
    ok,
    lang,
  }), [schedules.data, executions.data, daemon.daemon, ok, lang]);
  return { daemon, vm };
}

export function MDaemonScreen() {
  const navigate = useNavigate();
  const copy = pickCopy(useLang(), COPY);
  const connStatus = useConnectionStatus();
  const { daemon, vm } = useMobileDaemonVm();
  return <MDaemonView
    vm={vm}
    copy={copy}
    connStatus={connStatus}
    restartState={daemon.restartState}
    showDisconnect={isNativeShell()}
    onBack={() => navigate('/m/settings')}
    onSoftRestart={() => daemon.restart('soft')}
    onHardRestart={() => daemon.restart('hard')}
    onDisconnect={() => void disconnectShell()}
  />;
}
