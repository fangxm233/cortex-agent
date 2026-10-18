import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardDecisionEntry, ExecutionInfo, ScheduleInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { LangProvider, en } from '@/i18n';
import { currentDialog, dismissDialog, settleDialog } from '@/design/dialog-store';

const adapter = vi.hoisted(() => ({
  openEdit: vi.fn(),
  remove: vi.fn<(args: { scheduleId: string }) => Promise<unknown>>(),
  resume: vi.fn<(args: { scheduleId: string }) => Promise<unknown>>(),
  navigate: vi.fn(),
  setCurrentProject: vi.fn(),
  setSelectedSession: vi.fn(),
  openSection: vi.fn(),
  openBoard: vi.fn(),
  openDrawer: vi.fn(),
}));

const schedule = {
  id: 'schedule-1',
  type: 'daily',
  message: 'Review project status',
  projectId: 'nimbus',
  selection: { backend: 'claude', provider: null, model: 'claude-opus', thinking: 'high', mode: 'plan' },
  nextRun: '2030-01-02T09:00:00.000Z',
  lastRun: null,
  paused: true,
  pausedBy: 'user',
  intervalMs: null,
  time: '09:00',
  dayOfWeek: null,
  target: { kind: 'project', projectId: 'nimbus' },
} as ScheduleInfo;

const session = (p: Partial<SessionInfo>): SessionInfo => ({
  sessionId: 'sess',
  projectId: 'nimbus',
  label: null,
  origin: 'direct',
  teamLeadId: null,
  running: false,
  backgroundRunning: false,
  awaitingInput: false,
  waitingOn: 0,
  createdAt: '2026-07-06T00:00:00.000Z',
  lastUsedAt: '2026-07-06T00:00:00.000Z',
  ...p,
} as SessionInfo);

const asking = session({ sessionId: 'ask-1', label: 'Cosine schedule', awaitingInput: true, running: true });
const sweeping = session({ sessionId: 'run-1', label: 'adam-sweep', running: true });
const elsewhere = session({ sessionId: 'other-1', projectId: 'other', label: 'Other project', running: true });
const sessions: Record<string, SessionInfo[]> = {
  direct: [asking, sweeping, elsewhere],
  scheduled: [],
};

const executions: ExecutionInfo[] = [{
  id: 'exec_local_abc123',
  status: 'completed',
  sessionId: 'run-1',
  projectId: 'nimbus',
  startedAt: '2026-07-06T00:00:00.000Z',
  finishedAt: '2026-07-06T00:00:10.000Z',
  durationMs: 10_000,
  cost: 0.03,
}];

const decisions: BoardDecisionEntry[] = [1, 2].map((n) => ({
  ts: `2026-07-06T0${n}:00:00.000Z`,
  sessionId: 'ask-1',
  item: { id: `d${n}`, title: 'Pick warmup', decision: 'd', context: '', reasoning: '', actions: [] },
}));

function staticQuery(key: string, value: unknown | ((input: Record<string, unknown>) => unknown)) {
  const read = (input: Record<string, unknown>) => (typeof value === 'function' ? (value as (i: Record<string, unknown>) => unknown)(input) : value);
  return {
    queryOptions: (input: Record<string, unknown> = {}) => ({
      queryKey: [key, input], queryFn: async () => read(input), initialData: read(input),
    }),
    queryFilter: () => ({ queryKey: [key] }),
  };
}

vi.mock('react-router-dom', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => adapter.navigate,
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
    executions: { list: staticQuery('executions.list', executions) },
    issues: { list: staticQuery('issues.list', []) },
    sessions: {
      list: staticQuery('sessions.list', (input: Record<string, unknown>) => sessions[input.origin as string] ?? []),
      pendingInteraction: staticQuery('sessions.pendingInteraction', {
        askUser: { questions: [{ question: 'Warmup 500 or 1000 steps?' }] },
      }),
    },
    boards: {
      list: staticQuery('boards.list', [{ id: 'board-1', title: 'Digits study', projectId: 'nimbus', slug: 'digits' }]),
      decisions: staticQuery('boards.decisions', decisions),
    },
    memory: { tree: staticQuery('memory.tree', { projectId: 'nimbus', files: [], dirs: [] }) },
    config: { get: staticQuery('config.get', { settings: [{ key: 'teamEnabled', value: true }] }) },
  }),
}));

vi.mock('@/features/execution/useExecutionDrawer', () => ({
  useExecutionDrawer: () => ({ open: adapter.openDrawer }),
}));

vi.mock('@/features/schedule/useScheduleModal', () => ({
  useScheduleModal: () => ({ open: vi.fn(), openEdit: adapter.openEdit }),
}));

vi.mock('@/features/issues/useIssues', () => ({
  useIssues: () => ({ open: vi.fn() }),
}));

vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ currentProjectId: 'nimbus', setCurrentProject: adapter.setCurrentProject }),
}));

vi.mock('@/features/session/state/SelectedSessionProvider', () => ({
  useSelectedSession: () => ({ setSelectedSession: adapter.setSelectedSession }),
}));

vi.mock('@/features/settings/useSettings', () => ({
  useSettings: () => ({ open: vi.fn(), openSection: adapter.openSection, close: vi.fn() }),
}));

vi.mock('@/design/dock-intake', () => ({
  useDockIntake: () => ({ openBoard: adapter.openBoard }),
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

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

function buttonNamed(renderer: ReactTestRenderer, name: string): ReactTestInstance {
  return renderer.root.find((node) => node.type === 'button' && (node.props['aria-label'] === name || text(node) === name));
}

beforeEach(() => {
  for (const fn of Object.values(adapter)) fn.mockReset();
  adapter.remove.mockResolvedValue({});
  adapter.resume.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Overview schedule actions', () => {
  it('shows the schedule model name', async () => {
    const renderer = await mount();
    expect(renderer.root.findAllByType('span').some((span) => span.children.includes('claude-opus'))).toBe(true);
    act(() => renderer.unmount());
  });

  it('deletes the selected schedule only after confirmation', async () => {
    const renderer = await mount();
    const deleteButton = renderer.root.findByProps({ 'data-schedule-delete': schedule.id });

    act(() => { deleteButton.props.onClick(); });
    expect(currentDialog()).toMatchObject({ description: schedule.message, tone: 'danger' });
    await act(async () => { dismissDialog(); });
    expect(adapter.remove).not.toHaveBeenCalled();

    act(() => { deleteButton.props.onClick(); });
    await act(async () => settleDialog(currentDialog()!.id, ''));
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

describe('Overview work column', () => {
  it('lists what is blocked on the user, with the question, and replies where the rail would', async () => {
    const renderer = await mount();
    const row = renderer.root.findByProps({ 'data-needs-you-session': 'ask-1' });
    expect(text(row)).toContain('Cosine schedule');
    expect(text(row)).toContain('Warmup 500 or 1000 steps?');

    act(() => { buttonNamed(renderer, `${en.ovReply} · Cosine schedule`).props.onClick(); });
    expect(adapter.setCurrentProject).toHaveBeenCalledWith('nimbus');
    expect(adapter.setSelectedSession).toHaveBeenCalledWith('ask-1');
    expect(adapter.navigate).toHaveBeenCalledWith('/workbench');
    act(() => renderer.unmount());
  });

  it('counts unanswered board decisions and opens the board in the workbench', async () => {
    const renderer = await mount();
    const row = renderer.root.findByProps({ 'data-needs-you-board': 'board-1' });
    expect(text(row)).toContain('2 decisions awaiting you');

    act(() => { buttonNamed(renderer, `${en.ovView} · Digits study`).props.onClick(); });
    expect(adapter.navigate).toHaveBeenCalledWith('/workbench');
    expect(adapter.openBoard).toHaveBeenCalledWith('board-1');
    act(() => renderer.unmount());
  });

  it('lists only this project\'s running sessions under In progress', async () => {
    const renderer = await mount();
    const rows = renderer.root.findAll((node) => node.props['data-in-progress-session'] !== undefined && typeof node.type === 'string');
    expect(rows.map((node) => node.props['data-in-progress-session'])).toEqual(['run-1']);

    act(() => { rows[0].props.onClick(); });
    expect(adapter.setSelectedSession).toHaveBeenCalledWith('run-1');
    act(() => renderer.unmount());
  });

  it('names a recent run by its session title and keeps the execution id in the tooltip', async () => {
    const renderer = await mount();
    const row = renderer.root.findByProps({ 'data-execution-row': 'exec_local_abc123' });
    expect(text(row)).toContain('adam-sweep');
    expect(text(row)).not.toContain('exec_local_abc123');
    expect(row.findAll((node) => node.props.title === 'adam-sweep · exec_local_abc123')).not.toHaveLength(0);

    act(() => { buttonNamed(renderer, `${en.ovLogs} · adam-sweep`).props.onClick({ stopPropagation: () => {} }); });
    expect(adapter.openDrawer).toHaveBeenCalledWith('exec_local_abc123');
    act(() => renderer.unmount());
  });
});

describe('Overview header and layout', () => {
  it('opens Settings at Budget and starts a draft in this project', async () => {
    const renderer = await mount();
    act(() => { renderer.root.findByProps({ 'data-adjust-budget': '' }).props.onClick(); });
    expect(adapter.openSection).toHaveBeenCalledWith('budget');

    act(() => { renderer.root.findByProps({ 'data-new-session-here': '' }).props.onClick(); });
    expect(adapter.setSelectedSession).toHaveBeenCalledWith('__draft__');
    expect(adapter.navigate).toHaveBeenCalledWith('/workbench');
    act(() => renderer.unmount());
  });

  it('keeps Needs you as the only card and sets no monospace or capitalised labels', async () => {
    const renderer = await mount();
    const cards = renderer.root.findAll((node) => typeof node.type === 'string' && node.props.className === 'ov-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].parent?.props['data-overview-needs-you']).toBe('');
    expect(renderer.root.findAll((node) => node.props.style?.background === 'var(--material-card-bg)')).toHaveLength(0);
    const styled = renderer.root.findAll((node) => typeof node.type === 'string' && node.props.style);
    for (const node of styled) {
      expect(JSON.stringify(node.props.style)).not.toMatch(/Plex Mono|monospace|uppercase|letterSpacing":"\.0/);
    }
    act(() => renderer.unmount());
  });
});
