import { useCallback, useState, type CSSProperties, type ReactNode } from 'react';
import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { MENU_FOCUS, MENU_SURFACE, MONO, useDismissMenu } from '@/design/MenuChrome';
import { fmt, useLang, useVocab } from '@/i18n';
import { useNowTick } from '@/lib/useNowTick';
import { workerDotStyle } from '@/features/team/TeamRoster';
import { workerState, workerStatusText, workerTitle } from '@/features/team/worker-roster';
import { useWorkerQuestions } from '@/features/team/useWorkerQuestions';
import { BoardIcon } from './BoardIcon';
import { BOARD_FLAG_COLOR, boardFlagTone, boardSummary } from './board-summary';

// The native strip above the board body: what the server knows live, which the agent-written body
// cannot — each bound session's state, what is waiting on the user, and the decision stream. Amber is
// spent only on "waiting on you".

const ELLIPSIS: CSSProperties = { minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

function StripChip({ tone, pressed, onClick, children, data }: {
  tone: 'ask' | 'plain';
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
  data: string;
}): JSX.Element {
  const ask = tone === 'ask';
  return (
    <button type="button" className={MENU_FOCUS} onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-expanded={pressed} {...{ [data]: '' }}
      style={{
        flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 7px',
        font: `500 11px ${MONO}`, border: 0, borderRadius: 'var(--r-chip)', cursor: 'pointer',
        color: ask ? 'var(--proto-amber-fg)' : pressed ? 'var(--proto-ink-2)' : 'var(--proto-muted)',
        background: ask ? 'var(--proto-amber-bg)' : pressed ? 'var(--proto-line-3)' : 'var(--proto-gray)',
        boxShadow: ask ? 'inset 0 0 0 1px var(--proto-amber-border)' : 'none',
      }}>
      {children}
    </button>
  );
}

function SessionStatus({ session, now, onOpen }: {
  session: SessionInfo;
  now: number;
  onOpen: (s: SessionInfo) => void;
}): JSX.Element {
  const L = useVocab();
  const lang = useLang();
  const you = workerState(session) === 'you';
  return (
    <button type="button" className={MENU_FOCUS} data-board-session={session.sessionId} onClick={() => onOpen(session)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: 280, padding: '1px 3px',
        margin: '0 -3px', border: 0, borderRadius: 4, background: 'transparent', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 12, color: 'var(--proto-ink)',
      }}>
      <span style={workerDotStyle(session, 7)} data-board-dot={workerState(session)} />
      <b style={{ ...ELLIPSIS, fontWeight: 600, flexShrink: 0, maxWidth: 140 }}>{workerTitle(session)}</b>
      <span style={{ ...ELLIPSIS, color: you ? 'var(--proto-amber-fg)' : 'var(--proto-muted)' }}>
        {workerStatusText(session, now, L, lang)}
      </span>
    </button>
  );
}

function PendingList({ sessions, onOpen }: { sessions: SessionInfo[]; onOpen: (s: SessionInfo) => void }): JSX.Element {
  const questions = useWorkerQuestions(sessions);
  return (
    <div data-board-pending-list="" onClick={(e) => e.stopPropagation()} style={{
      position: 'absolute', right: 0, top: 26, width: 300, maxHeight: 280, overflowY: 'auto', zIndex: 20,
      padding: 4, boxSizing: 'border-box', border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)',
      ...MENU_SURFACE,
    }}>
      {sessions.map((s) => (
        <button key={s.sessionId} type="button" className={MENU_FOCUS} onClick={() => onOpen(s)}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2, width: '100%', padding: '6px 8px',
            border: 0, borderRadius: 'var(--r-chip)', background: 'transparent', cursor: 'pointer', textAlign: 'left',
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--proto-gray)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--proto-ink)' }}>
            <span style={workerDotStyle(s, 7)} />
            <span style={ELLIPSIS}>{workerTitle(s)}</span>
          </span>
          {questions[s.sessionId] && (
            <span style={{ ...ELLIPSIS, fontSize: 11.5, color: 'var(--proto-muted)', paddingLeft: 13 }}>{questions[s.sessionId]}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export interface BoardLiveStripProps {
  board: BoardInfo;
  sessions: SessionInfo[];
  decisionCount: number;
  decisionsOpen: boolean;
  onToggleDecisions: () => void;
  onOpenSession: (session: SessionInfo) => void;
}

export function BoardLiveStrip(props: BoardLiveStripProps): JSX.Element {
  const L = useVocab();
  const { board } = props;
  const now = useNowTick(true, 30_000);
  const [pendingOpen, setPendingOpen] = useState(false);
  const closePending = useCallback(() => setPendingOpen(false), []);
  useDismissMenu(pendingOpen, closePending, closePending);

  const { shown, pending } = boardSummary(props.sessions);
  const openPending = () => {
    if (pending.length === 1) props.onOpenSession(pending[0]!);
    else setPendingOpen((v) => !v);
  };

  return (
    <div data-board-strip="" style={{
      flex: 'none', margin: '10px 12px 0', padding: '9px 12px', borderRadius: 'var(--r-card)',
      background: 'var(--material-inset-bg)', border: '1px solid var(--border-card)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <BoardIcon stroke={BOARD_FLAG_COLOR[boardFlagTone(pending.length)]} />
        <span title={board.title} style={{ ...ELLIPSIS, fontSize: 13, fontWeight: 650, color: 'var(--proto-ink)' }}>
          {board.title}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 7, rowGap: 4 }}>
        {shown.length === 0
          ? <span style={{ fontSize: 12, color: 'var(--proto-muted)' }}>{L.boardNoSessions}</span>
          : shown.map((s) => <SessionStatus key={s.sessionId} session={s} now={now} onOpen={props.onOpenSession} />)}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, position: 'relative' }}>
          {pending.length > 0 && (
            <StripChip tone="ask" data="data-board-pending" pressed={pendingOpen} onClick={openPending}>
              {fmt(L.boardNeedsYou, { n: pending.length })} →
            </StripChip>
          )}
          <StripChip tone="plain" data="data-board-decisions" pressed={props.decisionsOpen} onClick={props.onToggleDecisions}>
            {fmt(L.boardDecisions, { n: props.decisionCount })} {props.decisionsOpen ? '↑' : '→'}
          </StripChip>
          {pendingOpen && pending.length > 1 && (
            <PendingList sessions={pending} onOpen={(s) => { setPendingOpen(false); props.onOpenSession(s); }} />
          )}
        </span>
      </div>
    </div>
  );
}
