import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import {
  WAIT_RAIL_COPY,
  waitRailViewModel,
  type WaitRailBadge,
  type WaitRailChromeCopy,
  type WaitRailLanguage,
  type WaitRailRow,
} from './wait-rail-vm';

const MONO = "'IBM Plex Mono',monospace";
/** Bounded so a long list can never push the composer off screen; the list scrolls instead. */
const EXPANDED_MAX_HEIGHT = '40vh';

function storageKey(sessionId: string): string {
  return `cortex.waitRailOpen.${sessionId}`;
}

/** Per session and persisted, like TodoRail. Collapsed by default: the rail exists to be glanceable,
 *  and a session waiting on something is not, by itself, a reason to steal composer space. */
function useExpanded(sessionId: string): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { setOpen(window.localStorage.getItem(storageKey(sessionId)) === '1'); }
    catch { setOpen(false); }
  }, [sessionId]);
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(storageKey(sessionId), next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, [sessionId]);
  return [open, toggle];
}

/**
 * The marker for "something is pending, but not on you". A hollow ring, never the amber filled dot:
 * amber is reserved across the whole UI for `awaitingInput`, which means the session is blocked on
 * the USER. Waiting for a machine deserves to be visible without competing with that.
 */
function WaitDot(): JSX.Element {
  return (
    <span
      style={{
        width: 12, height: 12, borderRadius: '50%', flex: 'none', boxSizing: 'border-box',
        border: '1.5px solid var(--proto-muted-3)', background: 'transparent',
      }}
    />
  );
}

function Badge({ badge }: { badge: WaitRailBadge }): JSX.Element {
  const danger = badge.tone === 'danger';
  return (
    <span
      title={badge.title}
      data-wait-badge={badge.key}
      style={{
        font: `600 9.5px ${MONO}`,
        padding: '1px 6px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color: danger ? 'var(--proto-danger)' : 'var(--proto-amber)',
        background: danger ? 'var(--proto-danger-bg, transparent)' : 'transparent',
        border: `1px solid ${danger ? 'var(--proto-danger)' : 'var(--proto-amber)'}`,
      }}
    >
      {badge.text}
    </span>
  );
}

const STATUS_COLOR: Record<string, string> = {
  ok: 'var(--proto-success)',
  fail: 'var(--proto-danger)',
  progress: 'var(--proto-muted-2)',
};

interface RowProps {
  row: WaitRailRow;
  copy: WaitRailChromeCopy;
  onCancel: (row: WaitRailRow) => void;
  cancelling: boolean;
}

function WaitRow({ row, copy, onCancel, cancelling }: RowProps): JSX.Element {
  return (
    <div style={{ padding: '7px 0', borderTop: '1px solid var(--proto-line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ font: `600 11px ${MONO}`, color: 'var(--proto-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
          {row.label}
        </span>
        {row.progress && (
          <span style={{ font: `500 10px ${MONO}`, color: 'var(--proto-accent)', flex: 'none' }}>{row.progress}</span>
        )}
        {row.mailbox && (
          <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)', flex: 'none' }}>{row.mailbox}</span>
        )}
        <span style={{ marginLeft: 'auto', flex: 'none', font: `400 10px ${MONO}`, color: row.urgent ? 'var(--proto-amber)' : 'var(--proto-faint)' }}>
          {row.ttl}
        </span>
        <button
          type="button"
          data-waitpoint-cancel={row.id}
          disabled={cancelling}
          onClick={(e) => { e.stopPropagation(); onCancel(row); }}
          style={{
            flex: 'none', border: 'none', background: 'transparent', padding: '0 2px',
            font: `500 10px ${MONO}`, color: 'var(--proto-danger)',
            cursor: cancelling ? 'not-allowed' : 'pointer', opacity: cancelling ? 0.5 : 1,
          }}
        >
          {copy.cancel}
        </button>
      </div>

      {/* Agent-written, so it is shown as the explanation of why the session is waiting. */}
      <div style={{ fontSize: 11.5, color: 'var(--proto-muted-2)', marginTop: 3, lineHeight: 1.45 }}>{row.intent}</div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: row.badges.length || row.device || row.failFast ? 5 : 0 }}>
        {row.device && (
          <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>{row.device}</span>
        )}
        {row.failFast && (
          <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>fail-fast</span>
        )}
        {row.badges.map((b) => <Badge key={b.key} badge={b} />)}
      </div>

      {/* Signal log. Everything here was written by a process outside Cortex: rendered as plain
          text, never linkified, never interpreted — the same framing the wake notice uses. */}
      {row.signals.length === 0 && (
        <div style={{ font: `400 10px ${MONO}`, color: 'var(--proto-faint)', marginTop: 4 }}>{copy.noSignals}</div>
      )}
      {row.signals.length > 0 && (
        <div style={{ marginTop: 5 }}>
          <div style={{ font: `400 9px ${MONO}`, color: 'var(--proto-faint)' }}>{copy.externalNote}</div>
          {row.signals.map((s) => (
            <div key={s.key} style={{ display: 'flex', gap: 6, font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)', lineHeight: 1.6, minWidth: 0 }}>
              <span style={{ flex: 'none' }}>{s.at}</span>
              <span style={{ flex: 'none', color: STATUS_COLOR[s.status] ?? 'var(--proto-muted-3)' }}>{s.status}</span>
              {s.who && <span style={{ flex: 'none' }}>{s.who}</span>}
              <span style={{ flex: 'none', color: 'var(--proto-faint)' }}>{s.source}</span>
              {s.message && (
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.message}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface WaitRailProps {
  /** Only used to key the persisted expand/collapse state. */
  sessionId: string;
  lang: WaitRailLanguage;
  /** Armed waitpoints for this session. Fetched by the host (useSessionWaitpoints), passed in like
   *  TodoRail's `todos`: a rail that fetched for itself would drag a tRPC route into every test
   *  that mounts a composer. */
  waitpoints: WaitpointInfo[];
  onCancel: (waitpointId: string) => void;
  cancelling?: boolean;
}

/**
 * What this session is waiting on from outside Cortex — waitpoints, in the sense of
 * docs/waitpoints.md. Sits beside TodoRail above the composer and, like it, renders nothing at all
 * when there is nothing pending.
 *
 * Only armed waitpoints appear. A waitpoint that fires or expires posts its own notice into the
 * transcript, so keeping it here too would tell the same story twice.
 */
export function WaitRail({ sessionId, lang, waitpoints, onCancel, cancelling = false }: WaitRailProps): JSX.Element | null {
  const [open, toggle] = useExpanded(sessionId);
  const vm = waitRailViewModel(waitpoints, Date.now(), lang);
  if (!vm) return null;
  const copy = WAIT_RAIL_COPY[lang];

  const confirmCancel = (row: WaitRailRow): void => {
    if (cancelling) return;
    if (!globalThis.confirm(copy.confirm(row.label))) return;
    onCancel(row.id);
  };
  const collapseOnKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  };

  return (
    <div
      data-wait-rail={open ? 'expanded' : 'collapsed'}
      style={{
        border: '1px solid var(--proto-line)',
        borderRadius: 8,
        background: 'var(--proto-alt)',
        marginBottom: 8,
        overflow: 'hidden',
        animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both',
      }}
    >
      {!open && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={false}
          aria-label={copy.title}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 29,
            padding: '0 10px', background: 'transparent', border: 'none', cursor: 'pointer',
            textAlign: 'left', font: 'inherit', color: 'inherit',
          }}
        >
          <WaitDot />
          <span
            style={{
              fontSize: 12, color: 'var(--proto-muted-2)', whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
            }}
          >
            {vm.headline}
          </span>
          <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 9, color: 'var(--proto-muted-2)' }}>▸</span>
        </button>
      )}
      {open && (
        <div
          role="button"
          tabIndex={0}
          aria-expanded
          aria-label={copy.title}
          onClick={toggle}
          onKeyDown={collapseOnKeyDown}
          style={{ maxHeight: EXPANDED_MAX_HEIGHT, overflowY: 'auto', padding: '9px 12px 10px', cursor: 'pointer' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 4 }}>
            <WaitDot />
            <span style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-muted-2)' }}>{copy.title}</span>
            <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--proto-muted-2)' }}>▾</span>
          </div>
          {vm.rows.map((row) => (
            <WaitRow key={row.id} row={row} copy={copy} onCancel={confirmCancel} cancelling={cancelling} />
          ))}
          <div style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)', marginTop: 6, lineHeight: 1.5 }}>
            {copy.secretNote}
          </div>
        </div>
      )}
    </div>
  );
}
