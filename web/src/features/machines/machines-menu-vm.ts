import type { MachineInfo } from '@cortex-agent/ui-contract';
import { formatUsd } from '@/lib/format';

export interface Pill {
  bg: string;
  fg: string;
  text: string;
}

export interface TodayBudget {
  todayLabel: string;
  limitLabel: string;
  percent: number;
}

/** Project-scoped daily spend, limit, and clamped progress for the machines menu budget bar. */
export function todayBudget(today: number | undefined, dailyLimit: number | undefined): TodayBudget {
  const todayLabel = typeof today === 'number' ? formatUsd(today) : '—';
  if (dailyLimit == null || dailyLimit <= 0) {
    return { todayLabel, limitLabel: '—', percent: 0 };
  }
  const percent = Math.max(0, Math.min(100, ((today ?? 0) / dailyLimit) * 100));
  return { todayLabel, limitLabel: formatUsd(dailyLimit), percent };
}

/** Count of machines currently online. */
export function onlineMachineCount(machines: MachineInfo[] | undefined): number {
  return machines ? machines.filter((m) => m.online).length : 0;
}

/** Top-bar chip text: `online/total`, or a dash while the roster is unknown. */
export function machinesChipLabel(machines: MachineInfo[], known: boolean): { online: string; total: string } {
  if (!known) return { online: '—', total: '' };
  return { online: String(onlineMachineCount(machines)), total: `/${machines.length}` };
}

/** Machine online status → status-pill colors + label. */
export function machinePill(online: boolean, labels: { online: string; offline: string }): Pill {
  return online
    ? { bg: 'var(--pill-done-bg)', fg: 'var(--pill-done-fg)', text: labels.online }
    : { bg: 'var(--pill-cancelled-bg)', fg: 'var(--pill-cancelled-fg)', text: labels.offline };
}
