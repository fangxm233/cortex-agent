import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((ev: { type: string; payload: unknown }) => void),
  types: [] as readonly string[],
  dock: { canDock: true },
  openBoard: vi.fn(),
}));
vi.mock('@/features/live/LiveEventsProvider', () => ({
  useLiveEvents: (types: readonly string[], handler: (ev: { type: string; payload: unknown }) => void) => { h.types = types; h.handler = handler; },
}));
vi.mock('@/design/dock-intake', () => ({ useDockIntake: () => ({ ...h.dock, openBoard: h.openBoard }) }));

import { boardToAutoOpen, useAutoOpenNewBoard } from './useAutoOpenNewBoard';

const created = (sessionId: string, boardId: string, created = true) =>
  ({ sessionId, role: 'tool', text: '', boardAction: { op: 'open', boardId, title: 'T', created } });

describe('boardToAutoOpen', () => {
  it('opens a board the session on screen just created, once', () => {
    const opened = new Set<string>();
    expect(boardToAutoOpen(created('s1', 'b1'), 's1', opened)).toBe('b1');
    expect(boardToAutoOpen(created('s1', 'b1'), 's1', opened)).toBeNull();
  });

  it('leaves attaching, other sessions, other messages and drafts alone', () => {
    const opened = new Set<string>();
    expect(boardToAutoOpen(created('s1', 'b1', false), 's1', opened)).toBeNull();
    expect(boardToAutoOpen(created('s2', 'b1'), 's1', opened)).toBeNull();
    expect(boardToAutoOpen({ sessionId: 's1', role: 'assistant', text: 'hi' }, 's1', opened)).toBeNull();
    expect(boardToAutoOpen(created('s1', 'b1'), null, opened)).toBeNull();
    expect(opened.size).toBe(0);
  });
});

describe('useAutoOpenNewBoard', () => {
  let mounted: ReactTestRenderer | null = null;
  afterEach(() => {
    if (mounted) act(() => mounted!.unmount());
    mounted = null;
    h.openBoard.mockReset();
    h.dock = { canDock: true };
  });
  function Host({ sessionId }: { sessionId: string | null }): null { useAutoOpenNewBoard(sessionId); return null; }

  it('listens to live messages only and opens the dock on a created board', () => {
    act(() => { mounted = create(<Host sessionId="s1" />); });
    expect(h.types).toEqual(['session.message']);
    act(() => h.handler!({ type: 'session.message', payload: created('s1', 'b-live') }));
    expect(h.openBoard).toHaveBeenCalledWith('b-live');
    act(() => h.handler!({ type: 'session.message', payload: created('s1', 'b-live') }));
    expect(h.openBoard).toHaveBeenCalledTimes(1);
  });

  it('does nothing where there is no dock (the phone)', () => {
    h.dock = { canDock: false };
    act(() => { mounted = create(<Host sessionId="s1" />); });
    act(() => h.handler!({ type: 'session.message', payload: created('s1', 'b-phone') }));
    expect(h.openBoard).not.toHaveBeenCalled();
  });
});
