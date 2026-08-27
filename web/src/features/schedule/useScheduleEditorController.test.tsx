// input:  mounted schedule editor controller, config query, and mutation outcomes
// output: shared create/edit initialization, field locks, payloads, and invalidation regressions
// pos:    Headless schedule editor controller integration specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useScheduleEditorController,
  type ScheduleEditorController,
} from './useScheduleEditorController';

const adapter = vi.hoisted(() => ({
  add: vi.fn<(args: unknown) => Promise<unknown>>(),
  update: vi.fn<(args: unknown) => Promise<unknown>>(),
  config: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    config: {
      get: {
        queryOptions: () => ({ queryKey: ['config.get'], queryFn: adapter.config }),
      },
    },
    schedules: {
      add: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: (args: unknown) => adapter.add(args),
        }),
      },
      update: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: (args: unknown) => adapter.update(args),
        }),
      },
      list: { queryFilter: () => ({ queryKey: ['schedules.list'] }) },
    },
  }),
}));

function schedule(p: Partial<ScheduleInfo> = {}): ScheduleInfo {
  return {
    id: 'once-1',
    type: 'once',
    message: 'ship report',
    projectId: 'nimbus',
    profile: 'review',
    nextRun: '2030-01-01T08:00:00.000Z',
    lastRun: null,
    paused: false,
    pausedBy: null,
    intervalMs: null,
    time: null,
    dayOfWeek: null,
    target: { kind: 'project', projectId: 'nimbus' },
    fallback: 'wait',
    ...p,
  };
}

let controller: ScheduleEditorController | null = null;

function Probe() {
  controller = useScheduleEditorController();
  return null;
}

async function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData(['config.get'], {
    profiles: { defaultProfile: 'default', profiles: [{ name: 'default' }, { name: 'review' }] },
  });
  queryClient.setQueryData(['schedules.list'], []);
  await act(async () => {
    create(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { queryClient };
}

beforeEach(() => {
  controller = null;
  adapter.add.mockReset();
  adapter.update.mockReset();
  adapter.config.mockReset();
  adapter.config.mockResolvedValue({
    profiles: { defaultProfile: 'default', profiles: [{ name: 'default' }, { name: 'review' }] },
  });
});

describe('useScheduleEditorController', () => {
  it('owns profile options, create initialization, add payload, and list invalidation', async () => {
    adapter.add.mockResolvedValue(schedule({ id: 'daily-1', type: 'daily' }));
    const { queryClient } = await mount();

    expect(controller?.profileOptions).toEqual(['default', 'review']);
    act(() => controller?.openCreate({ projectId: 'nimbus' }));
    act(() => controller?.onChange({ message: '  scan arXiv  ', profile: 'review' }));

    expect(controller?.mode).toBe('create');
    expect(controller?.form?.projectId).toBe('nimbus');
    expect(controller?.editableFields.type).toBe(true);

    let saved = false;
    await act(async () => { saved = (await controller?.submit()) ?? false; });

    expect(saved).toBe(true);
    expect(adapter.add).toHaveBeenCalledWith(expect.objectContaining({
      type: 'daily', message: 'scan arXiv', projectId: 'nimbus', profile: 'review', time: '09:00',
    }));
    expect(queryClient.getQueryState(['schedules.list'])?.isInvalidated).toBe(true);
    expect(controller?.form).toBeNull();
  });

  it('prefills a real once DTO, rejects locked changes, and updates without timing', async () => {
    adapter.update.mockResolvedValue(schedule({ message: 'updated' }));
    const { queryClient } = await mount();
    const realSchedule = schedule();

    act(() => controller?.openEdit(realSchedule));
    expect(controller?.mode).toBe('edit');
    expect(controller?.form).toMatchObject({
      type: 'once', message: 'ship report', profile: 'review', target: 'project', fallback: 'wait',
    });
    expect(controller?.editableFields).toMatchObject({
      type: false, delay: false, target: false, fallback: false, message: true, profile: true,
    });

    act(() => controller?.onChange({
      type: 'weekly',
      delayValue: 999,
      target: 'fresh',
      fallback: 'skip',
      message: '  updated  ',
    }));
    expect(controller?.form).toMatchObject({
      type: 'once', delayValue: 10, target: 'project', fallback: 'wait', message: '  updated  ',
    });

    await act(async () => { expect(await controller?.submit()).toBe(true); });
    expect(adapter.update).toHaveBeenCalledWith({
      scheduleId: 'once-1', message: 'updated', profile: 'review', projectId: 'nimbus',
    });
    expect(queryClient.getQueryState(['schedules.list'])?.isInvalidated).toBe(true);
  });
});
