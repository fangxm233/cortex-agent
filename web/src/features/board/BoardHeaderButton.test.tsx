import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

const dock = vi.hoisted(() => ({
  current: { canDock: true, active: false, activeKind: null as string | null, activeBoardId: null as string | null },
  openBoard: vi.fn(),
}));
vi.mock('@/design/dock-intake', () => ({
  useDockIntake: () => ({ ...dock.current, openBoard: dock.openBoard, openWeb: vi.fn() }),
}));
vi.mock('./useBoard', () => ({ useBoardTitle: () => 'Survey' }));
vi.mock('@/features/notes/NotesProvider', () => ({
  useNotes: () => ({ isOpen: false, open: vi.fn(), close: vi.fn(), vm: { activeCount: 0 } }),
}));
vi.mock('@/features/workbench/chat/ChatSessionMenu', () => ({ ChatSessionMenu: () => null }));

import { ChatHeader } from '@/features/workbench/chat/ChatHeader';
import { BoardHeaderButton } from './BoardHeaderButton';

let mounted: ReactTestRenderer | null = null;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = null;
  dock.current = { canDock: true, active: false, activeKind: null, activeBoardId: null };
  dock.openBoard.mockReset();
});

function render(node: JSX.Element): ReactTestRenderer {
  act(() => { mounted = create(<LangProvider>{node}</LangProvider>); });
  return mounted!;
}

const hostButton = (r: ReactTestRenderer): ReactTestInstance =>
  r.root.find((n) => n.type === 'button' && n.props['data-board-button'] === 'b1');

describe('BoardHeaderButton', () => {
  it('is an icon-only button named after the board, opening it in the dock', () => {
    const button = hostButton(render(<BoardHeaderButton boardId="b1" />));
    expect(button.props['aria-label']).toBe('Board · Survey');
    expect(button.props.title).toBe('Board · Survey');
    expect(button.props['aria-pressed']).toBe(false);
    expect(button.children.some((c) => typeof c === 'string')).toBe(false);
    expect(button.findAllByType('svg')).toHaveLength(1);
    act(() => button.props.onClick());
    expect(dock.openBoard).toHaveBeenCalledWith('b1');
  });

  it('is pressed only while this board is the open dock tab', () => {
    dock.current = { canDock: true, active: true, activeKind: 'board', activeBoardId: 'b1' };
    expect(hostButton(render(<BoardHeaderButton boardId="b1" />)).props['aria-pressed']).toBe(true);
    act(() => mounted!.unmount());
    dock.current = { canDock: true, active: true, activeKind: 'board', activeBoardId: 'b2' };
    expect(hostButton(render(<BoardHeaderButton boardId="b1" />)).props['aria-pressed']).toBe(false);
  });

  it('is absent where the dock is unavailable', () => {
    dock.current = { ...dock.current, canDock: false };
    const r = render(<BoardHeaderButton boardId="b1" />);
    expect(r.root.findAll((n) => n.props['data-board-button'] !== undefined)).toHaveLength(0);
  });

  it('sits after the team capsule and before Browser and Notes in the chat header', () => {
    const r = render(
      <ChatHeader title="Lead" running={false} projectName="atlas" backendSessionId={null} metadataSession={null}
        team={<span data-team-slot="" />} board={<BoardHeaderButton boardId="b1" />} />,
    );
    const order = r.root
      .findAll((n) => typeof n.type === 'string' && (
        n.props['data-team-slot'] !== undefined || n.props['data-board-button'] !== undefined
        || n.props['data-browser-button'] !== undefined || n.props['data-notes-button'] !== undefined))
      .map((n) => (n.props['data-team-slot'] !== undefined ? 'team'
        : n.props['data-board-button'] !== undefined ? 'board'
          : n.props['data-browser-button'] !== undefined ? 'browser' : 'notes'));
    expect(order).toEqual(['team', 'board', 'browser', 'notes']);
  });
});
