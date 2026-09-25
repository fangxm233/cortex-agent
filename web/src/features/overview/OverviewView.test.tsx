// input:  OverviewView, react-test-renderer, query mocks
// output: Overview material, action and layout regressions
// pos:    Scoped overview presentation tests
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const adapter = vi.hoisted(() => ({
  openEdit: vi.fn(),
  remove: vi.fn<(args: { scheduleId: string }) => Promise<unknown>>(),
  resume: vi.fn<(args: { scheduleId: string }) => Promise<unknown>>(),
}));

const schedule: ScheduleInfo = {
  id: 'schedule-1',
  type: 'daily',
  message: 'Review project status',
  projectId: 'nimbus',
  profile: 'default',
  nextRun: '2030-01-02T09:00:00.000Z',
  lastRun: null,
  paused: true,
  pausedBy: 'user',
  intervalMs: null,
  time: '09:00',
  dayOfWeek: null,
  target: { kind: 'project', projectId: 'nimbus' },
  fallback: 'fresh',
};

function staticQuery(key: string, value: unknown) {
  return {
    queryOptions: () => ({ queryKey: [key, {}], queryFn: async () => value, initialData: value }),
    queryFilter: () => ({ queryKey: [key] }),
  };
}

vi.mock('react-router-dom', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cost: { summary: staticQuery('cost.summary', {}) },
    schedules: {
      list: staticQuery('schedules.list', [schedule]),
      resume: { mutationOptions: (options: object) => ({
        ...options,
        mutationFn: (args: { scheduleId: string }) => adapter.resume(args),
      }) },
      remove: { mutationOptions: (options: object) => ({
        ...options,
        mutationFn: (args: { scheduleId: string }) => adapter.remove(args),
      }) },
    },
    executions: { list: staticQuery('executions.list', []) },
    issues: { list: staticQuery('issues.list', []) },
  }),
}));

vi.mock('@/features/execution/useExecutionDrawer', () => ({
  useExecutionDrawer: () => ({ open: vi.fn() }),
}));

vi.mock('@/features/schedule/useScheduleModal', () => ({
  useScheduleModal: () => ({ open: vi.fn(), openEdit: adapter.openEdit, close: vi.fn() }),
}));

vi.mock('@/features/issues/useIssues', () => ({
  useIssues: () => ({ open: vi.fn() }),
}));

vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ currentProjectId: 'nimbus' }),
}));

vi.mock('@/features/notes/NotesProvider', () => ({
  useNotes: () => ({
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
    add: vi.fn(),
    copy: {},
    vm: { activeCount: 0 },
  }),
}));

vi.mock('@/features/notes/NotesButton', () => ({ NotesButton: () => null }));
vi.mock('@/features/notes/NotesOverviewCard', () => ({ NotesOverviewCard: () => null }));

import { OverviewView } from './OverviewView';

async function mount(): Promise<ReactTestRenderer> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <LangProvider>
          <OverviewView />
        </LangProvider>
      </QueryClientProvider>,
    );
  });
  return renderer;
}

beforeEach(() => {
  adapter.openEdit.mockReset();
  adapter.remove.mockReset();
  adapter.remove.mockResolvedValue({});
  adapter.resume.mockReset();
  adapter.resume.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Overview schedule actions', () => {
  it('keeps every execution column inside a keyboard-scrollable region', async () => {
    const renderer = await mount();
    const region = renderer.root.findByProps({ className: 'overview-table-scroll' });
    expect(region.props.tabIndex).toBe(0);
    expect(region.props.role).toBe('region');
    expect(region.findByProps({ className: 'overview-table-row' }).children).toHaveLength(7);
    const cards = renderer.root.findAll(node => node.props.style?.background === 'var(--material-card-bg)');
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.props.style.boxShadow).toBe('var(--material-card-shadow)');
      expect(card.props.style.backdropFilter).toBeUndefined();
    }
    expect(renderer.root.findByProps({ className: 'overview-grid' }).props.style.gridTemplateColumns).toBeUndefined();
    act(() => renderer.unmount());
  });

  it('deletes the selected schedule only after confirmation', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const renderer = await mount();
    const deleteButton = renderer.root.findByProps({ 'data-schedule-delete': schedule.id });

    act(() => deleteButton.props.onClick());
    expect(adapter.remove).not.toHaveBeenCalled();

    await act(async () => deleteButton.props.onClick());
    expect(adapter.remove).toHaveBeenCalledWith({ scheduleId: schedule.id });
  });

  it('keeps resume available for a paused schedule', async () => {
    const renderer = await mount();

    await act(async () => {
      renderer.root.findByProps({ 'data-schedule-resume': schedule.id }).props.onClick();
    });

    expect(adapter.resume).toHaveBeenCalledWith({ scheduleId: schedule.id });
  });
});
