import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApprovalsRequestReturn,
  MachineDetail,
  MachineInfo,
} from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import type { TimeLang } from '@/lib/time-format';
import { buildMachineDetailVm, formatUptime, type MachineDetailVm } from './machine-detail-vm';

const ROSTER_REFRESH_MS = 10_000;
const PROBE_REFRESH_MS = 5_000;

export type MachineDetailStatus = 'offline' | 'probing' | 'error' | 'ready';

export interface MachineDetailResource {
  machine: MachineInfo;
  status: MachineDetailStatus;
  facts: MachineDetailVm | null;
  uptime: string;
}

export interface MachinesResource {
  machines: MachineInfo[];
  loading: boolean;
  error: Error | null;
  detailFor: (machineName: string) => MachineDetailResource | undefined;
  requestAddMachine: (machineName: string) => Promise<ApprovalsRequestReturn>;
  addPending: boolean;
}

function asError(value: unknown): Error | null {
  if (!value) return null;
  if (value instanceof Error) return value;
  const message = typeof value === 'object' && 'message' in value ? String(value.message) : String(value);
  return new Error(message);
}

function uniqueOnlineMachines(machines: MachineInfo[], expanded: readonly string[]): MachineInfo[] {
  const wanted = new Set(expanded);
  return machines.filter((machine) => machine.online && wanted.delete(machine.name));
}

function offlineDetails(machines: MachineInfo[], expanded: readonly string[]): Map<string, MachineDetailResource> {
  const wanted = new Set(expanded);
  return new Map(machines.filter((machine) => !machine.online && wanted.has(machine.name)).map((machine) => [
    machine.name,
    { machine, status: 'offline', facts: null, uptime: '' },
  ]));
}

function queriedDetail(
  machine: MachineInfo,
  query: { data?: MachineDetail; isError: boolean },
  lang: TimeLang,
): MachineDetailResource {
  if (query.isError) {
    return { machine, status: 'error', facts: null, uptime: '' };
  }
  if (!query.data) {
    return { machine, status: 'probing', facts: null, uptime: '' };
  }
  return {
    machine, status: 'ready',
    facts: buildMachineDetailVm(query.data, lang),
    uptime: formatUptime(query.data.vitals?.uptimeSec ?? null, lang),
  };
}

export function useMachinesResource(expanded: readonly string[] = []): MachinesResource {
  const trpc = useTRPC();
  const lang = useLang();
  const queryClient = useQueryClient();
  const roster = useQuery({
    ...trpc.machines.list.queryOptions({}),
    refetchInterval: ROSTER_REFRESH_MS,
  });
  const machines = roster.data ?? [];
  const online = uniqueOnlineMachines(machines, expanded);
  const probes = useQueries({ queries: online.map((machine) => ({
    ...trpc.machines.detail.queryOptions({ machine: machine.name }),
    refetchInterval: PROBE_REFRESH_MS,
  })) });
  const details = offlineDetails(machines, expanded);
  online.forEach((machine, index) => details.set(machine.name, queriedDetail(machine, probes[index], lang)));
  const add = useMutation(trpc.approvals.request.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries(trpc.approvals.list.queryFilter()),
  }));
  return {
    machines, loading: roster.isLoading, error: asError(roster.error),
    detailFor: (machineName) => details.get(machineName),
    requestAddMachine: (machineName) => add.mutateAsync({
      kind: 'add-machine', machineName: machineName.trim(),
    }),
    addPending: add.isPending,
  };
}
