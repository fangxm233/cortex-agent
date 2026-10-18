import type { MachineInfo } from '@cortex-agent/ui-contract';
import { fmt } from '@/i18n/fmt';
import { pickVocab } from '@/i18n/lang';
import type { TimeLang } from '@/i18n/time-format';
import { formatSince } from './machine-detail-vm';

/** Count of machines currently online. */
export function onlineMachineCount(machines: MachineInfo[] | undefined): number {
  return machines ? machines.filter((m) => m.online).length : 0;
}

/** Top-bar chip text: `online/total`, or a dash while the roster is unknown. */
export function machinesChipLabel(machines: MachineInfo[], known: boolean): { online: string; total: string } {
  if (!known) return { online: '—', total: '' };
  return { online: String(onlineMachineCount(machines)), total: `/${machines.length}` };
}

/** Menu header count: `1/1 online` · `1/1 在线`, or a dash while the roster is unknown. */
export function machinesOnlineText(machines: MachineInfo[], known: boolean, lang: TimeLang): string {
  if (!known) return '—';
  return fmt(pickVocab(lang).mOnlineCount, { online: onlineMachineCount(machines), total: machines.length });
}

/** Trailing meta of a machine row: `heartbeat 2s ago` · `心跳 2秒前`; '' when it never beat (offline). */
export function machineHeartbeatText(machine: MachineInfo, lang: TimeLang, now: number = Date.now()): string {
  const span = formatSince(machine.lastHeartbeat, lang, now);
  if (!span) return '';
  const L = pickVocab(lang);
  return `${L.mHeartbeat} ${fmt(L.timeAgo, { span })}`;
}

/** The line under a machine's name: `2 × RTX 6000 Ada · unix · connected 30m`. The GPU model is only
 *  known once the card has been probed (and only when every card matches); until then it says GPU. */
export function machineMetaText(
  machine: MachineInfo,
  gpuModel: string | null,
  lang: TimeLang,
  now: number = Date.now(),
): string {
  const L = pickVocab(lang);
  const connected = formatSince(machine.connectedAt, lang, now);
  return [
    machine.gpuCount == null ? '' : `${machine.gpuCount} × ${gpuModel ?? L.mGpu}`,
    machine.os,
    connected ? `${L.mConnectedFor} ${connected}` : '',
  ].filter(Boolean).join(' · ');
}
