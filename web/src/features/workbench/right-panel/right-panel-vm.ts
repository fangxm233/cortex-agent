import type { MachineInfo } from '@cortex-agent/ui-contract';
import { formatUsd } from '@/lib/format';
import type { Vocab } from '@/i18n';

export interface Pill {
  bg: string;
  fg: string;
  text: string;
}

export interface RightPanelBudget {
  todayLabel: string;
  limitLabel: string;
  percent: number;
}

/** Project-scoped daily spend, limit, and clamped progress for the right-panel budget bar. */
export function rightPanelBudget(
  today: number | undefined,
  dailyLimit: number | undefined,
): RightPanelBudget {
  const todayLabel = typeof today === 'number' ? formatUsd(today) : '—';
  if (dailyLimit == null || dailyLimit <= 0) {
    return { todayLabel, limitLabel: '—', percent: 0 };
  }
  const percent = Math.max(0, Math.min(100, ((today ?? 0) / dailyLimit) * 100));
  return { todayLabel, limitLabel: formatUsd(dailyLimit), percent };
}

/** Count of machines currently online (the Machines-tab badge = online, not total). */
export function onlineMachineCount(machines: MachineInfo[] | undefined): number {
  return machines ? machines.filter((m) => m.online).length : 0;
}

/**
 * Machine online status → status-pill colors + label.
 * Online maps to the done-green pair; offline to the default grey.
 */
export function machinePill(online: boolean, L: Pick<Vocab, 'wbMachineOnline' | 'wbMachineOffline'>): Pill {
  return online
    ? { bg: 'var(--pill-done-bg)', fg: 'var(--pill-done-fg)', text: L.wbMachineOnline }
    : { bg: 'var(--pill-cancelled-bg)', fg: 'var(--pill-cancelled-fg)', text: L.wbMachineOffline };
}
