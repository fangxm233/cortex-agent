import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { rewindStats, type ChatRow } from '@/features/session/transcript/transcript-vm';
import type { SessionRewind } from '@/features/session/chat/useChatSession';
import { copyText } from '@/lib/clipboard';
import type { MEditMode, MMsgMenu } from './MChatView';

type UserRow = Extract<ChatRow, { kind: 'user' }>;

function editableRow(row: ChatRow | null | undefined): row is UserRow & { turnIndex: number } {
  return !!row && row.kind === 'user' && row.turnIndex !== undefined;
}

export interface MobileMessageEdit {
  /** An edit owns the composer: send = rewind to that turn and regenerate. */
  armed: boolean;
  editing: MEditMode | null;
  msgMenu: MMsgMenu | null;
  /** Long-press on a row: open its action menu, floated where the held bubble was. */
  hold: (rowIndex: number, anchorTop: number | null) => void;
  /** Send the composer text as the edited turn's replacement. */
  submit: (text: string) => void;
}

/**
 * Long-press menu + message edit: editing hijacks the composer with the row's text and gives the
 * typed text back on cancel (or once the rewind is sent).
 */
export function useMobileMessageEdit(input: {
  rows: ChatRow[];
  running: boolean;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  rewind: SessionRewind;
  onStart: () => void;
}): MobileMessageEdit {
  const { rows, running, setText, rewind } = input;
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [menuIdx, setMenuIdx] = useState<number | null>(null);
  const [menuAnchorTop, setMenuAnchorTop] = useState<number | null>(null);
  const preEditText = useRef('');
  const finish = (): void => {
    setEditingIdx(null);
    setText(preEditText.current);
    preEditText.current = '';
  };
  const start = (rowIndex: number): void => {
    const row = rows[rowIndex];
    if (!editableRow(row) || running) return;
    preEditText.current = input.text;
    input.onStart();
    setEditingIdx(rowIndex);
    setText(row.text);
  };
  // Disarm only when the edited row no longer exists. A running-state conflict must keep the draft.
  useEffect(() => {
    if (editingIdx == null) return;
    if (!editableRow(rows[editingIdx])) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, editingIdx]);

  const editingRow = editingIdx != null ? rows[editingIdx] : null;
  const armed = editableRow(editingRow);
  const held = menuIdx != null ? rows[menuIdx] : null;
  const msgMenu: MMsgMenu | null = held && (held.kind === 'user' || held.kind === 'assistant')
    ? {
        rowIndex: menuIdx!,
        anchorTop: menuAnchorTop,
        onCopy: () => { void copyText(held.text); },
        ...(editableRow(held) ? { onEdit: () => start(menuIdx!), editDisabled: running || rewind.pending } : {}),
        onClose: () => setMenuIdx(null),
      }
    : null;
  return {
    armed,
    editing: armed ? { rowIndex: editingIdx!, ...rewindStats(rows, editingIdx!), onCancel: finish } : null,
    msgMenu,
    hold: (rowIndex, anchorTop) => { setMenuAnchorTop(anchorTop); setMenuIdx(rowIndex); },
    submit: (text) => {
      if (!editableRow(editingRow)) return;
      void rewind.submit(editingRow.turnIndex, text).then(finish, () => {});
    },
  };
}
