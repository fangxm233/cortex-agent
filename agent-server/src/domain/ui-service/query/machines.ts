import type { UiServiceDeps, MachineInfo, MachinesListParams } from '../types.js';

export async function handleMachinesList(
  deps: UiServiceDeps,
  _params: MachinesListParams,
): Promise<MachineInfo[]> {
  const registry = deps.clientRegistry.getMachineRegistry();
  const onlineDevices = deps.clientRegistry.getOnlineDevices();
  const allExecutions = deps.executionRegistry.getAll();

  // Build device-name → online info map for O(1) lookups
  const onlineMap = new Map(onlineDevices.map((d) => [d.device, d]));

  // Count running dispatch executions per machine
  const liveRunsMap = new Map<string, number>();
  for (const exec of allExecutions) {
    const machine = (exec as any).dispatch?.machine;
    if ((exec as any).status === 'running' && typeof machine === 'string' && machine) {
      liveRunsMap.set(machine, (liveRunsMap.get(machine) ?? 0) + 1);
    }
  }

  return Object.entries(registry).map(([name, entry]): MachineInfo => {
    const onlineInfo = onlineMap.get(name);
    return {
      name,
      cortexPath: typeof entry.cortexPath === 'string' ? entry.cortexPath : null,
      gpuCount: typeof entry.gpuCount === 'number' ? entry.gpuCount : null,
      // ssh presence flag only — raw user@host is never exposed
      sshConfigured: typeof entry.ssh === 'string' && entry.ssh.length > 0,
      os: entry.win === true ? 'windows' : 'unix',
      online: !!onlineInfo,
      connectedAt: onlineInfo ? onlineInfo.connectedAt.toISOString() : null,
      lastHeartbeat: onlineInfo ? onlineInfo.lastHeartbeat.toISOString() : null,
      capabilities: onlineInfo ? [...onlineInfo.capabilities] : [],
      liveRuns: liveRunsMap.get(name) ?? 0,
    };
  });
}
