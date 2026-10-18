import { useCallback, useState, type CSSProperties, type ReactNode } from 'react';
import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { MENU_FOCUS, MENU_SURFACE, useDismissMenu } from '@/design/MenuChrome';
import { fmt, useLang, useVocab } from '@/i18n';
import { formatSpan, type TimeLang } from '@/i18n/time-format';
import { useNowTick } from '@/lib/useNowTick';
import { workerDotStyle } from '@/features/team/TeamRoster';
import { workerState, workerStatusText, workerTitle } from '@/features/team/worker-roster';
import { useWorkerQuestions } from '@/features/team/useWorkerQuestions';
import { BoardIcon } from './BoardIcon';
import { BOARD_FLAG_COLOR, boardFlagTone, boardSummary } from './board-summary';

// The native strip above the board body: what the server knows live, which the agent-written body
// cannot — each bound session's state, what is waiting on the user, and the decision stream. One
// quiet line on the pane, in the app's row grammar: a status dot, the name, a muted age; the
// two actions on the right are text links, not chips. Amber is spent only on "waiting on you".
// The line holds as long as it can: sessions share it, their names truncating, and only wrap once
// each is down to a readable minimum.

const ELLIPSIS: CSSProperties = { minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
/** The narrowest a session gets before the line wraps: its dot, a few letters of name, its age. */
const SESSION_MIN = 120;

/** The team's dot (workerDotStyle) at strip size. An idle session is its light hollow ring — on a
 *  board, idle mostly means "done with its part", and a filled dot would read as still pending — kept
 *  lighter than the waiting ring's darker stroke. The rings draw a size up so their stroke matches a
 *  filled dot's weight. A running dot breathes; the app's reduced-motion setting stills it. */
export function stripDotStyle(s: SessionInfo): CSSProperties {
  switch (workerState(s)) {
    case 'idle':
    case 'waiting':
      return workerDotStyle(s, 8);
    case 'running':
      return { ...workerDotStyle(s, 7), animation: 'cxring 1.8s ease-out infinite' };
    case 'you':
      return workerDotStyle(s, 7);
  }
}

/** What follows a session's name: only how long since it was last active. The dot carries the state,
 *  so no status word repeats it; the roster's full wording ("running 4m", "waiting") is the row's
 *  tooltip and accessible name. Null when the time is unknown. */
export function stripAge(s: SessionInfo, now: number, lang: TimeLang): string | null {
  const at = Date.parse(s.lastUsedAt);
  return Number.isNaN(at) ? null : formatSpan(now - at, lang);
}

/** "Decisions 7 ›" / "2 awaiting you ›": a text link in the strip's face. The chevron turns down
 *  while what it opens is open. Only the words underline on hover: a decoration on the button would
 *  reach the chevron too, and turn into a vertical tick when it rotates. */
function StripLink({ tone, expanded, onClick, children, data }: {
  tone: 'ask' | 'accent';
  expanded: boolean;
  onClick: () => void;
  children: ReactNode;
  data: string;
}): JSX.Element {
  return (
    <button type="button" className={`${MENU_FOCUS} group/strip-link`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-expanded={expanded} {...{ [data]: '' }}
      style={{
        flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 3px', margin: '0 -3px',
        border: 0, borderRadius: 4, background: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap',
        fontFamily: 'inherit', fontSize: 12.5, fontWeight: 550, fontVariantNumeric: 'tabular-nums',
        color: tone === 'ask' ? 'var(--proto-amber-fg)' : 'var(--proto-accent)',
      }}>
      <span className="group-hover/strip-link:underline underline-offset-[3px]">{children}</span>
      <span aria-hidden="true" style={{
        display: 'inline-block', fontSize: 14, lineHeight: 1, transition: 'transform .15s ease',
        transform: expanded ? 'rotate(90deg)' : 'none',
      }}>›</span>
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
  const full = `${workerTitle(session)} · ${workerStatusText(session, now, L, lang)}`;
  const age = stripAge(session, now, lang);
  return (
    <button type="button" className={MENU_FOCUS} data-board-session={session.sessionId} onClick={() => onOpen(session)}
      title={full} aria-label={full}
      style={{
        // Grow from nothing to at most the content's width, so the sessions share the line and
        // truncate their names before the line wraps at SESSION_MIN each.
        flex: '1 1 0', minWidth: SESSION_MIN, maxWidth: 'max-content',
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 3px',
        margin: '0 -3px', border: 0, borderRadius: 4, background: 'transparent', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 12.5, color: 'var(--proto-faint)',
      }}>
      <span style={stripDotStyle(session)} data-board-dot={workerState(session)} />
      <span style={{ ...ELLIPSIS, fontWeight: 550, color: 'var(--proto-ink-3)', maxWidth: 160 }}>{workerTitle(session)}</span>
      {age && <span style={{ flex: 'none', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{age}</span>}
    </button>
  );
}

function PendingList({ sessions, onOpen }: { sessions: SessionInfo[]; onOpen: (s: SessionInfo) => void }): JSX.Element {
  const questions = useWorkerQuestions(sessions);
  return (
    <div data-board-pending-list="" onClick={(e) => e.stopPropagation()} style={{
      position: 'absolute', right: 0, top: 28, width: 300, maxHeight: 280, overflowY: 'auto', zIndex: 20,
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
            <span style={{ ...ELLIPSIS, fontSize: 12, color: 'var(--proto-muted)', paddingLeft: 13 }}>{questions[s.sessionId]}</span>
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
  /** Lead with the board's flag and title. Off in the dock, whose tab already names the board. */
  showTitle?: boolean;
  /** Side padding, matching the board body below. */
  gutter?: number;
}

export function BoardLiveStrip(props: BoardLiveStripProps): JSX.Element {
  const L = useVocab();
  const { board, showTitle = true, gutter = 20 } = props;
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
      flex: 'none', padding: `6px ${gutter}px`, borderBottom: '1px solid var(--proto-line)',
    }}>
      {showTitle && (
        <div data-board-strip-title="" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, padding: '4px 0 2px' }}>
          <BoardIcon stroke={BOARD_FLAG_COLOR[boardFlagTone(pending.length)]} />
          <span title={board.title} style={{ ...ELLIPSIS, fontSize: 13.5, fontWeight: 600, color: 'var(--proto-ink)' }}>
            {board.title}
          </span>
        </div>
      )}

      {/* Sessions wrap among themselves; the links hold the first line's right end. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 16px', minHeight: 28 }}>
          {shown.length === 0
            ? <span style={{ fontSize: 12.5, color: 'var(--proto-muted)' }}>{L.boardNoSessions}</span>
            : shown.map((s) => <SessionStatus key={s.sessionId} session={s} now={now} onOpen={props.onOpenSession} />)}
        </div>
        <span style={{ flex: 'none', height: 28, display: 'flex', alignItems: 'center', gap: 14, position: 'relative' }}>
          {pending.length > 0 && (
            <StripLink tone="ask" data="data-board-pending" expanded={pendingOpen} onClick={openPending}>
              {fmt(L.boardNeedsYou, { n: pending.length })}
            </StripLink>
          )}
          <StripLink tone="accent" data="data-board-decisions" expanded={props.decisionsOpen} onClick={props.onToggleDecisions}>
            {fmt(L.boardDecisions, { n: props.decisionCount })}
          </StripLink>
          {pendingOpen && pending.length > 1 && (
            <PendingList sessions={pending} onOpen={(s) => { setPendingOpen(false); props.onOpenSession(s); }} />
          )}
        </span>
      </div>
    </div>
  );
}
