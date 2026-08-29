// input:  a CommissionInfo, its ledger/contract text, projected decisions and gate sessions
// output: the near-full-screen commission board with close actions
// pos:    Presentational body of the commission board overlay (DR-0037)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useState } from 'react';
import type { CommissionDecisionEntry, CommissionInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { Modal } from '@/design/Modal';
import { useVocab } from '@/i18n';
import { MarkdownView } from '@/features/memory/MarkdownView';
import { fetchCommissionAssetObjectUrl } from '@/lib/files';
import { DecisionCardGroup } from '@/features/workbench/DecisionCards';

const mono = "'IBM Plex Mono',monospace";

// The board answers three questions in one surface: what did we agree to (contract), what has
// happened since (ledger), and what is waiting on me (gates + decisions). It carries NO session
// list — sessions belong to the rail; duplicating them here would make the board a second
// navigation tree competing with the one that already works.

export type BoardPane = 'ledger' | 'contract';

function StatusPill({ status }: { status: CommissionInfo['status'] }): JSX.Element {
  const L = useVocab();
  const label =
    status === 'active' ? L.wbCommissionActive
      : status === 'done' ? L.wbCommissionDone
        : L.wbCommissionAbandoned;
  const color = status === 'active' ? 'var(--proto-accent)' : 'var(--proto-muted-2)';
  const bg = status === 'active' ? 'var(--proto-accent-bg)' : 'var(--proto-gray)';
  return (
    <span style={{ font: `500 9.5px ${mono}`, color, background: bg, borderRadius: 5, padding: '2px 6px', flex: 'none' }}>
      {label}
    </span>
  );
}

function PaneTab({ active, label, onClick }: {
  active: boolean;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 0,
        borderRadius: 6,
        padding: '3px 9px',
        cursor: 'pointer',
        fontSize: 11.5,
        fontWeight: active ? 600 : 400,
        background: active ? 'var(--proto-card)' : 'transparent',
        color: active ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
        boxShadow: active ? 'var(--shadow-raised, none)' : 'none',
      }}
    >
      {label}
    </button>
  );
}

function ActionButton({ label, tone, disabled, onClick }: {
  label: string;
  tone: 'neutral' | 'danger';
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: '1px solid var(--proto-line-2)',
        borderRadius: 7,
        padding: '4px 11px',
        fontSize: 12,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        background: hover && !disabled ? 'var(--proto-gray)' : 'transparent',
        color: tone === 'danger' ? 'var(--proto-amber)' : 'var(--proto-ink-2)',
      }}
    >
      {label}
    </button>
  );
}

export interface CommissionBoardModalProps {
  commission: CommissionInfo;
  /** Ledger markdown; null while loading or when the file does not exist yet. */
  ledger: string | null;
  /** Contract markdown; null while loading or when the file does not exist yet. */
  contract: string | null;
  decisions: CommissionDecisionEntry[];
  /** Member sessions currently blocked on the user. */
  gates: SessionInfo[];
  pending: boolean;
  onOpenSession: (session: SessionInfo) => void;
  onClose: (status: 'done' | 'abandoned', note: string) => void;
  onDismiss: () => void;
}

export function CommissionBoardModal(props: CommissionBoardModalProps): JSX.Element {
  const L = useVocab();
  const { projectId, slug } = props.commission;
  // Ledger images live in the commission's own `assets/`, so a relative reference is resolved
  // against that directory and fetched through the authenticated asset route. An absolute URL is
  // left alone — the agent may legitimately cite a remote image.
  const resolveImage = useCallback(
    (src: string) => {
      if (/^[a-z]+:\/\//i.test(src) || src.startsWith('data:')) return Promise.resolve(src);
      const clean = src.replace(/^\.\//, '');
      const path = clean.startsWith('commissions/') ? clean : `commissions/${slug}/${clean}`;
      return fetchCommissionAssetObjectUrl(projectId, path);
    },
    [projectId, slug],
  );
  const [pane, setPane] = useState<BoardPane>('ledger');
  // Completing or abandoning a commission is the one irreversible act on this surface, so it goes
  // through an inline confirm strip rather than a bare button — and the strip carries the closing
  // note, because "why did this stop" is the fact the ledger cannot reconstruct later.
  const [confirming, setConfirming] = useState<'done' | 'abandoned' | null>(null);
  const [note, setNote] = useState('');

  const { commission } = props;
  const open = commission.status === 'active';
  const text = pane === 'ledger' ? props.ledger : props.contract;
  const emptyText = pane === 'ledger' ? L.wbCommissionNoLedger : L.wbCommissionMissing;

  return (
    <Modal
      chrome="bare"
      size="custom"
      open={true}
      showClose={false}
      title={commission.title}
      description={commission.slug}
      onOpenChange={(next) => { if (!next) props.onDismiss(); }}
      contentDataAttributes={{ 'data-modal': 'commission-board' }}
      overlayDataAttributes={{ 'data-backdrop': 'commission-board' }}
      bodyStyle={{ display: 'contents' }}
      contentStyle={{
        position: 'fixed',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%,-50%)',
        width: 1120,
        maxWidth: '94vw',
        height: 700,
        maxHeight: '90vh',
        background: 'var(--proto-card)',
        borderRadius: 14,
        boxShadow: 'var(--shadow-overlay-strong)',
        zIndex: 61,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '15px 18px 12px', borderBottom: '1px solid var(--proto-line)', flex: 'none' }}>
        <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="var(--proto-accent)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" style={{ flex: 'none' }}>
          <path d="M3.7 1.9v10.2" />
          <path d="M3.7 2.7h6.8L9.1 5l1.4 2.3H3.7z" />
        </svg>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--proto-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {commission.title}
          </div>
          <div style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)', marginTop: 2 }}>
            {commission.slug}
          </div>
        </div>
        <StatusPill status={commission.status} />
        {open && (
          <>
            <ActionButton
              label={L.wbCommissionComplete}
              tone="neutral"
              disabled={props.pending}
              onClick={() => { setConfirming('done'); setNote(''); }}
            />
            <ActionButton
              label={L.wbCommissionAbandon}
              tone="danger"
              disabled={props.pending}
              onClick={() => { setConfirming('abandoned'); setNote(''); }}
            />
          </>
        )}
      </div>

      {confirming && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 18px', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-rail)', flex: 'none' }}>
          <span style={{ fontSize: 12.5, color: 'var(--proto-ink-2)', flex: 'none' }}>
            {confirming === 'done' ? L.wbCommissionCompleteTitle : L.wbCommissionAbandonTitle}
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={L.wbCommissionCloseNote}
            style={{
              flex: 1,
              minWidth: 0,
              height: 26,
              padding: '0 8px',
              borderRadius: 6,
              border: '1px solid var(--proto-line-2)',
              background: 'var(--proto-card)',
              color: 'var(--proto-ink)',
              fontSize: 12,
            }}
          />
          <ActionButton
            label={confirming === 'done' ? L.wbCommissionComplete : L.wbCommissionAbandon}
            tone={confirming === 'done' ? 'neutral' : 'danger'}
            disabled={props.pending}
            onClick={() => props.onClose(confirming, note.trim())}
          />
          <ActionButton label={L.cancel} tone="neutral" onClick={() => setConfirming(null)} />
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--proto-line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '9px 16px', flex: 'none', borderBottom: '1px solid var(--proto-line)' }}>
            <div style={{ display: 'flex', gap: 2, background: 'var(--proto-gray)', borderRadius: 7, padding: 2 }}>
              <PaneTab active={pane === 'ledger'} label={L.wbCommissionLedger} onClick={() => setPane('ledger')} />
              <PaneTab active={pane === 'contract'} label={L.wbCommissionContract} onClick={() => setPane('contract')} />
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 18px 24px' }}>
            {text ? (
              <MarkdownView content={text} resolveImage={resolveImage} />
            ) : (
              <div style={{ color: 'var(--proto-faint)', fontSize: 12.5, padding: '18px 0' }}>{emptyText}</div>
            )}
          </div>
        </div>

        <div style={{ width: 380, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '11px 16px 8px', flex: 'none', borderBottom: '1px solid var(--proto-line)' }}>
            <div style={{ font: `600 10px ${mono}`, color: 'var(--proto-muted-2)', letterSpacing: 0.4 }}>
              {L.wbCommissionGates}
            </div>
            {props.gates.length === 0 ? (
              <div style={{ color: 'var(--proto-faint)', fontSize: 12, marginTop: 6 }}>{L.wbCommissionNoGates}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                {props.gates.map((s) => (
                  <div
                    key={s.sessionId}
                    onClick={() => props.onOpenSession(s)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                      padding: '5px 7px', borderRadius: 6, fontSize: 12.5,
                      background: 'var(--proto-amber-bg, var(--proto-gray))', color: 'var(--proto-ink)',
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-amber)', flex: 'none' }} />
                    <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.label ?? s.name ?? s.sessionId}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '11px 16px 20px' }}>
            <div style={{ font: `600 10px ${mono}`, color: 'var(--proto-muted-2)', letterSpacing: 0.4 }}>
              {L.wbCommissionDecisions}
            </div>
            {props.decisions.length === 0 ? (
              <div style={{ color: 'var(--proto-faint)', fontSize: 12, marginTop: 6 }}>{L.wbCommissionNoDecisions}</div>
            ) : (
              // Read-only on purpose: no sessionId is passed, so the cards render without their
              // approve/revise controls. The board is a record; acting on a decision happens in the
              // session that raised it.
              <DecisionCardGroup decisions={props.decisions.map((d) => d.item)} />
            )}
          </div>
        </div>
      </div>

      {commission.closeNote && (
        <div style={{ flex: 'none', padding: '8px 18px', borderTop: '1px solid var(--proto-line)', fontSize: 12, color: 'var(--proto-muted)' }}>
          <span style={{ color: 'var(--proto-muted-3)' }}>{L.wbCommissionClosedNote}: </span>
          {commission.closeNote}
        </div>
      )}
    </Modal>
  );
}
