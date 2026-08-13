// input:  OverviewView with schedule and provider mocks
// output: schedule edit and resume interaction regressions
// pos:    Overview schedule action integration tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const adapter = vi.hoisted(() => ({
  openEdit: vi.fn(),
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
    },
    executions: { list: staticQuery('executions.list', []) },
    issues: { list: staticQuery('issues.list', []) },
  }),
}));

vi.mock('@/features/execution/ExecutionLogDrawerProvider', () => ({
  useExecutionLogDrawer: () => ({ open: vi.fn() }),
}));

vi.mock('@/features/schedule/ScheduleModalProvider', () => ({
  useScheduleModal: () => ({ open: vi.fn(), openEdit: adapter.openEdit, close: vi.fn() }),
}));

vi.mock('@/features/issues/IssuesProvider', () => ({
  useIssues: () => ({ open: vi.fn() }),
}));

vi.mock('@/features/workbench/CurrentProjectProvider', () => ({
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
  adapter.resume.mockReset();
  adapter.resume.mockResolvedValue({});
});

describe('Overview schedule actions', () => {
  it('opens the shared edit modal with the selected schedule', async () => {
    const renderer = await mount();

    act(() => renderer.root.findByProps({ 'data-schedule-edit': schedule.id }).props.onClick());

    expect(adapter.openEdit).toHaveBeenCalledWith(schedule);
  });

  it('keeps resume available for a paused schedule', async () => {
    const renderer = await mount();

    await act(async () => {
      renderer.root.findByProps({ 'data-schedule-resume': schedule.id }).props.onClick();
    });

    expect(adapter.resume).toHaveBeenCalledWith({ scheduleId: schedule.id });
  });
});
