//
// 守则11 no-fabrication — every rendered field has a real DTO source or is explicitly omitted:
//   • per-GPU util / VRAM bars and the running-run NAME live in the machines.detail probe, which the
//     container fetches only for the expanded card — they are NOT part of this collapsed-card vm.
//   • client version (scheme `client v0.4.2`) → NO DTO source → omitted.
//   • heartbeat → fmtConnected(lastHeartbeat) in the UI language; '—' when offline (DTO gives null timestamps offline).
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { formatSince } from '@/features/machines/machine-detail-vm';
import { timeAgo, type TimeLang } from '@/lib/time-format';

export interface MMachineCard {
  name: string;
  online: boolean;
  /** Platform family — used as the faint role tag (real DTO field; scheme's `workstation` is a mock). */
  os: 'windows' | 'unix';
  /** null when machines.json has no gpuCount entry → GPU line omitted. */
  gpuCount: number | null;
  /** Running dispatch executions on this machine (real count; run name is not in the DTO). */
  liveRuns: number;
  /** Relative heartbeat label ("3s 前" / "5m 前" …); '—' when offline (null lastHeartbeat). */
  heartbeat: string;
  /** Connection age ("3h 0m"); '' when the machine has never connected. Expand panel only. */
  connectedFor: string;
  /** Capabilities advertised on connect; [] when offline. Expand panel only. */
  capabilities: string[];
  cortexPath: string | null;
  sshConfigured: boolean;
}

export interface MMachinesVm {
  cards: MMachineCard[];
  /** Machines currently connected (for the `daemon · N/M 在线` header status). */
  onlineCount: number;
  total: number;
}

/**
 * A heartbeat/connect timestamp as time-ago in the UI language (`3m ago` / `3分钟前`).
 * Returns '—' when the input is null/missing/unparseable or in the future.
 */
function fmtConnected(iso: string | null | undefined, now: number, lang: TimeLang): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t) || t > now) return '—';
  return timeAgo(t, now, lang);
}

/** Map the real `machines.list` DTO array into the 1k screen view-model. */
export function buildMMachinesVm(machines: MachineInfo[], lang: TimeLang, now: number = Date.now()): MMachinesVm {
  const cards: MMachineCard[] = machines.map((m) => ({
    name: m.name,
    online: m.online,
    os: m.os,
    gpuCount: m.gpuCount,
    liveRuns: m.liveRuns,
    heartbeat: fmtConnected(m.lastHeartbeat, now, lang),
    connectedFor: formatSince(m.connectedAt, lang, now),
    capabilities: m.capabilities,
    cortexPath: m.cortexPath,
    sshConfigured: m.sshConfigured,
  }));
  return {
    cards,
    onlineCount: cards.filter((c) => c.online).length,
    total: cards.length,
  };
}
