// input:  React, mobile kit, presentation props
// output: MSessionListView
// pos:    Mobile session list card and scheduled entry
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { type CSSProperties } from 'react';
import { PlusGlyph } from '@/design';
import type { ConnectionStatus } from '@/features/connection/connection-status';
import { MScreen, MTabHeader, MScrollBody, MDot, MC, MONO } from '@/mobile/ui/kit';
import type { MSessionRow, MSessionStatus } from './m-session-list-vm';

export interface MSessionListCopy {
  title: string;
  empty: string;
}

function isLive(status: MSessionStatus): boolean {
  // A turn or a background task is actually advancing. `awaiting` is blocked ON the user, so it
  // keeps its amber semantics and stays out of this.
  return status.kind === 'running' || status.kind === 'background';
}

const PRESENCE: Record<ConnectionStatus, string> = {
  connected: 'var(--proto-success)',
  connecting: 'var(--proto-amber)',
  reconnecting: 'var(--proto-amber)',
  disconnected: MC.muted,
};

// The brand tile carrying the live link state as a presence dot.
function BrandTile({ presence }: { presence: ConnectionStatus }) {
  return (
    <div
      style={{
        position: 'relative',
        width: 28,
        height: 28,
        flex: 'none',
        borderRadius: 9,
        background: 'var(--material-control-bg)',
        border: '1px solid var(--proto-line)',
        boxShadow: 'var(--material-control-shadow)',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <svg width={20} height={20} viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <circle cx="33" cy="32" r="6" fill="var(--proto-ink)" />
        <path
          d="M42.29 23.64A12.5 12.5 0 1 0 42.29 40.36"
          stroke="var(--proto-accent)"
          strokeWidth={6}
          strokeLinecap="round"
        />
        <path
          d="M48.6 17.95A21 21 0 1 0 48.6 46.05"
          stroke="var(--proto-accent)"
          strokeWidth={6}
          strokeLinecap="round"
        />
      </svg>
      <span
        style={{
          position: 'absolute',
          right: -3,
          bottom: -3,
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: PRESENCE[presence],
          border: '2px solid var(--glass-2)',
        }}
      />
    </div>
  );
}

// The Scheduled entry (scheme-mobile 8a): a glass square in the header; unread schedules ride as a
// badge (blue — failed runs have no data source, so the badge never turns red here).
function ScheduledButton({ unread, onClick }: { unread: number; onClick: () => void }) {
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        aria-label="Scheduled"
        onClick={onClick}
        style={{
          width: 44,
          height: 44,
          borderRadius: 'var(--r-control)',
          background: 'var(--glass-2)',
          boxShadow: '0 0 0 1px var(--proto-line)',
          border: 0,
          color: 'var(--proto-muted)',
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <svg width={16} height={16} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <circle cx="7" cy="7" r="5.6" />
          <path d="M7 4v3.2l2.2 1.3" />
        </svg>
      </button>
      {unread > 0 && (
        <span
          aria-label={`${unread} unread scheduled`}
          style={{
            position: 'absolute',
            top: -3,
            right: -4,
            background: MC.run,
            color: 'var(--ink-solid-fg)',
            font: `600 11px ${MONO}`,
            padding: '1px 4.5px',
            borderRadius: 'var(--r-pill)',
            border: `1.5px solid ${MC.canvas}`,
          }}
        >
          {unread}
        </span>
      )}
    </div>
  );
}

// The dot column: live/awaiting pulse, an external wait is a still hollow ring, an unread idle row
// borrows the slot so its title stays aligned with the rows above it.
function RowDot({ row }: { row: MSessionRow }) {
  const kind = row.status.kind;
  if (isLive(row.status)) return <MDot color="var(--proto-accent)" size={7} pulse />;
  if (kind === 'awaiting') return <MDot color="var(--proto-amber)" size={7} pulse />;
  if (kind === 'waiting-external') {
    return (
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          boxSizing: 'border-box',
          border: `1.5px solid ${MC.muted}`,
          flex: 'none',
        }}
      />
    );
  }
  if (row.unread) {
    // Unread marker (mirrors desktop LeftRail); cleared by useMarkSessionRead once the chat opens.
    return (
      <span
        aria-label="unread"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--proto-accent)',
          flex: 'none',
        }}
      />
    );
  }
  return null;
}

const STATUS_COLOR: Record<MSessionStatus['kind'], string> = {
  running: 'var(--proto-accent)',
  background: 'var(--proto-accent)',
  awaiting: 'var(--proto-amber-fg)',
  'waiting-external': MC.muted,
  idle: MC.muted,
};

function Row({ row, onOpen }: { row: MSessionRow; onOpen: (id: string) => void }) {
  const kind = row.status.kind;
  const live = isLive(row.status);
  // The only shape without a dot: a read idle row. It drops the status line with it and indents to
  // keep its title on the same x as the dotted rows.
  const quiet = kind === 'idle' && !row.unread;
  const showStatus = kind !== 'idle';
  return (
    <div
      onClick={() => onOpen(row.id)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: quiet ? 44 : 48,
        padding: quiet ? '0 10px 0 29px' : '0 10px 0 12px',
        borderRadius: 'var(--r-card)',
        background: live ? 'var(--proto-accent-bg)' : undefined,
        cursor: 'pointer',
      }}
    >
      {live && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 10,
            bottom: 10,
            width: 3,
            borderRadius: 2,
            background: 'var(--proto-accent)',
          }}
        />
      )}
      <RowDot row={row} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: quiet ? 400 : 600,
            color: live ? 'var(--proto-accent)' : quiet ? MC.muted : MC.ink,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {row.title}
        </div>
        {showStatus && (
          <div
            style={{
              font: `400 11px ${MONO}`,
              color: STATUS_COLOR[kind],
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 1,
            }}
          >
            {row.status.text}
          </div>
        )}
      </div>
      <span
        style={
          live
            ? { flex: 'none', font: `500 11px ${MONO}`, color: 'var(--proto-accent)' }
            : { flex: 'none', font: `400 11px ${MONO}`, color: MC.muted }
        }
      >
        {row.time}
      </span>
    </div>
  );
}

// The whole list shares one material; rows stay unfilled and never sample blur. Rows carry their own
// relative time, so day buckets would only split one list into several cards.
const LIST_CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: 6,
  borderRadius: 'var(--r-float)',
  background: 'var(--material-card-bg)',
  boxShadow: '0 0 0 1px var(--proto-line), var(--material-card-shadow)',
  overflow: 'hidden',
};

const FAB_STYLE: CSSProperties = {
  position: 'absolute',
  right: 18,
  bottom: 'calc(104px + env(safe-area-inset-bottom))',
  height: 48,
  padding: '0 18px 0 14px',
  border: 0,
  borderRadius: 'var(--r-float)',
  background: 'var(--proto-accent)',
  color: 'var(--ink-solid-fg)',
  fontSize: 14,
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  boxShadow: 'var(--accent-glow)',
};

export function MSessionListView({
  rows,
  copy,
  presence,
  newLabel,
  scheduled,
  onOpen,
  onNew,
}: {
  rows: MSessionRow[];
  copy: MSessionListCopy;
  /** Live link state → the brand tile's presence dot. */
  presence: ConnectionStatus;
  /** Label for the new-session FAB (vocab `wbNewSession`). */
  newLabel: string;
  /** Scheduled entry (8a): hidden while the project has no schedules and no runs. */
  scheduled?: { unread: number; onOpen: () => void };
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <MScreen
      label="1a 会话列表"
      header={
        <MTabHeader
          title={copy.title}
          leading={<BrandTile presence={presence} />}
          trailing={scheduled && <ScheduledButton unread={scheduled.unread} onClick={scheduled.onOpen} />}
        />
      }
      overlay={
        <button type="button" onClick={onNew} style={FAB_STYLE}>
          <PlusGlyph size={15} strokeWidth={1.8} />
          {newLabel}
        </button>
      }
    >
      <MScrollBody gap={14} padding="0 16px 0">
        {rows.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.muted, fontSize: 13 }}>
            {copy.empty}
          </div>
        ) : (
          <div style={LIST_CARD}>
            {rows.map((row) => (
              <Row key={row.id} row={row} onOpen={onOpen} />
            ))}
          </div>
        )}
      </MScrollBody>
    </MScreen>
  );
}
