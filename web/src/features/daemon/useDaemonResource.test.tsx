// input:  mounted daemon resource, status/restart transports and query cache
// output: polling, restart state and exact daemon/broad thread invalidation regressions
// pos:    Headless desktop/mobile daemon resource specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  SystemDaemonStatus,
  SystemRestartArgs,
  SystemRestartReturn,
} from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDaemonResource, type DaemonResource } from './useDaemonResource';

const adapter = vi.hoisted(() => ({
  status: vi.fn<() => Promise<SystemDaemonStatus>>(),
  restart: vi.fn<(args: SystemRestartArgs) => Promise<SystemRestartReturn>>(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    system: {
      daemonStatus: {
        queryOptions: () => ({ queryKey: ['system.daemonStatus', {}], queryFn: adapter.status }),
      },
      restart: {
        mutationOptions: (options: object) => ({ ...options, mutationFn: adapter.restart }),
      },
    },
    threads: {
      list: {
        queryFilter: () => ({ queryKey: ['threads.list'] }),
      },
    },
  }),
}));

const DAEMON_STATUS: SystemDaemonStatus = {
  processes: [{
    name: 'cortex-daemon', label: 'supervisor', status: 'running', pid: 42,
    uptime: '1h', port: null, extras: null,
  }],
  lastRestart: { at: null, reason: null },
};

let resource: DaemonResource | null = null;

function Probe({ enabled }: { enabled: boolean }) {
  resource = useDaemonResource({ enabled });
  return null;
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(enabled = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<QueryClientProvider client={queryClient}>
      <Probe enabled={enabled} />
    </QueryClientProvider>);
  });
  await flush();
  return { invalidate, queryClient, renderer: renderer! };
}

beforeEach(() => {
  resource = null;
  Object.values(adapter).forEach((mock) => mock.mockReset());
  adapter.status.mockResolvedValue(DAEMON_STATUS);
  adapter.restart.mockResolvedValue({ ok: true, message: 'sent' });
});

describe('useDaemonResource status lifecycle', () => {
  it('polls daemon status every 5 seconds and exposes canonical facts', async () => {
    const { queryClient, renderer } = await mount();
    const query = queryClient.getQueryCache().find({ queryKey: ['system.daemonStatus', {}] });
    expect((query?.options as { refetchInterval?: number }).refetchInterval).toBe(5_000);
    expect(resource?.loading).toBe(false);
    expect(resource?.daemon).toEqual(DAEMON_STATUS);
    expect(resource?.facts.processes[0]).toMatchObject({ name: 'cortex-daemon', tone: 'done' });
    renderer.unmount();
  });

  it('disables both the status request and poll when its consumer is closed', async () => {
    const { queryClient, renderer } = await mount(false);
    const query = queryClient.getQueryCache().find({ queryKey: ['system.daemonStatus', {}] });
    expect(adapter.status).not.toHaveBeenCalled();
    expect((query?.options as { refetchInterval?: false }).refetchInterval).toBe(false);
    renderer.unmount();
  });

  it('exposes status transport failures without inventing process facts', async () => {
    adapter.status.mockRejectedValue(new Error('daemon unavailable'));
    const { renderer } = await mount();
    expect(resource?.loading).toBe(false);
    expect(resource?.error?.message).toBe('daemon unavailable');
    expect(resource?.facts.processes).toEqual([]);
    renderer.unmount();
  });
});

describe('useDaemonResource restart lifecycle', () => {
  it('sends restart kinds and invalidates exact status plus every thread list', async () => {
    const { invalidate, renderer } = await mount();
    await act(async () => {
      resource?.restart('hard');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    expect(adapter.restart.mock.calls[0]?.[0]).toEqual({ kind: 'hard' });
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['system.daemonStatus', {}], exact: true }],
      [{ queryKey: ['threads.list'] }],
    ]);
    expect(resource?.restartState).toBe('success');
    renderer.unmount();
  });

  it('exposes pending and error without invalidating after a rejected restart', async () => {
    let reject: ((error: Error) => void) | undefined;
    adapter.restart.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const { invalidate, renderer } = await mount();
    await act(async () => {
      resource?.restart('soft');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(resource?.restartState).toBe('pending');
    await act(async () => {
      reject?.(new Error('restart denied'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    expect(resource?.restartState).toBe('error');
    expect(resource?.restartError?.message).toBe('restart denied');
    expect(invalidate).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
