import type { MachineInfo } from '@cortex-agent/ui-contract';

export interface Pill {
  bg: string;
  fg: string;
  text: string;
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
