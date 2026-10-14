import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const h = vi.hoisted(() => ({
  dock: { canDock: true, active: false, activeKind: null as string | null, activeBoardId: null as string | null },
  openBoard: vi.fn(),
  live: { board: null as unknown, missing: false, decisions: [] as unknown[], sessions: [] as unknown[] },
}));
vi.mock('@/design/dock-intake', () => ({ useDockIntake: () => ({ ...h.dock, openBoard: h.openBoard }) }));
vi.mock('./useBoard', () => ({ useBoardLive: () => h.live }));

import { BoardStatusBar, DockedBoardBar } from './BoardStatusBar';

const BOARD: BoardInfo = {
  id: 'b1', projectId: 'p', slug: 'survey', title: 'Survey', status: 'active',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', closedAt: null, closeNote: null,
};
const session = (sessionId: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId, boardId: 'b1', teamLeadId: 'lead', workerName: sessionId, workerRetiredAt: null, running: false, awaitingInput: false, ...over }) as SessionInfo;

let mounted: ReactTestRenderer | null = null;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = null;
  h.dock = { canDock: true, active: false, activeKind: null, activeBoardId: null };
  h.live = { board: BOARD, missing: false, decisions: [], sessions: [] };
  h.openBoard.mockReset();
});

function render(node: JSX.Element): ReactTestRenderer {
  act(() => { mounted = create(<LangProvider>{node}</LangProvider>); });
  return mounted!;
}
const bar = (r: ReactTestRenderer): ReactTestInstance | undefined =>
  r.root.findAll((n) => n.type === 'div' && n.props['data-board-bar'] !== undefined)[0];
const text = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');

describe('DockedBoardBar', () => {
  it('shows the board and opens it in the dock', () => {
    h.live = { board: BOARD, missing: false, decisions: [{}, {}], sessions: [] };
    const el = bar(render(<DockedBoardBar boardId="b1" />))!;
    expect(text(el)).toContain('Board · Survey');
    expect(text(el)).toContain('Decisions 2');
    act(() => el.props.onClick());
    expect(h.openBoard).toHaveBeenCalledWith('b1');
  });

  it('steps aside while the dock shows this board, and returns when the dock shows something else or closes', () => {
    h.live = { board: BOARD, missing: false, decisions: [], sessions: [] };
    h.dock = { canDock: true, active: true, activeKind: 'board', activeBoardId: 'b1' };
    expect(bar(render(<DockedBoardBar boardId="b1" />))).toBeUndefined();
    act(() => mounted!.unmount());
    h.dock = { canDock: true, active: true, activeKind: 'web', activeBoardId: null };
    expect(bar(render(<DockedBoardBar boardId="b1" />))).toBeDefined();
    act(() => mounted!.unmount());
    h.dock = { canDock: true, active: false, activeKind: 'board', activeBoardId: 'b1' };
    expect(bar(render(<DockedBoardBar boardId="b1" />))).toBeDefined();
  });

  it('is absent until the board loads', () => {
    h.live = { board: null, missing: false, decisions: [], sessions: [] };
    expect(render(<DockedBoardBar boardId="b1" />).toJSON()).toBeNull();
  });
});

describe('BoardStatusBar', () => {
  it('turns the flag amber and counts the sessions waiting on the user', () => {
    h.live = { board: BOARD, missing: false, decisions: [], sessions: [
      session('lead', { teamLeadId: null, workerName: null, awaitingInput: true }),
      session('alpha', { running: true }),
      session('beta', { awaitingInput: true }),
    ] };
    const el = bar(render(<BoardStatusBar boardId="b1" onOpen={vi.fn()} />))!;
    expect(el.props['data-board-flag']).toBe('ask');
    expect(el.findByProps({ 'data-board-bar-pending': 2 }).children.join('')).toBe('2 awaiting you');
    expect(el.findAll((n) => n.props['data-board-bar-session'] !== undefined && n.type === 'span').map(text))
      .toEqual(['lead', 'beta', 'alpha']);
  });

  it('keeps the flag accent and drops the pending chip when nobody waits', () => {
    h.live = { board: BOARD, missing: false, decisions: [], sessions: [session('alpha', { running: true })] };
    const el = bar(render(<BoardStatusBar boardId="b1" onOpen={vi.fn()} />))!;
    expect(el.props['data-board-flag']).toBe('active');
    expect(el.findAll((n) => n.props['data-board-bar-pending'] !== undefined)).toHaveLength(0);
  });

  it('mutes the flag and grays the state of a closed board', () => {
    h.live = { board: { ...BOARD, status: 'done' }, missing: false, decisions: [], sessions: [] };
    const el = bar(render(<BoardStatusBar boardId="b1" onOpen={vi.fn()} />))!;
    expect(el.props['data-board-flag']).toBe('closed');
    expect(el.findByProps({ 'data-board-status': 'done' }).props.style.color).toBe('var(--proto-muted)');
  });

  it('shows four sessions and folds the rest into +n', () => {
    h.live = { board: BOARD, missing: false, decisions: [], sessions: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => session(id)) };
    const el = bar(render(<BoardStatusBar boardId="b1" onOpen={vi.fn()} />))!;
    expect(el.findAll((n) => n.props['data-board-bar-session'] !== undefined && n.type === 'span')).toHaveLength(4);
    expect(text(el.findByProps({ 'data-board-bar-more': '' }))).toBe('+2');
  });

  it('opens from the keyboard too', () => {
    const onOpen = vi.fn();
    const el = bar(render(<BoardStatusBar boardId="b1" onOpen={onOpen} />))!;
    act(() => el.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
