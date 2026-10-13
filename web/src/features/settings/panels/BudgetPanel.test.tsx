import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider, useSetLang } from '@/i18n';

const harness = vi.hoisted(() => ({
  pending: false,
  unpricedCounts: { global: 4, alpha: 2 } as Record<string, number | undefined>,
  write: vi.fn(),
  clear: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/features/settings/controllers/useBudgetWriter', () => ({
  useBudgetWriter: () => ({
    write: harness.write,
    clear: harness.clear,
    isPending: harness.pending,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    projects: { list: { queryOptions: () => ({ kind: 'projects' }) } },
    cost: { summary: { queryOptions: (input: { projectId?: string }) => ({ kind: 'cost', ...input }) } },
  }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: { kind: string; projectId?: string }) => options.kind === 'projects'
    ? { data: [{ id: 'alpha' }] }
    : { data: { today: 1, month: 2, unpricedCount: harness.unpricedCounts[options.projectId ?? 'global'] } },
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
  hooks: [],
  env: [],
  settings: [],
} as unknown as ConfigSnapshot;

function LanguageSwitch() {
  const setLang = useSetLang();
  return <button data-lang="zh" onClick={() => setLang('zh')}>中文</button>;
}

function mount(scope: string = 'alpha'): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<LangProvider><LanguageSwitch /><BudgetPanel snapshot={snapshot} /></LangProvider>);
  });
  act(() => renderer.root.findByProps({ 'data-budget-scope': scope }).props.onClick());
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.pending = false;
  harness.unpricedCounts = { global: 4, alpha: 2 };
  harness.write.mockResolvedValue('write');
  harness.clear.mockResolvedValue('clear');
});

describe('BudgetPanel unpriced cost note', () => {
  it('uses the selected scope count without changing spend or limits', () => {
    const renderer = mount('global');
    const note = () => renderer.root.findByProps({ 'data-budget-unpriced': true }).children;
    expect(note()).toEqual(['4 runs without cost data']);
    act(() => renderer.root.findByProps({ 'data-budget-scope': 'alpha' }).props.onClick());
    expect(note()).toEqual(['2 runs without cost data']);
    expect(renderer.root.findByProps({ 'data-budget-limit': 'daily' }).children).toEqual(['$5']);
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.clear).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it.each([0, undefined])('hides the note when the count is %s', (count) => {
    harness.unpricedCounts.alpha = count;
    const renderer = mount();
    expect(renderer.root.findAllByProps({ 'data-budget-unpriced': true })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('renders the Chinese shared vocabulary', () => {
    const renderer = mount();
    act(() => renderer.root.findByProps({ 'data-lang': 'zh' }).props.onClick());
    expect(renderer.root.findByProps({ 'data-budget-unpriced': true }).children)
      .toEqual(['2 次运行无费用数据']);
    act(() => renderer.unmount());
  });
});

describe('BudgetPanel interaction gates', () => {
  it('makes chip, Enter, apply and clear unavailable while pending', () => {
    harness.pending = true;
    const renderer = mount();
    const chip = renderer.root.findByProps({ 'data-budget-chip': 'daily-5' });
    const input = renderer.root.findByProps({ 'data-budget-input': 'daily' });
    const apply = renderer.root.findAllByType('button').find((node) => node.children.includes('Apply'))!;
    const clear = renderer.root.findByProps({ 'data-budget-clear': true });

    expect(chip.props.onClick).toBeUndefined();
    act(() => input.props.onKeyDown({ key: 'Enter' }));
    act(() => { apply.props.onClick(); clear.props.onClick(); });
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.clear).not.toHaveBeenCalled();
  });
});
