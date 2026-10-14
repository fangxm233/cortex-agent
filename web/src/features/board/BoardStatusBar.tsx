import type { CSSProperties, KeyboardEvent } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useDockIntake } from '@/design/dock-intake';
import { MENU_FOCUS, MONO } from '@/design/MenuChrome';
import { fmt, useVocab } from '@/i18n';
import { workerDotStyle } from '@/features/team/TeamRoster';
import { workerTitle } from '@/features/team/worker-roster';
import { BoardIcon } from './BoardIcon';
import { BoardStatusChip } from './BoardLiveStrip';
import { BOARD_FLAG_COLOR, boardFlagTone, boardSummary } from './board-summary';
import { useBoardLive } from './useBoard';
import './board-bar.css';

// A bound session's board, as one line under the chat header (desktop) or the phone's header: the
// flag, the board, its state, who is doing what, and what waits on the user. The whole line opens it.

/** Session dots shown before the rest collapse into "+n". */
export const BAR_SESSIONS = 4;

const BAR: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, padding: '6px 11px', boxSizing: 'border-box',
  borderRadius: 'var(--r-control)', border: '1px solid var(--border-card)', background: 'var(--material-card-bg)',
  boxShadow: 'var(--material-card-shadow)', fontSize: 12, lineHeight: '18px', color: 'var(--proto-ink)',
  whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'pointer',
};
const ELLIPSIS: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' };
const META: CSSProperties = { flex: 'none', font: `400 11px ${MONO}`, color: 'var(--proto-muted)' };

function Sep({ className }: { className?: string }): JSX.Element {
  return <span aria-hidden="true" className={className} style={{ flex: 'none', width: 1, height: 12, background: 'var(--proto-line-3)' }} />;
}

function SessionDot({ session, leadLabel }: { session: SessionInfo; leadLabel: string }): JSX.Element {
  const name = session.teamLeadId ? session.workerName || workerTitle(session) : leadLabel;
  return (
    <span data-board-bar-session={session.sessionId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, color: 'var(--proto-muted)' }}>
      <span style={workerDotStyle(session, 6)} />
      <span style={{ ...ELLIPSIS, maxWidth: 96 }}>{name}</span>
    </span>
  );
}

export function BoardStatusBar({ boardId, onOpen, column }: {
  boardId: string;
  onOpen: () => void;
  /** Desktop: inset and capped like the chat column and composer. */
  column?: boolean;
}): JSX.Element | null {
  const L = useVocab();
  const { board, sessions, decisions } = useBoardLive(boardId);
  if (!board) return null;
  const { shown, pending } = boardSummary(sessions);
  const tone = boardFlagTone(board.status, pending.length);
  const visible = shown.slice(0, BAR_SESSIONS);
  const more = shown.length - visible.length;
  const name = `${L.boardTitle} · ${board.title}`;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); }
  };

  const bar = (
    <div className="board-bar-frame" style={column ? { maxWidth: 760, margin: '0 auto' } : undefined}>
      <div role="button" tabIndex={0} className={`board-bar ${MENU_FOCUS}`} data-board-bar={boardId} data-board-flag={tone}
        aria-label={`${L.boardOpen} · ${board.title}`} title={name} onClick={onOpen} onKeyDown={onKeyDown} style={BAR}>
        <BoardIcon size={12} stroke={BOARD_FLAG_COLOR[tone]} />
        <span style={{ ...ELLIPSIS, flexShrink: 1, fontWeight: 600 }}>{name}</span>
        <BoardStatusChip status={board.status} quiet />
        {visible.length > 0 && (
          <span className="board-bar-sessions" style={{ alignItems: 'center', gap: 10, minWidth: 0, flexShrink: 1 }}>
            <Sep />
            {visible.map((s) => <SessionDot key={s.sessionId} session={s} leadLabel={L.boardLead} />)}
            {more > 0 && <span data-board-bar-more="" style={META}>+{more}</span>}
          </span>
        )}
        <Sep className={pending.length > 0 ? undefined : 'board-bar-decisions'} />
        {pending.length > 0 && (
          <span data-board-bar-pending={pending.length} style={{
            flex: 'none', font: `500 11px ${MONO}`, borderRadius: 'var(--r-chip)', padding: '0 7px',
            color: 'var(--proto-amber-fg)', background: 'var(--proto-amber-bg)', boxShadow: 'inset 0 0 0 1px var(--proto-amber-border)',
          }}>
            {fmt(L.boardNeedsYou, { n: pending.length })}
          </span>
        )}
        <span className="board-bar-decisions" style={META}>{fmt(L.boardDecisions, { n: decisions.length })}</span>
        <span style={{ ...META, marginLeft: 'auto' }}>{L.boardBarOpen} →</span>
      </div>
    </div>
  );
  return column ? <div data-board-bar-slot="" style={{ flex: 'none', padding: '8px 32px 0' }}>{bar}</div> : bar;
}

/** The desktop chat's bar: opens the board in the dock, and steps aside while the dock already shows it. */
export function DockedBoardBar({ boardId }: { boardId: string }): JSX.Element | null {
  const { canDock, active, activeBoardId, openBoard } = useDockIntake();
  if (!canDock || (active && activeBoardId === boardId)) return null;
  return <BoardStatusBar boardId={boardId} column onOpen={() => openBoard(boardId)} />;
}
