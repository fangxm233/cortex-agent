import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { useDaemonResource } from '@/features/daemon/useDaemonResource';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { isNativeShell } from '@/lib/desktop-config';
import { disconnectShell } from '@/lib/shell-connection';
import { MDaemonView } from './MDaemonView';
import { buildDaemonVm } from './m-daemon-vm';

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
  const connStatus = useConnectionStatus();
  const { daemon, vm } = useMobileDaemonVm();
  return <MDaemonView
    vm={vm}
    connStatus={connStatus}
    restartState={daemon.restartState}
    showDisconnect={isNativeShell()}
    onBack={() => navigate('/m/settings')}
    onSoftRestart={() => daemon.restart('soft')}
    onHardRestart={() => daemon.restart('hard')}
    onDisconnect={() => void disconnectShell()}
  />;
}
