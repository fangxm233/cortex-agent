import { t } from '@core/i18n.js';
import type { UiServiceDeps, MachineDetail, QueryParams } from '../types.js';
import { buildProbeCommand, parseMachineProbe, PROBE_TIMEOUT_MS } from './machine-probe.js';

function emptyDetail(name: string, online: boolean, probeError: string | null): MachineDetail {
  return { name, online, vitals: null, gpus: [], liveRuns: [], probedAt: null, probeError };
}

export async function handleMachineDetail(
  deps: UiServiceDeps,
  params: QueryParams<'machines.detail'>,
): Promise<MachineDetail> {
  const entry = deps.clientRegistry.getMachineRegistry()[params.machine];
  if (!entry) throw new Error(t('ui.machine.unknown', { name: params.machine }));

  // Offline devices are answered from the registry alone — never a round trip that can only time out.
  if (!deps.clientRegistry.isDeviceOnline(params.machine)) {
    return emptyDetail(params.machine, false, null);
  }

  try {
    const raw = await deps.clientRegistry.probeMachine(params.machine, buildProbeCommand(entry.cortexPath), PROBE_TIMEOUT_MS);
    const { vitals, gpus } = parseMachineProbe(raw);
    return {
      name: params.machine,
      online: true,
      vitals,
      gpus,
      liveRuns: [],
      probedAt: new Date().toISOString(),
      probeError: null,
    };
  } catch (err) {
    return emptyDetail(params.machine, true, err instanceof Error ? err.message : String(err));
  }
}
