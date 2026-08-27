// input:  mounted thread detail controller, query cache, live sync, timers, and cancel outcomes
// output: shared query/tick/cancel/invalidation lifecycle regressions
// pos:    Headless desktop/mobile thread detail controller specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useThreadDetailController,
  type ThreadDetailController,
} from './useThreadDetailController';

const adapter = vi.hoisted(() => ({
  get: vi.fn<(input: unknown) => Promise<ThreadDetail>>(),
  cancel: vi.fn<(input: unknown) => Promise<unknown>>(),
  liveSync: vi.fn<(threadId: string, includeArtifactContent?: boolean) => void>(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    threads: {
      get: {
        queryOptions: (input: unknown) => ({
          queryKey: ['threads.get', input],
          queryFn: () => adapter.get(input),
        }),
      },
      list: { queryFilter: () => ({ queryKey: ['threads.list'] }) },
      cancel: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: (input: unknown) => adapter.cancel(input),
        }),
      },
    },
  }),
}));

vi.mock('./useThreadGetLiveSync', () => ({
  useThreadGetLiveSync: adapter.liveSync,
}));

function detail(status: ThreadDetail['status'] = 'running'): ThreadDetail {
  return {
    id: 'thr-a', templateName: 'pipeline', currentStep: null, status, projectId: 'sample',
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z', totalSteps: 0,
    artifactPath: null, endedAt: null, error: null, abortReason: null, activeAgent: null,
    activeStage: null, totalCostUsd: 0, steps: [], agentFlow: null, dispatches: [], subtasks: [],
    children: [], artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
  };
}

let controller: ThreadDetailController | null = null;

function Probe({ includeArtifactContent = false, onCancelled }: {
  includeArtifactContent?: boolean;
  onCancelled?: () => void;
}) {
  controller = useThreadDetailController({
    threadId: 'thr-a', includeArtifactContent, onCancelled,
  });
  return null;
}

async function mount(options: {
  includeArtifactContent?: boolean;
  onCancelled?: () => void;
  cached?: ThreadDetail;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const input = options.includeArtifactContent
    ? { threadId: 'thr-a', includeArtifactContent: true }
    : { threadId: 'thr-a' };
  if (options.cached) queryClient.setQueryData(['threads.get', input], options.cached);
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <Probe includeArtifactContent={options.includeArtifactContent} onCancelled={options.onCancelled} />
      </QueryClientProvider>,
    );
    if (!options.cached) await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return { queryClient, renderer: renderer! };
}

beforeEach(() => {
  controller = null;
  adapter.get.mockReset();
  adapter.cancel.mockReset();
  adapter.liveSync.mockReset();
  adapter.get.mockResolvedValue(detail());
  adapter.cancel.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useThreadDetailController', () => {
  it.each([
    [false, { threadId: 'thr-a' }],
    [true, { threadId: 'thr-a', includeArtifactContent: true }],
  ])('loads the exact artifact mode and installs matching live sync (%s)', async (full, input) => {
    const { renderer } = await mount({ includeArtifactContent: full });
    expect(adapter.get).toHaveBeenCalledWith(input);
    expect(adapter.liveSync).toHaveBeenCalledWith('thr-a', full);
    renderer.unmount();
  });

  it('ticks once per second only while the detail is live', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:04:12.000Z'));
    const liveMount = await mount({ cached: detail('waiting') });
    const initial = controller?.now;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(controller?.now).toBe((initial ?? 0) + 1000);
    liveMount.renderer.unmount();

    const terminal = detail('completed');
    terminal.endedAt = '2030-01-01T00:01:00.000Z';
    const doneMount = await mount({ cached: terminal });
    const doneNow = controller?.now;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(controller?.now).toBe(doneNow);
    doneMount.renderer.unmount();
  });

  it.each([false, true])(
    'cancels, invalidates list plus the exact get mode, and calls onCancelled (%s)',
    async (full) => {
      const onCancelled = vi.fn();
      const { queryClient, renderer } = await mount({ includeArtifactContent: full, onCancelled });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

      await act(async () => {
        controller?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const input = full
        ? { threadId: 'thr-a', includeArtifactContent: true }
        : { threadId: 'thr-a' };
      expect(adapter.cancel).toHaveBeenCalledWith({ threadId: 'thr-a' });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['threads.list'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['threads.get', input], exact: true });
      expect(onCancelled).toHaveBeenCalledOnce();
      renderer.unmount();
    },
  );
});
