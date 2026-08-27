// input:  mounted project-creation controller and mutation outcomes
// output: validation, list invalidation, returned-id, and real-error regressions
// pos:    Shared create-project controller integration specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreateProject, type CreateProjectController } from './useCreateProject';

const adapter = vi.hoisted(() => ({
  create: vi.fn<(args: { name: string }) => Promise<{ id: string }>>(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    projects: {
      create: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: (args: { name: string }) => adapter.create(args),
        }),
      },
      list: {
        queryFilter: () => ({ queryKey: ['projects.list'] }),
      },
    },
  }),
}));

let controller: CreateProjectController | null = null;

function Probe({ onCreated }: { onCreated: (id: string) => void }) {
  controller = useCreateProject({ onCreated });
  return null;
}

async function mount(onCreated: (id: string) => void) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  await act(async () => {
    create(
      <QueryClientProvider client={queryClient}>
        <Probe onCreated={onCreated} />
      </QueryClientProvider>,
    );
  });
  return { invalidate };
}

beforeEach(() => {
  controller = null;
  adapter.create.mockReset();
});

describe('useCreateProject', () => {
  it('trims valid input, invalidates the project list, and passes through the returned id', async () => {
    adapter.create.mockResolvedValue({ id: 'nimbus' });
    const onCreated = vi.fn();
    const { invalidate } = await mount(onCreated);

    await act(async () => {
      await controller?.createProject('  nimbus  ');
    });

    expect(adapter.create).toHaveBeenCalledWith({ name: 'nimbus' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects.list'] });
    expect(onCreated).toHaveBeenCalledWith('nimbus');
  });

  it('does not mutate for invalid input', async () => {
    await mount(vi.fn());

    act(() => {
      void controller?.createProject('   ');
    });

    expect(adapter.create).not.toHaveBeenCalled();
  });

  it('exposes the real create error from the backend', async () => {
    adapter.create.mockRejectedValue(new Error('Project already exists: nimbus'));
    await mount(vi.fn());

    await act(async () => {
      await controller?.createProject('nimbus');
    });

    expect(controller?.error).toBe('Project already exists: nimbus');
  });
});
