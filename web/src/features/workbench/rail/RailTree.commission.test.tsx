import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import { RailTree, type RailTreeProps } from './RailTree';
import type { RailCommissionRow, RailProjectNode } from './rail-tree';

// The commission row's ＋ is the one-click "another session on this contract". Without it the only
// way in is a new draft plus a trip through the composer's ＋ menu to re-pick a commission the user
// is already standing on.

const commission = (overrides: Partial<RailCommissionRow> = {}): RailCommissionRow => ({
  commissionId: 'cm-1',
  projectId: 'p1',
  title: 'Refactor the rail',
  status: 'active',
  expanded: false,
  running: false,
  unread: false,
  awaitingInput: false,
  sessions: [],
  totalSessions: 2,
  ...overrides,
});

const node = (commissions: RailCommissionRow[]): RailProjectNode => ({
  id: 'p1',
  current: true,
  expanded: true,
  empty: false,
  running: 0,
  attention: 0,
  attentionTone: 'unread',
  hotkey: null,
  idleAge: null,
  sessions: [],
  hiddenSessions: 0,
  showingAll: false,
  totalSessions: 0,
  schedules: [],
  schedulesExpanded: false,
  scheduleUnread: 0,
  commissions,
  commissionsExpanded: true,
  commissionUnread: 0,
  matchCount: null,
});

function renderTree(overrides: Partial<RailTreeProps> = {}): {
  renderer: ReactTestRenderer;
  onNewCommissionSession: ReturnType<typeof vi.fn>;
} {
  const onNewCommissionSession = vi.fn();
  const props: RailTreeProps = {
    nodes: [node([commission()])],
    projectCount: 1,
    sort: 'activity',
    onSort: vi.fn(),
    filter: '',
    onFilter: vi.fn(),
    searchOpen: false,
    onToggleSearch: vi.fn(),
    onNewProject: vi.fn(),
    onToggleProject: vi.fn(),
    onToggleSchedules: vi.fn(),
    onToggleCommissions: vi.fn(),
    onToggleCommission: vi.fn(),
    onOpenCommission: vi.fn(),
    onNewCommissionSession,
    onShowAll: vi.fn(),
    onShowFewer: vi.fn(),
    onOpenSession: vi.fn(),
    onNewSessionIn: vi.fn(),
    onOverview: vi.fn(),
    onScheduleRow: vi.fn(),
    onReorder: vi.fn(),
    now: Date.parse('2026-09-15T12:00:00'),
    ...overrides,
  };
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><RailTree {...props} /></LangProvider>); });
  return { renderer, onNewCommissionSession };
}

const row = (renderer: ReactTestRenderer) => renderer.root.findByProps({ 'data-commission-row': 'cm-1' });
const plus = (renderer: ReactTestRenderer) =>
  renderer.root.findAllByProps({ 'aria-label': 'New session on this commission' })
    .filter((n) => typeof n.type === 'string');

describe('commission rail row', () => {
  it('offers a new session on hover without opening the board', () => {
    const { renderer, onNewCommissionSession } = renderTree();
    expect(plus(renderer)).toHaveLength(0);

    act(() => row(renderer).props.onMouseEnter());
    const stop = vi.fn();
    act(() => plus(renderer)[0].props.onClick({ stopPropagation: stop }));

    // The click must not fall through to the row body, which opens the board instead.
    expect(stop).toHaveBeenCalledOnce();
    expect(onNewCommissionSession).toHaveBeenCalledOnce();
    expect(onNewCommissionSession.mock.calls[0][0].commissionId).toBe('cm-1');
    act(() => renderer.unmount());
  });

  it('keeps the count on a closed commission — it takes no new sessions', () => {
    // The server refuses a join on a closed commission, so the row must not offer one.
    const { renderer } = renderTree({ nodes: [node([commission({ status: 'done' })])] });
    act(() => row(renderer).props.onMouseEnter());
    expect(plus(renderer)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('offers nothing while the commission feature is off', () => {
    const { renderer } = renderTree({ onNewCommissionSession: undefined });
    act(() => row(renderer).props.onMouseEnter());
    expect(plus(renderer)).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
