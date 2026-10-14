import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useDockIntake } from '@/design/dock-intake';
import { MENU_FOCUS, MONO } from '@/design/MenuChrome';
import { useVocab } from '@/i18n';
import { BoardRowSlot, type BoardRowRenderer } from '@/features/session/transcript/board-row-slot';
import type { BoardActionView } from '@/features/session/transcript/board-rows';
import { BoardIcon } from './BoardIcon';
import { BoardPeers, BoardPendingChip } from './BoardPeers';
import { BOARD_FLAG_COLOR, boardFlagTone, boardSummary } from './board-summary';
import { useBoardLive } from './useBoard';

// A board_open call in the chat. A board the call created reads as a card that stays live — who is
// on it, what waits on the user — with a button that opens it; attaching to an existing board is
// one quiet line. A board that no longer exists keeps its title and loses the button.

const ELLIPSIS: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

function OpenButton({ disabled, touch, onOpen, label, title }: {
  disabled: boolean;
  touch: boolean;
  onOpen: () => void;
  label: string;
  title?: string;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" className={MENU_FOCUS} data-board-card-open="" disabled={disabled} title={title}
      onClick={onOpen} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, height: touch ? 34 : 30, padding: '0 13px',
        border: 0, borderRadius: 'var(--r-control)', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
        cursor: disabled ? 'default' : 'pointer',
        color: disabled ? 'var(--proto-muted)' : 'var(--proto-accent)',
        background: disabled ? 'var(--proto-gray)' : hover ? 'color-mix(in srgb, var(--proto-accent) 14%, var(--proto-accent-bg))' : 'var(--proto-accent-bg)',
        boxShadow: disabled ? 'none' : 'inset 0 0 0 1px var(--proto-accent-border)',
      }}>
      {label} →
    </button>
  );
}

/** A board the chat's agent created: flag, title, who is on it, what waits on the user, and Open. */
function CreatedCard({ action, onOpen, touch }: { action: BoardActionView; onOpen: (boardId: string) => void; touch: boolean }): JSX.Element {
  const L = useVocab();
  const { board, missing, sessions } = useBoardLive(action.boardId);
  const { shown, pending } = boardSummary(sessions);
  const tone = boardFlagTone(pending.length);
  const ask = tone === 'ask';
  const title = board?.title ?? action.title;
  return (
    <div data-board-card={action.boardId} data-board-flag={tone} data-board-missing={missing ? '' : undefined} style={{
      display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, padding: touch ? '11px 12px' : '11px 14px',
      borderRadius: 'var(--r-card)', background: 'var(--material-card-bg)', border: '1px solid var(--border-card)',
      boxShadow: 'var(--material-card-shadow)',
    }}>
      <span aria-hidden="true" style={{
        flex: 'none', width: 32, height: 32, borderRadius: 'var(--r-control)', display: 'grid', placeItems: 'center',
        background: ask ? 'var(--proto-amber-bg)' : 'var(--proto-accent-bg)',
        boxShadow: `inset 0 0 0 1px ${ask ? 'var(--proto-amber-border)' : 'var(--proto-accent-border)'}`,
      }}>
        <BoardIcon size={15} stroke={missing ? 'var(--proto-muted)' : BOARD_FLAG_COLOR[tone]} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: `500 11px ${MONO}`, color: 'var(--proto-muted)' }}>{L.boardCreatedKicker}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginTop: 1 }}>
          <b title={title} style={{ ...ELLIPSIS, fontSize: 14, fontWeight: 650, color: 'var(--proto-ink)' }}>{title}</b>
          <BoardPendingChip count={pending.length} />
        </div>
        {shown.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 2, minWidth: 0, marginTop: 4, fontSize: 12 }}>
            <BoardPeers sessions={shown} />
          </div>
        )}
      </div>
      <OpenButton disabled={missing} touch={touch} onOpen={() => onOpen(action.boardId)} label={L.boardOpen}
        title={missing ? L.boardMissing : undefined} />
    </div>
  );
}

/** Attached to an existing board: one line. */
function AttachedLine({ action, onOpen, touch }: { action: BoardActionView; onOpen: (boardId: string) => void; touch: boolean }): JSX.Element {
  const L = useVocab();
  const { board, missing } = useBoardLive(action.boardId);
  const title = board?.title ?? action.title;
  return (
    <div data-board-line={action.boardId} data-board-missing={missing ? '' : undefined} style={{
      display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, padding: touch ? '4px 0' : '2px 2px',
      minHeight: touch ? 30 : undefined, fontSize: touch ? 13 : 12.5, color: 'var(--proto-muted)',
    }}>
      <BoardIcon size={12} stroke={missing ? 'var(--proto-muted)' : 'var(--proto-accent)'} />
      <span style={{ flex: 'none' }}>{L.boardAttachedLine}</span>
      <b title={title} style={{ ...ELLIPSIS, fontWeight: 600, color: 'var(--proto-ink)' }}>{title}</b>
      <button type="button" className={MENU_FOCUS} data-board-card-open="" disabled={missing}
        title={missing ? L.boardMissing : undefined} onClick={() => onOpen(action.boardId)}
        style={{
          flex: 'none', border: 0, padding: '0 2px', background: 'transparent', font: `400 11px ${MONO}`, whiteSpace: 'nowrap',
          color: missing ? 'var(--proto-muted)' : 'var(--proto-accent)', cursor: missing ? 'default' : 'pointer',
        }}>
        · {L.boardBarOpen} →
      </button>
    </div>
  );
}

export function BoardActionChatRow({ action, onOpen, touch = false }: {
  action: BoardActionView;
  onOpen: (boardId: string) => void;
  touch?: boolean;
}): JSX.Element {
  return action.created
    ? <CreatedCard action={action} onOpen={onOpen} touch={touch} />
    : <AttachedLine action={action} onOpen={onOpen} touch={touch} />;
}

/** Desktop: the stream's board rows open their board in the dock. */
export function BoardStreamProvider({ children }: { children: ReactNode }): JSX.Element {
  const { openBoard } = useDockIntake();
  const slot = useMemo<BoardRowRenderer>(
    () => ({ row: (row) => <BoardActionChatRow action={row.action} onOpen={openBoard} /> }),
    [openBoard],
  );
  return <BoardRowSlot.Provider value={slot}>{children}</BoardRowSlot.Provider>;
}
