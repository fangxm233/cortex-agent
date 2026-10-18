import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import { RailTree, type RailTreeProps } from './RailTree';
import { RailSessionMenu } from './RailSessionMenu';
import type { RailProjectNode, RailSessionRow } from './rail-tree';
import type { ScheduleRow } from '@/features/session/list/schedule-rail';

const node = (): RailProjectNode => ({
  id: 'p1',
  current: true,
  expanded: true,
  empty: false,
  attention: 0,
  attentionTone: 'unread',
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
  matchCount: null,
});

function renderTree(overrides: Partial<RailTreeProps> = {}): { renderer: ReactTestRenderer } {
  const props: RailTreeProps = {
    nodes: [node()],
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
  return { renderer };
}

const session = (over: Partial<RailSessionRow> = {}): RailSessionRow => ({
  sessionId: 's1', projectId: 'p1', title: 'Session', age: '5m', stamp: '', running: false,
  awaitingInput: false, waitingOn: false, unread: false, selected: false, ...over,
});

describe('flat project rail row', () => {
  it.each([
    ['action', 'var(--proto-amber-text)'],
    ['unread', 'var(--proto-muted)'],
  ] as const)('shows %s attention as a plain coloured count, not a filled badge', (attentionTone, color) => {
    const { renderer } = renderTree({ nodes: [{ ...node(), attention: 1, attentionTone }] });
    const badge = renderer.root.findByProps({ 'data-project-attention-badge': 'p1' });
    expect(badge.props.style).toMatchObject({ color, fontVariantNumeric: 'tabular-nums' });
    expect(badge.props.style.background).toBeUndefined();
    expect(badge.props.style.font).toBeUndefined();
    expect(badge.children).toEqual(['1']);
    act(() => renderer.unmount());
  });

  it.each([false, true])('keeps current=%s rows flat and stable on hover', (current) => {
    const onToggleProject = vi.fn();
    const { renderer } = renderTree({ nodes: [{ ...node(), current }], onToggleProject });
    const project = renderer.root.findByProps({ 'data-project-row': 'p1' });
    // With no selected session row in the folder, the current folder holds the selected tint.
    const background = current ? 'var(--proto-gray)' : 'transparent';
    expect(project.props.style).toMatchObject({ position: 'relative', height: 30, gap: 10, background });
    expect(project.props.style.boxShadow).toBeUndefined();
    expect(project.findByProps({ title: 'p1' }).props.style.fontWeight).toBe(550);
    // Drag grip, disclosure chevron column, title, trailing slot.
    expect(project.children).toHaveLength(4);
    const grip = project.findByProps({ 'data-project-grip': 'p1' });
    expect(grip.props.style.opacity).toBe(0);
    act(() => project.props.onMouseEnter());
    expect(project.props.style).toMatchObject({
      height: 30, background: current ? 'var(--proto-gray)' : 'var(--proto-line-2)',
    });
    expect(project.findByProps({ 'data-project-grip': 'p1' }).props.style.opacity).toBe(1);
    act(() => project.props.onMouseLeave());
    expect(project.props.style.background).toBe(background);
    act(() => project.props.onClick());
    expect(onToggleProject).toHaveBeenCalledWith('p1');
    act(() => renderer.unmount());
  });

  it('leaves the current folder plain while its selected session row is on screen', () => {
    const { renderer } = renderTree({ nodes: [{ ...node(), sessions: [session({ selected: true })] }] });
    expect(renderer.root.findByProps({ 'data-project-row': 'p1' }).props.style.background).toBe('transparent');
    act(() => renderer.unmount());
  });

  it('drops the drag grip while a filter is active', () => {
    const { renderer } = renderTree({ filter: 'x' });
    expect(renderer.root.findAllByProps({ 'data-project-grip': 'p1' })).toHaveLength(0);
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
    const nodes = [{ ...node(), starredSessions: [star] },
      { ...node(), id: 'p2', starredSessions: [{ ...star, sessionId: 'star-2', projectId: 'p2' }] }];
    const { renderer } = renderTree({ nodes, onToggleStars, onOpenSession });
    const header = () => renderer.root.findByProps({ 'data-starred-project': 'p1' }).findByProps({ 'aria-label': 'Stars' });
    expect(renderer.root.findAllByProps({ 'data-session-id': 'star-1' })).toHaveLength(1);
    const selected = renderer.root.findByProps({ 'data-session-id': 'star-1' });
    expect(selected.props.style.background).toBe('var(--proto-gray)');
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

  it('wires the same hover menu to loose and starred session rows', () => {
    const loose = { ...star, sessionId: 'loose', selected: false };
    const nodes = [{ ...node(), starredSessions: [{ ...star, starred: true }], sessions: [loose] }];
    const onOpenSession = vi.fn();
    const { renderer } = renderTree({ nodes, onOpenSession });
    for (const sessionId of ['loose', 'star-1']) {
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

describe('team lead rail row', () => {
  const base: RailSessionRow = { sessionId: 'lead', projectId: 'p1', title: 'Lead', age: '1h', stamp: '',
    running: false, awaitingInput: false, waitingOn: false, unread: false, selected: false };
  const w = (id: string, over: Partial<RailSessionRow> = {}): RailSessionRow =>
    ({ ...base, sessionId: id, title: id, ...over });

  it('renders a plain session row with no caret when the session has no workers', () => {
    const { renderer } = renderTree({ nodes: [{ ...node(), sessions: [base] }] });
    expect(renderer.root.findAllByProps({ 'data-lead-caret': 'lead' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-lead-group': 'lead' })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('toggles workers from the caret without opening the lead, and dims inactive workers', () => {
    const onToggleWorkers = vi.fn();
    const onOpenSession = vi.fn();
    const lead = { ...base, workers: [w('w1'), w('w2', { inactive: true })], workersExpanded: false };
    const { renderer } = renderTree({ nodes: [{ ...node(), sessions: [lead] }], onToggleWorkers, onOpenSession });
    expect(renderer.root.findAllByProps({ 'data-session-id': 'w1' })).toHaveLength(0);
    const caret = renderer.root.findByProps({ 'data-lead-caret': 'lead' });
    expect(caret.props['aria-label']).toBe('Show workers');
    const stopPropagation = vi.fn();
    act(() => caret.props.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onToggleWorkers).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'lead' }));
    expect(onOpenSession).not.toHaveBeenCalled();

    const props = renderer.root.findByType(RailTree).props as RailTreeProps;
    act(() => renderer.update(<LangProvider><RailTree {...props}
      nodes={[{ ...node(), sessions: [{ ...lead, workersExpanded: true }] }]} /></LangProvider>));
    const w1 = renderer.root.findByProps({ 'data-session-id': 'w1' });
    const w2 = renderer.root.findByProps({ 'data-session-id': 'w2' });
    expect(w1.props.style).toMatchObject({ padding: '0 8px 0 40px' });
    expect(w1.props.style.opacity).toBeUndefined();
    expect(w2.props.style.opacity).toBe(0.55);
    act(() => renderer.unmount());
  });
});


describe('session row status', () => {
  const dot = (renderer: ReactTestRenderer) => renderer.root.findAllByProps({ role: 'img' })[0];

  it.each([
    [{ running: true }, 'Running', 'var(--proto-accent)', 400],
    [{ awaitingInput: true, running: true }, 'Needs your input', 'var(--proto-amber)', 600],
  ] as const)('marks %o with a haloed dot and keeps the words out of the meta slot', (state, words, colour, weight) => {
    const { renderer } = renderTree({ nodes: [{ ...node(), sessions: [session(state)] }] });
    const row = renderer.root.findByProps({ 'data-session-id': 's1' });
    expect(dot(renderer).props['aria-label']).toBe(words);
    expect(dot(renderer).props.style).toMatchObject({ background: colour });
    expect(dot(renderer).props.style.boxShadow).toContain('0 0 0 3px');
    expect(row.props.title).toBe(`Session · ${words}`);
    expect(row.findByProps({ children: 'Session' }).props.style.fontWeight).toBe(weight);
    // The trailing slot holds the age and nothing else.
    expect(row.findByType(RailSessionMenu).props.row.age).toBe('5m');
    act(() => renderer.unmount());
  });

  it('draws a hollow ring for a session waiting on a machine and nothing for an idle one', () => {
    const { renderer } = renderTree({ nodes: [{ ...node(), sessions: [session({ waitingOn: true })] }] });
    expect(dot(renderer).props['data-rail-dot']).toBe('waiting');
    expect(dot(renderer).props.style).toMatchObject({ background: 'transparent' });
    act(() => renderer.unmount());
    const idle = renderTree({ nodes: [{ ...node(), sessions: [session()] }] }).renderer;
    expect(idle.root.findAllByProps({ role: 'img' })).toHaveLength(0);
    act(() => idle.unmount());
  });

  it('selects with a gray tint and weight, never an accent fill or spine', () => {
    const { renderer } = renderTree({ nodes: [{ ...node(), sessions: [session({ selected: true })] }] });
    const row = renderer.root.findByProps({ 'data-session-id': 's1' });
    expect(row.props.style.background).toBe('var(--proto-gray)');
    expect(row.findByProps({ children: 'Session' }).props.style).toMatchObject({ fontWeight: 550, color: 'var(--proto-ink)' });
    expect(row.findAll((n) => typeof n.props.style?.background === 'string' && n.props.style.background.includes('accent'))).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');

describe('rail schedule group', () => {
  const schedule: ScheduleRow = { scheduleId: 'sch-1', schedule: null, title: 'Nightly eval', kind: 'repeat',
    runs: [{}, {}] as unknown as ScheduleRow['runs'], latest: null, unread: false };

  it('heads the group with a plain count and lists runs as plain numbers', () => {
    const onToggleSchedules = vi.fn();
    const { renderer } = renderTree({ nodes: [{ ...node(), schedules: [schedule], schedulesExpanded: true }], onToggleSchedules });
    const header = renderer.root.findByProps({ 'aria-label': 'Scheduled' });
    expect(header.props['aria-expanded']).toBe(true);
    expect(text(header)).toBe('Scheduled1');
    act(() => header.props.onClick());
    expect(onToggleSchedules).toHaveBeenCalledWith('p1');
    const row = renderer.root.findByProps({ 'data-schedule-row': 'sch-1' });
    expect(row.props).toMatchObject({ role: 'button', tabIndex: 0 });
    expect(text(row)).toBe('Nightly eval2');
    act(() => renderer.unmount());
  });
});

describe('rail keyboard navigation', () => {
  it.each(['Enter', ' '])('opens sessions and expands projects with %j', (key) => {
    const session: RailSessionRow = { sessionId: 's1', projectId: 'p1', title: 'Session', age: '', stamp: '',
      running: false, awaitingInput: false, waitingOn: false, unread: false, selected: true };
    const onOpenSession = vi.fn();
    const onToggleProject = vi.fn();
    const { renderer } = renderTree({ nodes: [{ ...node(), sessions: [session] }], onOpenSession, onToggleProject });
    const sessionRow = renderer.root.findByProps({ 'data-session-id': 's1' });
    const projectRow = renderer.root.findByProps({ 'data-project-row': 'p1' });
    expect(sessionRow.props).toMatchObject({ role: 'button', tabIndex: 0, 'aria-current': true });
    expect(projectRow.props).toMatchObject({ role: 'button', tabIndex: 0, 'aria-expanded': true });
    for (const row of [sessionRow, projectRow]) {
      const event = { key, target: row, currentTarget: row, preventDefault: vi.fn() };
      act(() => row.props.onKeyDown(event));
      expect(event.preventDefault).toHaveBeenCalledOnce();
      act(() => row.props.onKeyDown({ ...event, target: {} }));
    }
    expect(onOpenSession).toHaveBeenCalledOnce();
    expect(onOpenSession).toHaveBeenCalledWith(session);
    expect(onToggleProject).toHaveBeenCalledOnce();
    expect(onToggleProject).toHaveBeenCalledWith('p1');
    act(() => renderer.unmount());
  });
});
