// input:  the active session's commissionId plus commission and session queries
// output: the persistent chat-header strip naming the commission this session serves
// pos:    Chat-side entry point to the commission board (DR-0037)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { useAllSessions } from '@/features/projects/useProjectSessions';
import { useCommissionBoard } from './CommissionBoardModalProvider';

const mono = "'IBM Plex Mono',monospace";

// A commission session looks exactly like any other conversation, which is the problem: the whole
// point of the mode is that this turn is part of a longer commitment. The banner is the
// non-decaying anchor — always present, never scrolled away with the transcript.

export function CommissionBanner({ commissionId }: { commissionId: string }): JSX.Element | null {
  const trpc = useTRPC();
  const L = useVocab();
  const board = useCommissionBoard();
  const [hover, setHover] = useState(false);

  const commissionQuery = useQuery(trpc.commissions.get.queryOptions({ commissionId }));
  const sessionsQuery = useAllSessions('direct');
  const commission = commissionQuery.data ?? null;

  // Gate count spans the WHOLE commission, not this session: the banner's job is to say whether the
  // commission is blocked anywhere, including in a sibling session the user is not looking at.
  const gateCount = useMemo(
    () => (sessionsQuery.data ?? []).filter((s) => s.commissionId === commissionId && !!s.awaitingInput).length,
    [sessionsQuery.data, commissionId],
  );

  if (!commission) return null;
  const active = commission.status === 'active';

  return (
    <div
      onClick={() => board.openCommission(commissionId)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={L.wbCommissionOpenBoard}
      data-commission-banner={commissionId}
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '0 24px 8px',
        padding: '6px 11px',
        borderRadius: 8,
        cursor: 'pointer',
        border: '1px solid var(--proto-line-2)',
        background: hover ? 'var(--proto-gray)' : 'var(--proto-rail)',
      }}
    >
      <svg width={12} height={12} viewBox="0 0 14 14" fill="none" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" style={{ flex: 'none' }}
        stroke={gateCount > 0 ? 'var(--proto-amber)' : active ? 'var(--proto-accent)' : 'var(--proto-muted-3)'}>
        <path d="M3.7 1.9v10.2" />
        <path d="M3.7 2.7h6.8L9.1 5l1.4 2.3H3.7z" />
      </svg>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--proto-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {commission.title}
      </span>
      {!active && (
        <span style={{ font: `500 9px ${mono}`, color: 'var(--proto-muted-3)', flex: 'none' }}>
          {commission.status === 'done' ? L.wbCommissionDone : L.wbCommissionAbandoned}
        </span>
      )}
      {gateCount > 0 && (
        <span style={{ font: `500 9.5px ${mono}`, color: 'var(--proto-amber)', flex: 'none' }}>
          {L.wbCommissionGateCount.replace('{n}', String(gateCount))}
        </span>
      )}
      <span style={{ marginLeft: 'auto', font: `400 10px ${mono}`, color: 'var(--proto-muted-3)', flex: 'none' }}>
        {L.wbCommissionOpenBoard}
      </span>
    </div>
  );
}
