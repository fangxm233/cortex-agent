import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const h = vi.hoisted(() => ({
  dock: { canDock: true, active: false, activeKind: null as string | null, activeBoardId: null as string | null },
  openBoard: vi.fn(),
  live: { board: null as unknown, missing: false, decisions: [] as unknown[], sessions: [] as unknown[] },
}));
vi.mock('@/design/dock-intake', () => ({ useDockIntake: () => ({ ...h.dock, openBoard: h.openBoard }) }));
vi.mock('./useBoard', () => ({ useBoardLive: () => h.live }));

import { BoardChip, DockedBoardCapsule } from './BoardCapsule';

const BOARD: BoardInfo = {
  id: 'b1', projectId: 'p', slug: 'survey', title: 'Survey',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
};
const session = (sessionId: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId, boardId: 'b1', teamLeadId: 'lead', workerName: sessionId, workerRetiredAt: null, running: false, awaitingInput: false, ...over }) as SessionInfo;

let mounted: ReactTestRenderer | null = null;
beforeEach(() => { h.live = { board: BOARD, missing: false, decisions: [], sessions: [] }; });
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
const capsule = (r: ReactTestRenderer): ReactTestInstance | undefined =>
  r.root.findAll((n) => n.type === 'button' && n.props['data-board-capsule'] !== undefined)[0];
const chip = (r: ReactTestRenderer): ReactTestInstance =>
  r.root.findByProps({ 'data-activity-chip': 'board' });
const text = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');

describe('DockedBoardCapsule', () => {
  it('names the board in the header and opens it in the dock', () => {
    const el = capsule(render(<DockedBoardCapsule boardId="b1" />))!;
    expect(text(el)).toContain('Survey');
    expect(el.props['aria-label']).toBe('Open board · Survey');
    act(() => el.props.onClick());
    expect(h.openBoard).toHaveBeenCalledWith('b1');
  });

  it('steps aside while the dock shows this board, and returns when the dock shows something else or closes', () => {
    h.dock = { canDock: true, active: true, activeKind: 'board', activeBoardId: 'b1' };
    expect(capsule(render(<DockedBoardCapsule boardId="b1" />))).toBeUndefined();
    act(() => mounted!.unmount());
    h.dock = { canDock: true, active: true, activeKind: 'web', activeBoardId: null };
    expect(capsule(render(<DockedBoardCapsule boardId="b1" />))).toBeDefined();
    act(() => mounted!.unmount());
    h.dock = { canDock: true, active: false, activeKind: 'board', activeBoardId: 'b1' };
    expect(capsule(render(<DockedBoardCapsule boardId="b1" />))).toBeDefined();
  });

  it('is absent until the board loads', () => {
    h.live = { board: null, missing: false, decisions: [], sessions: [] };
    expect(render(<DockedBoardCapsule boardId="b1" />).toJSON()).toBeNull();
  });

  it('turns amber and counts the sessions waiting on the user, never a worker', () => {
    h.live = { board: BOARD, missing: false, decisions: [], sessions: [
      session('lead', { teamLeadId: null, workerName: null, awaitingInput: true }),
      session('alpha', { running: true }),
      session('beta', { awaitingInput: true }),
    ] };
    const el = capsule(render(<DockedBoardCapsule boardId="b1" />))!;
    expect(el.props['data-board-flag']).toBe('ask');
    expect(el.findByProps({ 'data-board-pending-count': 1 }).children.join('')).toBe('1 awaiting you');
  });

  it('keeps the flag accent and drops the count when nobody waits', () => {
    h.live = { board: BOARD, missing: false, decisions: [], sessions: [session('alpha', { running: true })] };
    const el = capsule(render(<DockedBoardCapsule boardId="b1" />))!;
    expect(el.props['data-board-flag']).toBe('active');
    expect(el.findAll((n) => n.props['data-board-pending-count'] !== undefined)).toHaveLength(0);
  });
});

describe('BoardChip', () => {
  it('is the flag alone while nobody waits, and opens the board', () => {
    const onOpen = vi.fn();
    const el = chip(render(<BoardChip boardId="b1" onOpen={onOpen} />));
    expect(el.findAll((n) => n.props['data-board-pending-count'] !== undefined)).toHaveLength(0);
    expect(el.props['aria-label']).toBe('Open board · Survey');
    act(() => el.props.onClick({ stopPropagation: vi.fn() }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('adds the count of what waits on the user', () => {
    h.live = { board: BOARD, missing: false, decisions: [], sessions: [
      session('lead', { teamLeadId: null, workerName: null, awaitingInput: true }),
    ] };
    const el = chip(render(<BoardChip boardId="b1" onOpen={vi.fn()} />));
    expect(text(el.findByProps({ 'data-board-pending-count': 1 }))).toBe('1');
    expect(el.props['aria-label']).toBe('Open board · Survey · 1 awaiting you');
  });
});
