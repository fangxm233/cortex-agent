// input:  mounted budget writer, config.set outcomes, and query cache
// output: serialized nullable operations, payload, invalidation, and failure regressions
// pos:    Shared desktop/mobile budget writer integration specification
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useBudgetWriter,
  type BudgetWriter,
  type BudgetWriterOperation,
} from './useBudgetWriter';

const adapter = vi.hoisted(() => ({
  set: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    config: {
      set: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: (args: unknown) => adapter.set(args),
        }),
      },
      get: {
        queryFilter: (input: object) => ({ queryKey: ['config.get', input] }),
      },
    },
    cost: {
      summary: {
        queryFilter: () => ({ queryKey: ['cost.summary'] }),
      },
    },
  }),
}));

let writer: BudgetWriter | null = null;

function Probe() {
  writer = useBudgetWriter();
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mount() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  await act(async () => {
    create(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return { invalidate, queryClient };
}

beforeEach(() => {
  writer = null;
  adapter.set.mockReset();
});

describe('useBudgetWriter', () => {
  it('writes a scoped budget, refreshes config and every cost summary, and returns write', async () => {
    adapter.set.mockResolvedValue({ written: true, section: 'budget' });
    const { invalidate, queryClient } = await mount();
    let operation: BudgetWriterOperation | null | undefined;

    await act(async () => {
      operation = await writer?.write('alpha', { daily_usd: 5, monthly_usd: 100 });
    });

    expect(adapter.set).toHaveBeenCalledWith({
      section: 'budget', project: 'alpha', value: { daily_usd: 5, monthly_usd: 100 },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['config.get', {}] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['cost.summary'] });
    expect(operation).toBe('write');
    queryClient.clear();
  });

  it('clears a project override through the same mutation and refresh path, preserving clear', async () => {
    adapter.set.mockResolvedValue({ written: true, section: 'budget' });
    const { invalidate, queryClient } = await mount();
    let operation: BudgetWriterOperation | null | undefined;

    await act(async () => {
      operation = await writer?.clear('alpha');
    });

    expect(adapter.set).toHaveBeenCalledWith({ section: 'budget', project: 'alpha' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['config.get', {}] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['cost.summary'] });
    expect(operation).toBe('clear');
    queryClient.clear();
  });

  it('synchronously ignores a duplicate write or clear while one mutation is pending', async () => {
    const gate = deferred<{ written: true; section: 'budget' }>();
    adapter.set.mockReturnValue(gate.promise);
    const { queryClient } = await mount();
    let first: Promise<BudgetWriterOperation | null> | undefined;
    let duplicate: BudgetWriterOperation | null | undefined;

    act(() => {
      first = writer?.write('alpha', { daily_usd: 5, monthly_usd: 100 });
      void writer?.clear('alpha').then((result) => { duplicate = result; });
    });
    await act(async () => { await Promise.resolve(); });
    expect(adapter.set).toHaveBeenCalledOnce();
    expect(duplicate).toBeNull();

    await act(async () => {
      gate.resolve({ written: true, section: 'budget' });
      expect(await first).toBe('write');
    });
    queryClient.clear();
  });

  it('keeps the backend failure and does not invalidate stale reads', async () => {
    adapter.set.mockRejectedValue(new Error('denied'));
    const { invalidate, queryClient } = await mount();
    let failure: unknown;

    await act(async () => {
      try {
        await writer?.write(null, { daily_usd: 10, monthly_usd: 200 });
      } catch (caught) {
        failure = caught;
      }
    });

    expect(failure).toEqual(new Error('denied'));
    expect(invalidate).not.toHaveBeenCalled();
    queryClient.clear();
  });
});
