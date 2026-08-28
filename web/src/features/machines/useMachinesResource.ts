// input:  expanded machine names, machines/approvals tRPC contracts and query cache
// output: shared polled roster, detail facts and approval request/cache lifecycle
// pos:    Headless desktop/mobile machines resource
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApprovalsRequestReturn,
  MachineDetail,
  MachineInfo,
} from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { buildMachineDetailVm, formatUptime, type MachineDetailVm } from './machine-detail-vm';

const ROSTER_REFRESH_MS = 10_000;
const PROBE_REFRESH_MS = 5_000;

export type MachineDetailStatus = 'offline' | 'probing' | 'error' | 'ready';

export interface MachineDetailResource {
  machine: MachineInfo;
  status: MachineDetailStatus;
  detail: MachineDetail | null;
  facts: MachineDetailVm | null;
  uptime: string;
  error: Error | null;
}

export interface MachinesResource {
  machines: MachineInfo[];
  loading: boolean;
  error: Error | null;
  detailFor: (machineName: string) => MachineDetailResource | undefined;
  requestAddMachine: (machineName: string) => Promise<ApprovalsRequestReturn>;
  addPending: boolean;
  addError: Error | null;
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
    { machine, status: 'offline', detail: null, facts: null, uptime: '', error: null },
  ]));
}

function queriedDetail(
  machine: MachineInfo,
  query: { data?: MachineDetail; error: unknown; isError: boolean },
): MachineDetailResource {
  if (query.isError) {
    return { machine, status: 'error', detail: null, facts: null, uptime: '', error: asError(query.error) };
  }
  if (!query.data) {
    return { machine, status: 'probing', detail: null, facts: null, uptime: '', error: null };
  }
  return {
    machine, status: 'ready', detail: query.data,
    facts: buildMachineDetailVm(query.data),
    uptime: formatUptime(query.data.vitals?.uptimeSec ?? null), error: null,
  };
}

export function useMachinesResource(expanded: readonly string[] = []): MachinesResource {
  const trpc = useTRPC();
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
  online.forEach((machine, index) => details.set(machine.name, queriedDetail(machine, probes[index])));
  const add = useMutation(trpc.approvals.request.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries(trpc.approvals.list.queryFilter()),
  }));
  return {
    machines, loading: roster.isLoading, error: asError(roster.error),
    detailFor: (machineName) => details.get(machineName),
    requestAddMachine: (machineName) => add.mutateAsync({
      kind: 'add-machine', machineName: machineName.trim(),
    }),
    addPending: add.isPending, addError: asError(add.error),
  };
}
