// input:  desktop budget panel, pending/nullable writer states and config fixtures
// output: chip, Enter, apply, clear and ignored-operation feedback regressions
// pos:    Desktop Budget interaction-gate specification
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ConfigSnapshot, CostSummary } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  pending: false,
  write: vi.fn(),
  clear: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/features/settings/useBudgetWriter', () => ({
  useBudgetWriter: () => ({
    write: harness.write,
    clear: harness.clear,
    isPending: harness.pending,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    projects: { list: { queryOptions: () => ({ kind: 'projects' }) } },
    cost: { summary: { queryOptions: () => ({ kind: 'cost' }) } },
  }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: { kind: string }) => options.kind === 'projects'
    ? { data: [{ id: 'alpha' }] }
    : { data: { today: 1, month: 2 } },
}));

vi.mock('@/design', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/design')>(),
  useToast: () => ({ toast: harness.toast }),
}));

import { BudgetPanel } from './BudgetPanel';

const snapshot = {
  budget: {
    daily_usd: 10,
    monthly_usd: 200,
    projects: { alpha: { daily_usd: 5, monthly_usd: 100 } },
  },
  profiles: null,
  machines: [],
  mcp: null,
  threadTemplates: { agents: [], templates: [], shells: [] },
  hooks: [],
  env: [],
  settings: [],
} as unknown as ConfigSnapshot;

const cost = { today: 3, month: 30 } as CostSummary;

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<LangProvider><BudgetPanel snapshot={snapshot} cost={cost} /></LangProvider>);
  });
  act(() => renderer.root.findByProps({ 'data-budget-scope': 'alpha' }).props.onClick());
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.pending = false;
  harness.write.mockResolvedValue('write');
  harness.clear.mockResolvedValue('clear');
});

describe('BudgetPanel interaction gates', () => {
  it('makes chip, Enter, apply and clear unavailable while pending', () => {
    harness.pending = true;
    const renderer = mount();
    const chip = renderer.root.findByProps({ 'data-budget-chip': 'daily-5' });
    const input = renderer.root.findByProps({ 'data-budget-input': 'daily' });
    const apply = renderer.root.findAllByType('button').find((node) => node.children.includes('Apply'))!;
    const clear = renderer.root.findByProps({ 'data-budget-clear': true });

    expect(chip.props['aria-disabled']).toBe(true);
    expect(chip.props.onClick).toBeUndefined();
    expect(input.props.disabled).toBe(true);
    expect(apply.props.disabled).toBe(true);
    expect(clear.props.disabled).toBe(true);
    act(() => input.props.onKeyDown({ key: 'Enter' }));
    act(() => { apply.props.onClick(); clear.props.onClick(); });
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.clear).not.toHaveBeenCalled();
  });

  it('does not toast for a write ignored by the synchronous writer gate', async () => {
    harness.write.mockResolvedValueOnce(null);
    const renderer = mount();
    const chip = renderer.root.findByProps({ 'data-budget-chip': 'daily-5' });

    await act(async () => { chip.props.onClick(); await Promise.resolve(); });

    expect(harness.write).toHaveBeenCalledOnce();
    expect(harness.toast).not.toHaveBeenCalled();
  });
});
