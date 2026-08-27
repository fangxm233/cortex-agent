// input:  mounted approval queue, approval outcomes, feedback drafts, and query cache
// output: pending-list, decision payload, pending-state, and invalidation regressions
// pos:    Shared desktop/mobile approval queue integration specification
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useApprovalQueue, type ApprovalQueue } from './useApprovalQueue';

const adapter = vi.hoisted(() => ({
  list: vi.fn<() => Promise<ApprovalInfo[]>>(),
  approve: vi.fn<(args: { id: string }) => Promise<unknown>>(),
  reject: vi.fn<(args: { id: string; feedback?: string }) => Promise<unknown>>(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    approvals: {
      list: {
        queryOptions: (input: object) => ({
          queryKey: ['approvals.list', input],
          queryFn: () => adapter.list(),
        }),
        queryFilter: () => ({ queryKey: ['approvals.list'] }),
      },
      approve: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: (args: { id: string }) => adapter.approve(args),
        }),
      },
      reject: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: (args: { id: string; feedback?: string }) => adapter.reject(args),
        }),
      },
    },
  }),
}));

function approval(id: string): ApprovalInfo {
  return {
    id,
    title: `Approval ${id}`,
    projectId: null,
    operation: null,
    reason: null,
    impact: null,
    command: null,
    status: 'pending',
    queuedAt: null,
    decidedAt: null,
    feedback: null,
    provenance: null,
    taskRef: null,
  };
}

let queue: ApprovalQueue | null = null;

function Probe({ enabled = true }: { enabled?: boolean }) {
  queue = useApprovalQueue({ enabled });
  return null;
}

async function mount(enabled = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <Probe enabled={enabled} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { invalidate, queryClient, renderer: renderer! };
}

beforeEach(() => {
  queue = null;
  adapter.list.mockReset();
  adapter.approve.mockReset();
  adapter.reject.mockReset();
  adapter.list.mockResolvedValue([]);
  adapter.approve.mockResolvedValue({});
  adapter.reject.mockResolvedValue({});
});

describe('useApprovalQueue', () => {
  it('loads only the pending approval list and supports disabled desktop mounting', async () => {
    adapter.list.mockResolvedValue([approval('a'), approval('b')]);
    const mounted = await mount();

    expect(queue?.entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(adapter.list).toHaveBeenCalledTimes(1);
    mounted.renderer.unmount();
    mounted.queryClient.clear();

    const disabled = await mount(false);
    expect(adapter.list).toHaveBeenCalledTimes(1);
    expect(queue?.entries).toEqual([]);
    disabled.renderer.unmount();
    disabled.queryClient.clear();
  });

  it('approves by id, exposes decision pending, and invalidates every approval list when settled', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    adapter.approve.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { invalidate, queryClient, renderer } = await mount();
    let decision: Promise<void> | undefined;

    await act(async () => {
      decision = queue?.approve('apr-1');
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(adapter.approve).toHaveBeenCalledWith({ id: 'apr-1' });
    expect(queue?.isPending).toBe(true);

    await act(async () => {
      resolve?.({});
      await decision;
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(queue?.isPending).toBe(false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['approvals.list'] });
    renderer.unmount();
    queryClient.clear();
  });

  it('trims reject feedback and sends undefined for a blank draft through the same refresh path', async () => {
    const { invalidate, queryClient, renderer } = await mount();

    await act(async () => {
      await queue?.reject('apr-2', '  explain this  ');
      await queue?.reject('apr-3', '   ');
    });

    expect(adapter.reject).toHaveBeenNthCalledWith(1, {
      id: 'apr-2',
      feedback: 'explain this',
    });
    expect(adapter.reject).toHaveBeenNthCalledWith(2, { id: 'apr-3', feedback: undefined });
    expect(invalidate).toHaveBeenCalledTimes(2);
    renderer.unmount();
    queryClient.clear();
  });

  it('also invalidates the pending list when a decision fails', async () => {
    adapter.reject.mockRejectedValue(new Error('denied'));
    const { invalidate, queryClient, renderer } = await mount();

    await act(async () => {
      await expect(queue?.reject('apr-4')).rejects.toThrow('denied');
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['approvals.list'] });
    renderer.unmount();
    queryClient.clear();
  });
});
