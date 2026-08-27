// input:  mounted machine resource, roster/detail transports, polling and approval outcomes
// output: shared roster, expanded-online probe, status and add-machine lifecycle regressions
// pos:    Headless desktop/mobile machines resource specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApprovalsRequestReturn, MachineDetail, MachineInfo } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMachinesResource, type MachinesResource } from './useMachinesResource';

const adapter = vi.hoisted(() => ({
  list: vi.fn<() => Promise<MachineInfo[]>>(),
  detail: vi.fn<(machine: string) => Promise<MachineDetail>>(),
  request: vi.fn<(input: unknown) => Promise<ApprovalsRequestReturn>>(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    machines: {
      list: { queryOptions: () => ({ queryKey: ['machines.list'], queryFn: adapter.list }) },
      detail: { queryOptions: ({ machine }: { machine: string }) => ({
        queryKey: ['machines.detail', { machine }], queryFn: () => adapter.detail(machine),
      }) },
    },
    approvals: { request: { mutationOptions: (options: object) => ({
      ...options, mutationFn: (input: unknown) => adapter.request(input),
    }) } },
  }),
}));

function machine(name: string, online = true): MachineInfo {
  return {
    name, online, cortexPath: '/srv/.cortex', gpuCount: 2, sshConfigured: true,
    os: 'unix', connectedAt: online ? '2026-08-03T10:00:00.000Z' : null,
    lastHeartbeat: online ? '2026-08-03T11:59:59.000Z' : null,
    capabilities: online ? ['gpu'] : [], liveRuns: 0,
  };
}

function detail(name: string, probeError: string | null = null): MachineDetail {
  return {
    name, online: true, vitals: null, gpus: [], liveRuns: [],
    probedAt: probeError ? null : '2026-08-03T12:00:00.000Z', probeError,
  };
}

let resource: MachinesResource | null = null;

function Probe({ expanded }: { expanded: string[] }) {
  resource = useMachinesResource(expanded);
  return null;
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(expanded: string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: {
    queries: { retry: false }, mutations: { retry: false },
  } });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<QueryClientProvider client={queryClient}><Probe expanded={expanded} /></QueryClientProvider>);
  });
  await flush();
  await flush();
  return { queryClient, renderer: renderer! };
}

beforeEach(() => {
  resource = null;
  Object.values(adapter).forEach((mock) => mock.mockReset());
  adapter.list.mockResolvedValue([]);
  adapter.detail.mockImplementation(async (name) => detail(name));
  adapter.request.mockResolvedValue({ queued: true, id: 'approval-1' });
});

describe('useMachinesResource', () => {
  it('polls the roster every 10 seconds and exposes list failures', async () => {
    adapter.list.mockResolvedValue([machine('atlas')]);
    const mounted = await mount();
    const query = mounted.queryClient.getQueryCache().find({ queryKey: ['machines.list'] });
    expect((query?.options as { refetchInterval?: number }).refetchInterval).toBe(10_000);
    expect(resource?.machines.map((item) => item.name)).toEqual(['atlas']);
    mounted.renderer.unmount();

    adapter.list.mockRejectedValue(new Error('roster unavailable'));
    const failed = await mount();
    expect(resource?.loading).toBe(false);
    expect(resource?.error?.message).toBe('roster unavailable');
    failed.renderer.unmount();
  });

});

describe('machine detail lifecycle', () => {
  it('polls every expanded online machine every 5 seconds and supports multiple cards', async () => {
    adapter.list.mockResolvedValue([machine('atlas'), machine('nimbus'), machine('offline', false)]);
    const { queryClient, renderer } = await mount(['atlas', 'nimbus', 'offline']);
    expect(adapter.detail.mock.calls.map(([name]) => name).sort()).toEqual(['atlas', 'nimbus']);
    for (const name of ['atlas', 'nimbus']) {
      const query = queryClient.getQueryCache().find({ queryKey: ['machines.detail', { machine: name }] });
      expect((query?.options as { refetchInterval?: number }).refetchInterval).toBe(5_000);
      expect(resource?.detailFor(name)?.status).toBe('ready');
    }
    expect(resource?.detailFor('offline')?.status).toBe('offline');
    renderer.unmount();
  });

});

describe('machine detail gating and errors', () => {
  it('does not probe collapsed, unknown or offline machines', async () => {
    adapter.list.mockResolvedValue([machine('atlas'), machine('offline', false)]);
    const { renderer } = await mount(['offline', 'ghost']);
    expect(adapter.detail).not.toHaveBeenCalled();
    expect(resource?.detailFor('atlas')).toBeUndefined();
    expect(resource?.detailFor('offline')?.status).toBe('offline');
    expect(resource?.detailFor('ghost')).toBeUndefined();
    renderer.unmount();
  });

  it('distinguishes transport failures from probe errors returned as data', async () => {
    adapter.list.mockResolvedValue([machine('atlas'), machine('nimbus')]);
    adapter.detail.mockImplementation(async (name) => {
      if (name === 'atlas') throw new Error('transport down');
      return detail(name, 'nvidia-smi missing');
    });
    const { renderer } = await mount(['atlas', 'nimbus']);
    expect(resource?.detailFor('atlas')).toMatchObject({ status: 'error' });
    expect(resource?.detailFor('atlas')?.error?.message).toBe('transport down');
    expect(resource?.detailFor('nimbus')).toMatchObject({ status: 'ready' });
    expect(resource?.detailFor('nimbus')?.facts?.probeError).toBe('nvidia-smi missing');
    renderer.unmount();
  });

});

describe('machine approval lifecycle', () => {
  it('queues trimmed add-machine approvals and exposes pending or rejected operations', async () => {
    let reject: ((error: Error) => void) | undefined;
    adapter.request.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const { renderer } = await mount();
    let pending: Promise<ApprovalsRequestReturn> | undefined;
    await act(async () => {
      pending = resource?.requestAddMachine(' atlas ');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(adapter.request).toHaveBeenCalledWith({ kind: 'add-machine', machineName: 'atlas' });
    expect(resource?.addPending).toBe(true);
    await act(async () => { reject?.(new Error('approval denied')); await pending?.catch(() => undefined); });
    await flush();
    expect(resource?.addPending).toBe(false);
    expect(resource?.addError?.message).toBe('approval denied');
    renderer.unmount();
  });
});
