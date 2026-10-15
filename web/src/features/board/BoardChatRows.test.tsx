import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { useBoardRowSlot } from '@/features/session/transcript/board-row-slot';

const h = vi.hoisted(() => ({
  live: { board: null as unknown, missing: false, decisions: [] as unknown[], sessions: [] as unknown[] },
  openBoard: vi.fn(),
}));
vi.mock('./useBoard', () => ({ useBoardLive: () => h.live }));
vi.mock('@/design/dock-intake', () => ({ useDockIntake: () => ({ canDock: true, openBoard: h.openBoard }) }));

import { BoardActionChatRow, BoardStreamProvider } from './BoardChatRows';

const BOARD: BoardInfo = { id: 'b1', projectId: 'p', slug: 'survey', title: 'Survey (live)', createdAt: '', updatedAt: '' };
const session = (sessionId: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId, boardId: 'b1', teamLeadId: 'lead', workerName: sessionId, running: false, awaitingInput: false, ...over }) as SessionInfo;
const created = { boardId: 'b1', title: 'Survey', created: true, ts: null };
const attached = { ...created, created: false };

let mounted: ReactTestRenderer | null = null;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = null;
  h.live = { board: BOARD, missing: false, decisions: [], sessions: [] };
  h.openBoard.mockReset();
});
function render(node: JSX.Element): ReactTestRenderer {
  act(() => { mounted = create(<LangProvider>{node}</LangProvider>); });
  return mounted!;
}
const text = (n: ReactTestInstance): string => n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
const openButton = (r: ReactTestRenderer) => r.root.find((n) => n.type === 'button' && n.props['data-board-card-open'] !== undefined);

describe('board card for a created board', () => {
  it('names the board live, lists who is on it, and opens it', () => {
    h.live = { board: BOARD, missing: false, decisions: [], sessions: ['a', 'b', 'c', 'd', 'e'].map((id) => session(id, { running: true })) };
    const onOpen = vi.fn();
    const r = render(<BoardActionChatRow action={created} onOpen={onOpen} />);
    const card = r.root.find((n) => n.props['data-board-card'] === 'b1' && n.type === 'div');
    expect(text(card)).toContain('Board created');
    expect(text(card)).toContain('Survey (live)');
    expect(card.props['data-board-flag']).toBe('active');
    expect(card.findAll((n) => n.type === 'span' && n.props['data-board-peer'] !== undefined)).toHaveLength(4);
    expect(text(card.findByProps({ 'data-board-peers-more': '' }))).toBe('+1');
    expect(card.findAll((n) => n.props['data-board-pending-count'] !== undefined)).toHaveLength(0);
    expect(text(openButton(r))).toBe('Open board →');
    act(() => openButton(r).props.onClick());
    expect(onOpen).toHaveBeenCalledWith('b1');
  });

  it('turns amber and counts what waits on the user', () => {
    h.live = { board: BOARD, missing: false, decisions: [], sessions: [
      session('lead', { teamLeadId: null, workerName: null, awaitingInput: true }), session('a', { awaitingInput: true }), session('b'),
    ] };
    const r = render(<BoardActionChatRow action={created} onOpen={vi.fn()} />);
    const card = r.root.find((n) => n.props['data-board-card'] === 'b1' && n.type === 'div');
    expect(card.props['data-board-flag']).toBe('ask');
    // Only the lead: the worker's question is its lead's to answer.
    expect(text(card.findByProps({ 'data-board-pending-count': 1 }))).toBe('1 awaiting you');
  });

  it('keeps the reported title and greys the button once the board is gone', () => {
    h.live = { board: null, missing: true, decisions: [], sessions: [] };
    const r = render(<BoardActionChatRow action={created} onOpen={vi.fn()} />);
    expect(text(r.root.find((n) => n.props['data-board-card'] === 'b1' && n.type === 'div'))).toContain('Survey');
    expect(openButton(r).props.disabled).toBe(true);
    expect(openButton(r).props.title).toBe('This board no longer exists.');
  });

  it('shows no state chip: a board has no status', () => {
    const r = render(<BoardActionChatRow action={created} onOpen={vi.fn()} />);
    expect(r.root.findAll((n) => n.props['data-board-status'] !== undefined)).toHaveLength(0);
  });
});

describe('board line for an attached board', () => {
  it('is one line with an Open link', () => {
    const onOpen = vi.fn();
    const r = render(<BoardActionChatRow action={attached} onOpen={onOpen} />);
    const line = r.root.find((n) => n.props['data-board-line'] === 'b1' && n.type === 'div');
    expect(text(line)).toBe('Attached to boardSurvey (live)· Open →');
    expect(r.root.findAll((n) => n.props['data-board-card'] !== undefined)).toHaveLength(0);
    act(() => openButton(r).props.onClick());
    expect(onOpen).toHaveBeenCalledWith('b1');
  });

  it('cannot open a board that is gone', () => {
    h.live = { board: null, missing: true, decisions: [], sessions: [] };
    expect(openButton(render(<BoardActionChatRow action={attached} onOpen={vi.fn()} />)).props.disabled).toBe(true);
  });
});

describe('BoardStreamProvider', () => {
  it('hands the desktop stream a renderer that opens boards in the dock', () => {
    let slot: ReturnType<typeof useBoardRowSlot> = null;
    function Probe(): null { slot = useBoardRowSlot(); return null; }
    render(<BoardStreamProvider><Probe /></BoardStreamProvider>);
    act(() => { mounted!.update(<LangProvider><BoardStreamProvider><Probe />{slot?.row({ kind: 'board-action', action: created })}</BoardStreamProvider></LangProvider>); });
    act(() => openButton(mounted!).props.onClick());
    expect(h.openBoard).toHaveBeenCalledWith('b1');
  });
});
