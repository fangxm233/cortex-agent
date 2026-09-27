import type { MachineInfo } from '@cortex-agent/ui-contract';
import { timeAgo, type TimeLang } from '@/lib/time-format';

// Pure view-model for the mobile machines screen (plan §12 A item 1, mobile part 12c). Maps the
// REAL `MachineInfo` DTO (machines.json static config + live client-manager + executionRegistry) into
// the mobile card slots — name / online dot / liveRuns badge / gpuCount / connected time.
// No fabrication (守则11): every rendered field has a real DTO source or is explicitly omitted.
// cortexPath, sshConfigured, lastHeartbeat, capabilities are not displayed (no card slot for them).
// Framework-free so the DTO→value mapping is unit-testable in isolation.

/** One card row in the mobile machines list. */
export interface MachineCardVm {
  name: string;
  online: boolean;
  liveRuns: number;
  /** null when the machine config has no GPU entry (gpuCount field). */
  gpuCount: number | null;
  os: 'windows' | 'unix';
  /** ISO timestamp to format as connected-since; sourced from connectedAt (null if offline). */
  connectedAt: string | null;
}

/**
 * A heartbeat/connect timestamp as time-ago in the UI language (`3m ago` / `3分钟前`).
 * Returns '—' when the input is null/missing/unparseable or in the future.
 */
export function fmtConnected(iso: string | null | undefined, now: number, lang: TimeLang): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t) || t > now) return '—';
  return timeAgo(t, now, lang);
}

/** Map one MachineInfo DTO to a MachineCardVm. */
export function machineCardVm(m: MachineInfo): MachineCardVm {
  return {
    name: m.name,
    online: m.online,
    liveRuns: m.liveRuns,
    gpuCount: m.gpuCount,
    os: m.os,
    // connectedAt is null when offline (client disconnects); lastHeartbeat is also null offline.
    // Use connectedAt as the "connected since" label; no fallback to lastHeartbeat (that would
    // show a stale offline timestamp, which is misleading).
    connectedAt: m.online ? m.connectedAt : null,
  };
}
