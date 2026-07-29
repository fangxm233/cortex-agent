// input:  session-scoped thread queries and detail modal opener
// output: inline live thread progress card
// pos:    Thread status card inside the desktop chat stream
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { useThreadDetailModal } from '@/features/thread/ThreadDetailModal';
import { buildThreadCard, type ProtoCard, type ProtoRow, type ProtoSub } from './thread-card-proto';

// Inline thread card — 1:1 from prototype.dc.html L180–246, bound to REAL threads.get (B1). This is
// the single live-data surface of the center chat: it re-flows live via useThreadGetLiveSync as the
// thread advances. Scoped to the CURRENT session: threads.list({sessionId}) resolves the session's
// channel server-side and returns only the thread(s) running on it, so the card shows the thread THIS
// conversation spawned — not a random global one. It renders nothing when the session owns no active
// thread (empty list) or when no session is selected. Renders whatever the DTO carries (data-driven).

const mono = "'IBM Plex Mono',monospace";

function NodeCell({ row }: { row: ProtoRow }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {row.node === 'done' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--proto-success-bg)',
            color: 'var(--proto-success)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 8,
            fontWeight: 700,
            flex: 'none',
          }}
        >
          ✓
        </span>
      )}
      {row.node === 'running' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--proto-accent)',
            flex: 'none',
            boxShadow: '0 0 0 3px var(--proto-accent-bg)',
            animation: 'cxpulse 1.6s ease-in-out infinite',
          }}
        />
      )}
      {row.node === 'pending' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '1.5px solid var(--proto-line-3)',
            boxSizing: 'border-box',
            flex: 'none',
          }}
        />
      )}
      {row.hasTail && (
        <span style={{ flex: 1, width: 1.5, background: 'var(--proto-line-2)', margin: '3px 0' }} />
      )}
    </div>
  );
}

function SubCard({ sub, onOpenNested }: { sub: ProtoSub; onOpenNested: () => void }) {
  return (
    <div style={{ border: '1px solid ' + sub.border, background: sub.bg, borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px' }}>
        <span style={{ color: 'var(--proto-muted-2)', fontSize: 9 }}>{sub.chev}</span>
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={sub.iconColor} strokeWidth="1.8">
          <path d="M7 1.5v5M7 6.5 3.5 10M7 6.5l3.5 3.5" />
          <circle cx="7" cy="1.5" r="1.4" fill={sub.iconColor} stroke="none" />
          <circle cx="3.5" cy="11" r="1.4" fill={sub.iconColor} stroke="none" />
          <circle cx="10.5" cy="11" r="1.4" fill={sub.iconColor} stroke="none" />
        </svg>
        <span style={{ font: `600 11px ${mono}`, color: sub.nameColor }}>{sub.name}</span>
        <span style={{ font: `400 9px ${mono}`, color: 'var(--proto-faint)' }}>{sub.level}</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 9.5,
            fontWeight: 600,
            padding: '1.5px 7px',
            borderRadius: 999,
            background: sub.pillBg,
            color: sub.pillColor,
          }}
        >
          {sub.pillText}
        </span>
      </div>
      {sub.hasLine && (
        <div style={{ padding: '0 10px 8px 27px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--proto-muted)' }}>
            <span>{sub.line}</span>
            <span style={{ marginLeft: 'auto', font: `400 9.5px ${mono}`, color: 'var(--proto-muted-3)' }}>{sub.meta}</span>
          </div>
          {sub.nested && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                border: '1px solid var(--proto-line-2)',
                background: 'var(--proto-card)',
                borderRadius: 7,
                padding: '5.5px 9px',
                marginTop: 6,
              }}
            >
              <span style={{ color: 'var(--proto-faint)', fontSize: 9 }}>▸</span>
              <span style={{ font: `600 10.5px ${mono}`, color: 'var(--proto-ink-2)' }}>{sub.nested.name}</span>
              <span style={{ font: `400 9px ${mono}`, color: 'var(--proto-faint)' }}>{sub.nested.level}</span>
              {sub.nested.running && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--proto-accent)',
                    animation: 'cxpulse 1.6s ease-in-out infinite',
                  }}
                />
              )}
              <span style={{ fontSize: 9.5, color: 'var(--proto-muted-3)' }}>{sub.nested.meta}</span>
              <span
                onClick={onOpenNested}
                style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}
              >
                Open ›
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InlineCardHeader({ card, onOpen }: { card: ProtoCard; onOpen: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 13px', background: 'var(--proto-rail)', borderBottom: '1px solid var(--proto-line-2)' }}>
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--proto-accent)" strokeWidth="1.6">
        <circle cx="3.5" cy="3" r="1.9" /><circle cx="3.5" cy="11" r="1.9" />
        <circle cx="10.5" cy="7" r="1.9" /><path d="M3.5 5v4M5.4 3.7 8.7 6.1M5.4 10.3 8.7 7.9" />
      </svg>
      <span style={{ font: `600 12px ${mono}`, color: 'var(--proto-ink)' }}>{card.name}</span>
      <span style={{ font: `400 10.5px ${mono}`, color: 'var(--proto-muted-3)' }}>{card.id}</span>
      <span style={{ fontSize: 10, fontWeight: 600, padding: '1.5px 7px', borderRadius: 999, background: card.pill.bg, color: card.pill.color }}>{card.pillText}</span>
      <span style={{ marginLeft: 'auto', font: `400 10.5px ${mono}`, color: 'var(--proto-muted-3)' }}>{card.meta}</span>
      <span onClick={onOpen} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}>Open →</span>
    </div>
  );
}

function InlineRow({ row, onOpenNested }: { row: ProtoRow; onOpenNested: () => void }) {
  return (
    <Fragment>
      <NodeCell row={row} />
      <div style={{ paddingBottom: row.padB }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span style={{ fontSize: 11.5, fontWeight: row.fw, color: row.color, flex: 'none' }}>{row.name}</span>
          <span style={{ fontSize: 9.5, color: row.subColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.sub}</span>
          <span style={{ marginLeft: 'auto', font: `400 9.5px ${mono}`, color: row.metaColor, flex: 'none' }}>{row.meta}</span>
          {row.chev && <span style={{ color: 'var(--proto-line-3)', fontSize: 8, flex: 'none' }}>▸</span>}
        </div>
        {row.expanded && row.subs.length > 0 && (
          <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {row.subs.map((sub, index) => <SubCard key={index} sub={sub} onOpenNested={onOpenNested} />)}
          </div>
        )}
      </div>
    </Fragment>
  );
}

function InlineCardView({ card, onOpen }: { card: ProtoCard; onOpen: () => void }) {
  return (
    <div data-inline-thread-id={card.id} style={{ border: '1px solid var(--proto-line)', borderRadius: 10, overflow: 'hidden' }}>
      <InlineCardHeader card={card} onOpen={onOpen} />
      <div style={{ padding: '10px 14px 6px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '16px 1fr', columnGap: 9 }}>
          {card.rows.map((row, index) => <InlineRow key={index} row={row} onOpenNested={onOpen} />)}
        </div>
      </div>
    </div>
  );
}

export function InlineThreadCardProto({ sessionId }: { sessionId: string }): JSX.Element | null {
  const { openThread } = useThreadDetailModal();
  const trpc = useTRPC();
  const list = useQuery({
    ...trpc.threads.list.queryOptions({ status: ['running', 'waiting'], sessionId }),
    enabled: !!sessionId,
  });
  const threads = list.data ?? [];
  const threadId = (threads.find((thread) => thread.status === 'running') ?? threads[0])?.id ?? '';
  useThreadGetLiveSync(threadId);
  const detail = useQuery({
    ...trpc.threads.get.queryOptions({ threadId }),
    enabled: !!threadId,
  });
  if (!threadId || !detail.data || detail.isError) return null;
  return <InlineCardView card={buildThreadCard(detail.data)} onOpen={() => openThread(threadId)} />;
}
