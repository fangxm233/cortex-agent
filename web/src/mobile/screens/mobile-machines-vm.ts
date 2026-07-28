// input:  machine DTOs and wall-clock time
// output: active mobile machine-card models and relative connection time
// pos:    Shared pure helpers retained from the legacy mobile screen
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { MachineInfo } from '@cortex-agent/ui-contract';

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
 * Format a connected-since ISO timestamp as a relative ZH string (e.g. "3m 前", "2h 前").
 * Returns '—' when the input is null/missing/unparseable or in the future.
 */
export function fmtConnectedZh(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = now - t;
  if (diff < 0) return '—';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h 前`;
  const day = Math.floor(hr / 24);
  return `${day}d 前`;
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
