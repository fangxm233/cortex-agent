import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const title = vi.hoisted(() => ({ value: 'Learning-rate robustness' as string | null }));
vi.mock('@/features/board/useBoard', () => ({ useBoardTitle: () => title.value }));
vi.mock('@/features/board/BoardView', () => ({
  BoardView: (props: { boardId: string; showTitle?: boolean }) => <div data-board-view={props.boardId} data-show-title={String(props.showTitle)} />,
}));
vi.mock('@/design/use-back-dismiss', () => ({ useBackDismiss: () => {} }));

import { MBoardSheet } from './MChatBoard';

describe('mobile board sheet', () => {
  it('stands on an opaque ground and names the board once, in its header', () => {
    const tree = create(<MBoardSheet boardId="b1" onClose={() => {}} onOpenSession={() => {}} />);
    const sheet = tree.root.findByProps({ 'data-board-sheet': 'b1' });
    expect(sheet.props.style.background).toBe('var(--app-backdrop)');
    expect(sheet.props.style.backdropFilter).toBeUndefined();
    expect(tree.root.findByProps({ 'data-board-sheet-title': '' }).children).toEqual(['Learning-rate robustness']);
    expect(tree.root.findByProps({ 'data-board-view': 'b1' }).props['data-show-title']).toBe('false');
    tree.unmount();
  });

  it('says what the page is until the board has loaded', () => {
    title.value = null;
    const tree = create(<MBoardSheet boardId="b1" onClose={() => {}} onOpenSession={() => {}} />);
    expect(tree.root.findByProps({ 'data-board-sheet-title': '' }).children).toEqual(['Board']);
    tree.unmount();
  });
});
