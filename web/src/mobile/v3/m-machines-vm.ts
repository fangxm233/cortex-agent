// Pure view-model for the 1k 机器 screen (scheme-mobile.dc.html 1k L556-599). The machines registry
// drilled from the project page (1e→1k). Maps the REAL `MachineInfo` DTO (machines.json static config +
// live client-manager + executionRegistry) into card slots. Reuses the machine-domain logic from the
// prior 12c impl (machineCardVm / fmtConnectedZh) so mobile stays single-sourced.
//
// 守则11 no-fabrication — every rendered field has a real DTO source or is explicitly omitted:
//   • per-GPU util / VRAM bars (scheme `GPU0 · 4090 82% · 18.2G`) → NO DTO source → rendered as the
//     honest `gpuCount` count only (see MMachinesView GAP comment).
//   • client version (scheme `client v0.4.2`) → NO DTO source → omitted.
//   • running-execution NAME (scheme `cortex-run exp-024…`) → only `liveRuns` count exists → `N 运行中`.
//   • heartbeat → fmtConnectedZh(lastHeartbeat); '—' when offline (DTO gives null timestamps offline).
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { machineCardVm, fmtConnectedZh } from '@/mobile/screens/mobile-machines-vm';

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
}

export interface MMachinesVm {
  cards: MMachineCard[];
  /** Machines currently connected (for the `daemon · N/M 在线` header status). */
  onlineCount: number;
  total: number;
}

/** Map the real `machines.list` DTO array into the 1k screen view-model. */
export function buildMMachinesVm(machines: MachineInfo[], now: number = Date.now()): MMachinesVm {
  const cards: MMachineCard[] = machines.map((m) => {
    const base = machineCardVm(m);
    return {
      name: base.name,
      online: base.online,
      os: base.os,
      gpuCount: base.gpuCount,
      liveRuns: base.liveRuns,
      heartbeat: fmtConnectedZh(m.lastHeartbeat, now),
    };
  });
  return {
    cards,
    onlineCount: cards.filter((c) => c.online).length,
    total: cards.length,
  };
}
