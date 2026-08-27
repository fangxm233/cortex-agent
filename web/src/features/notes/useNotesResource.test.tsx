// input:  mounted project scopes, notes transport outcomes and query cache
// output: shared list, mutation, status, invalidation and latest-scope regressions
// pos:    Integration specification for the project-scoped notes resource
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NoteInfo } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNotesResource, type NotesResource } from './useNotesResource';

const adapter = vi.hoisted(() => ({
  list: vi.fn<(projectId: string) => Promise<NoteInfo[]>>(),
  add: vi.fn<(args: { projectId: string; text: string }) => Promise<NoteInfo>>(),
  update: vi.fn<(args: { projectId: string; id: string; text: string }) => Promise<NoteInfo>>(),
  setCompleted: vi.fn<(args: { projectId: string; id: string; completed: boolean }) => Promise<NoteInfo>>(),
  remove: vi.fn<(args: { projectId: string; id: string }) => Promise<unknown>>(),
  clearCompleted: vi.fn<(args: { projectId: string }) => Promise<unknown>>(),
}));

vi.mock('@/lib/trpc', () => {
  const mutation = (run: (args: never) => Promise<unknown>) => ({
    mutationOptions: (options: object) => ({ ...options, mutationFn: run }),
  });
  return {
    useTRPC: () => ({
      notes: {
        list: {
          queryOptions: ({ projectId }: { projectId: string }) => ({
            queryKey: ['notes.list', { projectId }],
            queryFn: () => adapter.list(projectId),
          }),
          queryFilter: ({ projectId }: { projectId: string }) => ({
            queryKey: ['notes.list', { projectId }],
          }),
        },
        add: mutation(adapter.add as never),
        update: mutation(adapter.update as never),
        setCompleted: mutation(adapter.setCompleted as never),
        delete: mutation(adapter.remove as never),
        clearCompleted: mutation(adapter.clearCompleted as never),
      },
    }),
  };
});

function note(id: string): NoteInfo {
  return {
    id,
    text: `${id} text`,
    completed: false,
    createdAt: '2026-07-29T17:41:00.000Z',
    updatedAt: '2026-07-29T17:41:00.000Z',
    completedAt: null,
  };
}

let resource: NotesResource | null = null;

function Probe({ projectId }: { projectId: string }) {
  resource = useNotesResource(projectId);
  return null;
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(projectId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<QueryClientProvider client={queryClient}><Probe projectId={projectId} /></QueryClientProvider>);
  });
  await flush();
  return { invalidate, queryClient, renderer: renderer! };
}

beforeEach(() => {
  resource = null;
  Object.values(adapter).forEach((mock) => mock.mockReset());
  adapter.list.mockResolvedValue([]);
  adapter.add.mockResolvedValue(note('added'));
  adapter.update.mockResolvedValue(note('updated'));
  adapter.setCompleted.mockResolvedValue(note('completed'));
  adapter.remove.mockResolvedValue({});
  adapter.clearCompleted.mockResolvedValue({});
});

describe('useNotesResource', () => {
  it('loads the scoped list and disables the query for an empty project id', async () => {
    adapter.list.mockResolvedValue([note('n1')]);
    const mounted = await mount('nimbus');
    expect(adapter.list).toHaveBeenCalledWith('nimbus');
    expect(resource?.notes.map((entry) => entry.id)).toEqual(['n1']);
    expect(resource?.loading).toBe(false);
    mounted.renderer.unmount();
    mounted.queryClient.clear();

    const empty = await mount('');
    expect(adapter.list).toHaveBeenCalledTimes(1);
    expect(resource?.notes).toEqual([]);
    expect(resource?.loading).toBe(false);
    empty.renderer.unmount();
    empty.queryClient.clear();
  });

  it('reports list loading and query errors', async () => {
    let fail: ((error: Error) => void) | undefined;
    adapter.list.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const { queryClient, renderer } = await mount('nimbus');
    expect(resource?.loading).toBe(true);

    await act(async () => {
      fail?.(new Error('list unavailable'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    expect(resource?.loading).toBe(false);
    expect(resource?.error?.message).toBe('list unavailable');
    renderer.unmount();
    queryClient.clear();
  });

  it('scopes all five mutations and invalidates the same project list after each settlement', async () => {
    const { invalidate, queryClient, renderer } = await mount('nimbus');
    await act(async () => {
      await resource?.add('new note');
      await resource?.update('n1', 'changed');
      await resource?.setCompleted('n1', true);
      await resource?.delete('n1');
      await resource?.clearCompleted();
    });

    expect(adapter.add.mock.calls[0]?.[0]).toEqual({ projectId: 'nimbus', text: 'new note' });
    expect(adapter.update.mock.calls[0]?.[0]).toEqual({ projectId: 'nimbus', id: 'n1', text: 'changed' });
    expect(adapter.setCompleted.mock.calls[0]?.[0]).toEqual({ projectId: 'nimbus', id: 'n1', completed: true });
    expect(adapter.remove.mock.calls[0]?.[0]).toEqual({ projectId: 'nimbus', id: 'n1' });
    expect(adapter.clearCompleted.mock.calls[0]?.[0]).toEqual({ projectId: 'nimbus' });
    expect(invalidate).toHaveBeenCalledTimes(5);
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['notes.list', { projectId: 'nimbus' }] });
    renderer.unmount();
    queryClient.clear();
  });

  it('uses the latest project scope after a project-id change', async () => {
    const { invalidate, queryClient, renderer } = await mount('nimbus');
    const retainedAdd = resource?.add;
    await act(async () => {
      renderer.update(<QueryClientProvider client={queryClient}><Probe projectId="atlas" /></QueryClientProvider>);
    });
    await flush();
    await act(async () => { await retainedAdd?.('atlas note'); });

    expect(adapter.add.mock.calls.at(-1)?.[0]).toEqual({ projectId: 'atlas', text: 'atlas note' });
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['notes.list', { projectId: 'atlas' }] });
    renderer.unmount();
    queryClient.clear();
  });

  it('exposes aggregate mutation busy state and real query or mutation errors', async () => {
    let finish: ((value: NoteInfo) => void) | undefined;
    adapter.add.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { queryClient, renderer } = await mount('nimbus');
    let pending: Promise<NoteInfo> | undefined;
    await act(async () => {
      pending = resource?.add('wait');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(resource?.busy).toBe(true);
    await act(async () => { finish?.(note('done')); await pending; });
    await flush();
    expect(resource?.busy).toBe(false);

    adapter.update.mockRejectedValue(new Error('update denied'));
    await act(async () => {
      await expect(resource?.update('n1', 'nope')).rejects.toThrow('update denied');
    });
    expect(resource?.error?.message).toBe('update denied');
    renderer.unmount();
    queryClient.clear();
  });
});
