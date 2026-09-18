import type { UiServiceDeps, MachineDetail, MachineDetailParams, MachineLiveRun } from '../types.js';
import { buildProbeCommand, parseMachineProbe, PROBE_TIMEOUT_MS } from './machine-probe.js';

/** Running dispatch executions on this machine. Process pids are deliberately NOT matched against
 *  the GPU probe: dispatch.pid is the launcher, not the CUDA process, so any such join would be
 *  fabricated. */
function collectLiveRuns(deps: UiServiceDeps, machine: string): MachineLiveRun[] {
  return deps.executionRegistry
    .getAll()
    .filter((exec) => exec?.status === 'running' && exec?.dispatch?.machine === machine)
    .map((exec) => ({
      executionId: String(exec.id),
      taskId: exec.dispatch?.taskId ?? null,
      project: exec.project ?? null,
      startedAt: exec.runtime?.startedAt ?? null,
    }));
}

function emptyDetail(name: string, online: boolean, liveRuns: MachineLiveRun[], probeError: string | null): MachineDetail {
  return { name, online, vitals: null, gpus: [], liveRuns, probedAt: null, probeError };
}

export async function handleMachineDetail(
  deps: UiServiceDeps,
  params: MachineDetailParams,
): Promise<MachineDetail> {
  const entry = deps.clientRegistry.getMachineRegistry()[params.machine];
  if (!entry) throw new Error(`Unknown machine: ${params.machine}`);

  const liveRuns = collectLiveRuns(deps, params.machine);

  // Offline devices are answered from the registry alone — never a round trip that can only time out.
  if (!deps.clientRegistry.isDeviceOnline(params.machine)) {
    return emptyDetail(params.machine, false, liveRuns, null);
  }

  const probe = deps.clientRegistry.probeMachine;
  if (!probe) return emptyDetail(params.machine, true, liveRuns, 'Probe transport unavailable');

  try {
    const raw = await probe(params.machine, buildProbeCommand(entry.cortexPath), PROBE_TIMEOUT_MS);
    const { vitals, gpus } = parseMachineProbe(raw);
    return {
      name: params.machine,
      online: true,
      vitals,
      gpus,
      liveRuns,
      probedAt: new Date().toISOString(),
      probeError: null,
    };
  } catch (err) {
    return emptyDetail(params.machine, true, liveRuns, err instanceof Error ? err.message : String(err));
  }
}
