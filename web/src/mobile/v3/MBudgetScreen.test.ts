// input:  shared budget draft builder, writer operations, and mobile screen query fixtures
// output: complete-pair initialization and operation-specific toast regressions
// pos:    Mobile Budget editor specification
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBudgetDraft } from '@/features/settings/budget-vm';

const adapter = vi.hoisted(() => ({
  write: vi.fn(),
  clear: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/features/settings/useBudgetWriter', () => ({
  useBudgetWriter: () => ({
    write: adapter.write,
    clear: adapter.clear,
    isPending: false,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    config: { get: { queryOptions: () => ({ budgetQuery: 'config' }) } },
    projects: { list: { queryOptions: () => ({ budgetQuery: 'projects' }) } },
    cost: { summary: { queryOptions: (input: object) => ({ budgetQuery: 'cost', input }) } },
  }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (options: { budgetQuery: string; input?: { projectId?: string } }) => {
      if (options.budgetQuery === 'config') return {
        data: {
          budget: {
            daily_usd: 10,
            monthly_usd: 200,
            projects: { alpha: { daily_usd: 5, monthly_usd: 100 } },
          },
        },
        isLoading: false,
        isError: false,
      };
      if (options.budgetQuery === 'projects') return { data: [{ id: 'alpha' }] };
      return { data: options.input?.projectId ? { today: 2, month: 20 } : { today: 3, month: 30 } };
    },
  };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('@/design', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/design')>();
  return { ...actual, useToast: () => ({ toast: adapter.toast }) };
});

vi.mock('@/i18n', () => ({
  useVocab: () => ({
    stNavBudget: 'Budget',
    stBudgetScope: 'Scope',
    stBudgetInherited: 'Inherited',
    stBudgetScopeGlobal: 'Global',
    stDaily: 'Daily',
    stMonthly: 'Monthly',
    stApply: 'Apply',
    stBudgetClear: 'Clear',
    stCurrentSpend: 'Spend',
    stLoadingConfig: 'Loading',
    stFailedLoadConfig: 'Failed load',
    stToastBudgetWritten: 'written',
    stToastBudgetCleared: 'cleared',
    stToastWriteFailed: 'failed',
  }),
}));

import { MBudgetScreen } from './MBudgetScreen';

describe('mobile buildBudgetDraft use', () => {
  it('initializes an empty budget only when both required limits are supplied', () => {
    expect(buildBudgetDraft('10', '200')).toEqual({ daily_usd: 10, monthly_usd: 200 });
    expect(buildBudgetDraft('10', '')).toBeNull();
    expect(buildBudgetDraft('', '200')).toBeNull();
  });

  it('accepts currency formatting and rejects non-positive values', () => {
    expect(buildBudgetDraft('$12.50', '1,000')).toEqual({ daily_usd: 12.5, monthly_usd: 1000 });
    expect(buildBudgetDraft('0', '100')).toBeNull();
  });
});

async function mountProjectBudget(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(MBudgetScreen));
  });
  const scope = renderer.root.findAllByType('select')[0];
  await act(async () => {
    scope.props.onChange({ target: { value: 'alpha' } });
  });
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  adapter.write.mockResolvedValue('write');
  adapter.clear.mockResolvedValue('clear');
});

describe('MBudgetScreen writer feedback', () => {
  it('shows only the cleared success toast for clear', async () => {
    const renderer = await mountProjectBudget();
    const clear = renderer.root.findAllByType('button').find((button) => button.children.includes('Clear'))!;

    await act(async () => {
      clear.props.onClick();
      await Promise.resolve();
    });

    expect(adapter.clear).toHaveBeenCalledWith('alpha');
    expect(adapter.toast.mock.calls).toEqual([[{ title: 'cleared', tone: 'done' }]]);
  });

  it('shows written for a write and keeps backend failures failed', async () => {
    const renderer = await mountProjectBudget();
    const daily = renderer.root.findAllByType('input')[0];
    await act(async () => {
      daily.props.onChange({ target: { value: '6' } });
    });
    const apply = renderer.root.findAllByType('button').find((button) => button.children.includes('Apply'))!;

    await act(async () => {
      apply.props.onClick();
      await Promise.resolve();
    });

    expect(adapter.write).toHaveBeenCalledWith('alpha', { daily_usd: 6, monthly_usd: 100 });
    expect(adapter.toast).toHaveBeenLastCalledWith({ title: 'written', tone: 'done' });

    adapter.write.mockRejectedValueOnce(new Error('denied'));
    await act(async () => {
      daily.props.onChange({ target: { value: '7' } });
    });
    await act(async () => {
      apply.props.onClick();
      await Promise.resolve();
    });

    expect(adapter.toast).toHaveBeenLastCalledWith({ title: 'failed: denied', tone: 'failed' });
  });
});
