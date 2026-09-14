import type { DaemonProcessInfo, SystemDaemonStatus } from '@cortex-agent/ui-contract';
import type { Tone } from '@/design/tone';

export interface DaemonExtraVm {
  key: string;
  value: string | number;
}

export interface DaemonProcessVm extends Omit<DaemonProcessInfo, 'extras'> {
  tone: Tone;
  extras: DaemonExtraVm[];
}

export interface DaemonVm {
  processes: DaemonProcessVm[];
  lastRestart: SystemDaemonStatus['lastRestart'] | null;
}

export function daemonStatusTone(status: DaemonProcessInfo['status']): Tone {
  if (status === 'running') return 'done';
  if (status === 'stopped') return 'failed';
  return 'cancelled';
}

function processVm(process: DaemonProcessInfo): DaemonProcessVm {
  const extras = process.extras
    ? Object.entries(process.extras).map(([key, value]) => ({ key, value }))
    : [];
  return { ...process, tone: daemonStatusTone(process.status), extras };
}

export function buildDaemonVm(status: SystemDaemonStatus | null | undefined): DaemonVm {
  if (!status) return { processes: [], lastRestart: null };
  return {
    processes: status.processes.map(processVm),
    lastRestart: status.lastRestart,
  };
}
