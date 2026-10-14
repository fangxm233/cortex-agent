import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
import { BoardRowSlot } from './board-row-slot';
import { ChatRows } from './MessageStream';
import type { ChatRow } from './transcript-vm';

const rows: ChatRow[] = [
  { kind: 'user', text: 'plan it', turnIndex: 1, ts: '2026-10-13T00:00:00.000Z' },
  { kind: 'board-action', action: { boardId: 'b1', title: 'Survey', created: true, ts: null } },
];

function render(withSlot: boolean): ReactTestRenderer {
  const tree = <LangProvider><ChatRows rows={rows} /></LangProvider>;
  let r!: ReactTestRenderer;
  act(() => {
    r = create(withSlot
      ? <BoardRowSlot.Provider value={{ row: (row) => <span data-slot-board={row.action.boardId} /> }}>{tree}</BoardRowSlot.Provider>
      : tree);
  });
  return r;
}

describe('desktop stream board rows', () => {
  it('draws a board row through the board slot', () => {
    const r = render(true);
    const row = r.root.find((n) => n.type === 'div' && n.props['data-row'] === 'board-action');
    expect(row.findAll((n) => n.props['data-slot-board'] === 'b1')).toHaveLength(1);
    act(() => r.unmount());
  });

  it('draws nothing for it where no board feature is mounted', () => {
    const r = render(false);
    expect(r.root.findAll((n) => n.props['data-row'] === 'board-action')).toHaveLength(0);
    act(() => r.unmount());
  });
});
