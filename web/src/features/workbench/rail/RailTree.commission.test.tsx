import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import { RailTree, type RailTreeProps } from './RailTree';
import { RailSessionMenu } from './RailSessionMenu';
import type { RailCommissionRow, RailProjectNode, RailSessionRow } from './rail-tree';

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
  starredSessions: [],
  starsExpanded: true,
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
    onToggleStars: vi.fn(),
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

describe('flat project rail row', () => {
  it.each([false, true])('keeps current=%s rows flat and stable on hover', (current) => {
    const onToggleProject = vi.fn();
    const { renderer } = renderTree({ nodes: [{ ...node([]), current }], onToggleProject });
    const project = renderer.root.findByProps({ 'data-project-row': 'p1' });
    const background = current ? 'var(--proto-accent-bg)' : 'transparent';
    expect(project.props.style).toMatchObject({ position: 'relative', height: 32, gap: 7, background });
    expect(project.props.style.boxShadow).toBeUndefined();
    expect(project.findByProps({ title: 'p1' }).props.style.fontWeight).toBe(current ? 600 : 500);
    // Folder glyph, title, trailing slot only: no extra chevron column takes title width.
    expect(project.children).toHaveLength(3);
    act(() => project.props.onMouseEnter());
    expect(project.props.style).toMatchObject({
      height: 32, background: current ? 'var(--proto-accent-bg)' : 'var(--proto-gray)',
    });
    act(() => project.props.onMouseLeave());
    expect(project.props.style.background).toBe(background);
    act(() => project.props.onClick());
    expect(onToggleProject).toHaveBeenCalledWith('p1');
    act(() => renderer.unmount());
  });

  it('keeps project hover actions separate from expansion', () => {
    const onToggleProject = vi.fn();
    const onOverview = vi.fn();
    const onNewSessionIn = vi.fn();
    const { renderer } = renderTree({ onToggleProject, onOverview, onNewSessionIn });
    act(() => renderer.root.findByProps({ 'data-project-row': 'p1' }).props.onMouseEnter());
    for (const label of ['p1 overview', 'New session in p1']) {
      const button = renderer.root.findByProps({ 'aria-label': label });
      const stopPropagation = vi.fn();
      act(() => button.props.onClick({ stopPropagation }));
      expect(stopPropagation).toHaveBeenCalledOnce();
    }
    expect(onOverview).toHaveBeenCalledWith('p1');
    expect(onNewSessionIn).toHaveBeenCalledWith('p1');
    expect(onToggleProject).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('project Stars disclosure', () => {
  const star: RailSessionRow = { sessionId: 'star-1', projectId: 'p1', title: 'Renamed session',
    age: '1h', stamp: '', running: false, awaitingInput: false, waitingOn: false,
    unread: false, selected: true };

  it('renders a selected star once and toggles only its own group', () => {
    const onToggleStars = vi.fn();
    const onOpenSession = vi.fn();
    const nodes = [{ ...node([]), starredSessions: [star] },
      { ...node([]), id: 'p2', starredSessions: [{ ...star, sessionId: 'star-2', projectId: 'p2' }] }];
    const { renderer } = renderTree({ nodes, onToggleStars, onOpenSession });
    const header = () => renderer.root.findByProps({ 'data-starred-project': 'p1' }).findByProps({ 'aria-label': 'Stars' });
    expect(renderer.root.findAllByProps({ 'data-session-id': 'star-1' })).toHaveLength(1);
    const selected = renderer.root.findByProps({ 'data-session-id': 'star-1' });
    expect(selected.props.style.background).toBe('var(--proto-accent-bg)');
    expect(selected.props.title).toBe('Renamed session');
    act(() => selected.props.onClick());
    expect(onOpenSession).toHaveBeenCalledWith(star);
    act(() => header().props.onClick());
    expect(onToggleStars).toHaveBeenCalledWith('p1');
    const props = renderer.root.findByType(RailTree).props as RailTreeProps;
    const update = (expanded: boolean) => renderer.update(<LangProvider><RailTree {...props}
      nodes={[{ ...nodes[0], starsExpanded: expanded }, nodes[1]]} /></LangProvider>);
    act(() => update(false));
    expect(header().props['aria-expanded']).toBe(false);
    expect(renderer.root.findAllByProps({ 'data-session-id': 'star-1' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-session-id': 'star-2' })).toHaveLength(1);
    act(() => update(true));
    expect(renderer.root.findAllByProps({ 'data-session-id': 'star-1' })).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('wires the same hover menu to loose, starred and commission session rows', () => {
    const loose = { ...star, sessionId: 'loose', selected: false };
    const member = { ...loose, sessionId: 'member' };
    const nodes = [{ ...node([commission({ expanded: true, sessions: [member] })]),
      starredSessions: [{ ...star, starred: true }], sessions: [loose] }];
    const onOpenSession = vi.fn();
    const { renderer } = renderTree({ nodes, onOpenSession });
    for (const sessionId of ['loose', 'star-1', 'member']) {
      const session = renderer.root.findByProps({ 'data-session-id': sessionId });
      const menu = session.findByType(RailSessionMenu);
      expect(menu.props.hovered).toBe(false);
      act(() => session.props.onMouseEnter());
      expect(menu.props.hovered).toBe(true);
      expect(menu.props.row.sessionId).toBe(sessionId);
      act(() => session.props.onMouseLeave());
      expect(menu.props.hovered).toBe(false);
    }
    expect(onOpenSession).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('does not render an empty Stars header for legacy projects', () => {
    const { renderer } = renderTree();
    expect(renderer.root.findAllByProps({ 'aria-label': 'Stars' })).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

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
