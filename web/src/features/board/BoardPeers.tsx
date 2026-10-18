import type { CSSProperties } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { fmt, useVocab } from '@/i18n';
import { workerDotStyle } from '@/features/team/TeamRoster';
import { workerTitle } from '@/features/team/worker-roster';

// The pieces the chat's board bar and board cards share: who is on the board, as dots with short
// names, and how many of them wait on the user.

/** Session dots shown before the rest collapse into "+n". */
export const PEERS_SHOWN = 4;

const ELLIPSIS: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/** A worker goes by its worker name. A session that is not a worker is "lead" while it is the only
 *  one on the board; once others join directly, each goes by its own title so they can be told apart. */
function Peer({ session, leadLabel }: { session: SessionInfo; leadLabel: string | null }): JSX.Element {
  const name = session.teamLeadId || leadLabel === null ? workerTitle(session) : leadLabel;
  return (
    <span data-board-peer={session.sessionId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, color: 'var(--proto-muted)' }}>
      <span style={workerDotStyle(session, 6)} />
      <span style={{ ...ELLIPSIS, maxWidth: 96 }}>{name}</span>
    </span>
  );
}

/** The bound sessions (already in display order): the first four, then "+n". */
export function BoardPeers({ sessions }: { sessions: SessionInfo[] }): JSX.Element | null {
  const L = useVocab();
  if (sessions.length === 0) return null;
  const visible = sessions.slice(0, PEERS_SHOWN);
  const more = sessions.length - visible.length;
  const leadLabel = sessions.filter((s) => !s.teamLeadId).length > 1 ? null : L.boardLead;
  return (
    <>
      {visible.map((s) => <Peer key={s.sessionId} session={s} leadLabel={leadLabel} />)}
      {more > 0 && <span data-board-peers-more="" style={{ flex: 'none', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--proto-muted)' }}>+{more}</span>}
    </>
  );
}

/** "n awaiting you" as amber words, not a filled badge; nothing when n is 0. */
export function BoardPendingChip({ count }: { count: number }): JSX.Element | null {
  const L = useVocab();
  if (count === 0) return null;
  return (
    <span data-board-pending-count={count} style={{
      flex: 'none', fontSize: 12, fontWeight: 550, lineHeight: '18px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
      color: 'var(--proto-amber-fg)',
    }}>
      {fmt(L.boardNeedsYou, { n: count })}
    </span>
  );
}
