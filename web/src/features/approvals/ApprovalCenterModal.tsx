// input:  ApprovalInfo, approval queue, vocabulary, toast
// output: ApprovalCenterModal
// pos:    Pending approval list and decision detail overlay
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useEffect, useState } from 'react';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import {
  defaultSelectedId,
  pendingLabel,
  toDetail,
  toListCard,
} from './approval-center-vm';
import { useApprovalQueue } from './useApprovalQueue';

// Approval center overlay (screen 7a), rebuilt 1:1 from prototype.dc.html L1317-1405 (+ shared
// backdrop L1292). Exact inline styles / px / hex / font-size / weight / EN copy from the source;
// real tRPC `approvals.list` data substituted into the structure (see approval-center-vm.ts).
// Approve → approvals.approve, Reject-feedback → approvals.reject({id,feedback}); a decision flips
// the target entry's Status line in PENDING_APPROVALS.md and the list re-invalidates → live refresh.
//
// DATA GAPS rendered structurally + flagged (workbench precedent). §12 C item 13 verified the real
// source of the origin/task/ttl slots against BOTH writers (need-approval skill + approval-gate
// builder) and the live queue:
//   • origin / from (left card + meta) — REAL when present via the optional `provenance` bullet
//     (verbatim), honest-omit when absent. Not fabricated.
//   • task (meta row)                  — REAL when present: `taskRef` (4-hex, parseTaskRef) parsed
//     from `provenance`; honest-omit when absent.
//   • ttl (meta row)                   — ZERO source: the markdown queue has no expiry concept (the
//     30-min hook-bridge plan TTL is a different channel). Stays OMITTED, never fabricated.
//   • tag (safety-class pill)          — no safety-class field → omitted.
//   • ESTIMATE cost table              — no cost data; the mono block shows the real COMMAND instead.
//   • Why-approval note                — no rationale field.
// queuedAt has date-only (no clock), so the "age" and "queued" slots show the date.

const mono = "'IBM Plex Mono',monospace";
const focusClass = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent';

// ── pure presentational view ──────────────────────────────────────────────────────────────────

interface ApprovalCenterViewProps {
  /** Pending entries (status === 'pending'). */
  entries: ApprovalInfo[];
  selectedId: string | null;
  armed: boolean;
  feedback: string;
  pending: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  onArm: () => void;
  onCancel: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onFeedback: (value: string) => void;
}

function ApprovalCenterView(props: ApprovalCenterViewProps) {
  const L = useVocab();
  const { entries, selectedId, armed, feedback, pending } = props;
  const count = entries.length;
  const hasItems = count > 0;
  // The displayed entry is the source of truth for the footer actions: fall back to the first entry
  // so Approve/Reject always act on what the user sees (never a stale/null container selection).
  const selected = entries.find((e) => e.id === selectedId) ?? entries[0] ?? null;
  const detail = selected ? toDetail(selected) : null;

  return (
    <>
      {/* backdrop (prototype L1292) */}
      <div
        onClick={props.onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--overlay-scrim)',
          zIndex: 60,
          animation: 'cxfade .18s ease',
        }}
      />
      {/* shell (prototype L1319) */}
      <div
        data-approval-center=""
        role="dialog"
        aria-label={L.approvals}
        data-approval-selected={selected?.id ?? ''}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%,-50%)',
          animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
          width: 1120,
          maxWidth: '94vw',
          height: 700,
          maxHeight: '90vh',
          // Floating glass sheet, matching design/Modal: this hand-rolled overlay is a top-level
          // floating sheet, which is the one shape `backdrop-filter` is affordable on — it holds
          // still while its two columns scroll inside it, so the backdrop is read once per open.
          background: 'var(--glass-2)',
          backdropFilter: 'var(--glass-filter)',
          WebkitBackdropFilter: 'var(--glass-filter)',
          borderRadius: 'var(--r-float)',
          boxShadow: 'var(--shadow-float)',
          zIndex: 61,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* header (prototype L1320-1327) */}
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '12px 20px',
            borderBottom: '1px solid var(--proto-line)',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.approvals}</span>
          {hasItems && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'var(--proto-amber-bg)',
                border: '1px solid var(--proto-amber-border)',
                borderRadius: 'var(--r-pill)',
                padding: '3px 10px',
                marginLeft: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--proto-amber)',
                  animation: 'cxpulse 2s ease-in-out infinite',
                }}
              />
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-amber-fg)'  }}>
                {pendingLabel(count)}
              </span>
            </span>
          )}
          <span
            style={{ marginLeft: 'auto', minWidth: 0, overflowWrap: 'anywhere', font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}
          >
            ~/.cortex/context/PENDING_APPROVALS.md
          </span>
          <button
            type="button"
            className={focusClass}
            aria-label="Close"
            onClick={props.onClose}
            style={{
              font: `500 11px ${mono}`,
              color: 'var(--proto-muted)',
              border: '1px solid var(--proto-line)',
              borderRadius: 'var(--r-chip)',
              padding: '5px 8px',
              flex: 'none',
              cursor: 'pointer',
            }}
          >
            esc
          </button>
        </div>

        {/* body (prototype L1328) */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
          {!hasItems && <EmptyState />}
          {hasItems && (
            <>
              <PendingList
                entries={entries}
                selectedId={selected?.id ?? null}
                count={count}
                onSelect={props.onSelect}
              />
              {detail && (
                <DetailPane
                  detail={detail}
                  armed={armed}
                  feedback={feedback}
                  pending={pending}
                  onArm={props.onArm}
                  onCancel={props.onCancel}
                  onApprove={props.onApprove}
                  onReject={props.onReject}
                  onFeedback={props.onFeedback}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ── empty state (prototype L1329-1335) ────────────────────────────────────────────────────────

function EmptyState() {
  const L = useVocab();
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 9,
        background: 'var(--proto-card)',
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          background: 'var(--proto-success-bg)',
          color: 'var(--proto-success)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 15,
          fontWeight: 700,
        }}
      >
        ✓
      </span>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.aprEmptyTitle}</div>
      <div style={{ fontSize: 12, color: 'var(--proto-muted)'  }}>
        {L.aprEmptyDesc}
      </div>
    </div>
  );
}

// ── left pending list (prototype L1337-1352) ──────────────────────────────────────────────────

function PendingList({
  entries,
  selectedId,
  count,
  onSelect,
}: {
  entries: ApprovalInfo[];
  selectedId: string | null;
  count: number;
  onSelect: (id: string) => void;
}) {
  const L = useVocab();
  return (
    <div
      style={{
        width: 370,
        flex: 'none',
        borderRight: '1px solid var(--proto-line)',
        background: 'var(--proto-alt)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
      }}
    >
      <div
        style={{
          padding: '13px 16px 8px',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '.02em',
          color: 'var(--proto-muted)',
        }}
      >
        {L.apPending} · {count}
      </div>
      <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.map((e) => {
          const card = toListCard(e);
          const sel = e.id === selectedId;
          return (
            <div
              key={e.id}
              role="button"
              tabIndex={0}
              aria-pressed={sel}
              className={focusClass}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.currentTarget.click();
              }}
              data-approval-id={e.id}
              onClick={() => onSelect(e.id)}
              style={{
                background: sel ? 'var(--proto-accent-bg)' : 'var(--proto-card)',
                border: `1px solid ${sel ? 'var(--proto-accent)' : 'var(--proto-line-2)'}`,
                borderRadius: 'var(--r-card)',
                padding: '10px 12px',
                overflowWrap: 'anywhere',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--proto-amber)',
                    flex: 'none',
                    marginTop: 5,
                    animation: sel ? 'cxpulse 2s ease-in-out infinite' : 'none',
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: sel ? 'var(--proto-ink)' : 'var(--proto-ink-2)',
                      lineHeight: 1.4,
                    }}
                  >
                    {card.title}
                  </div>
                  {/* meta row: tag OMITTED (no safety-class field); project = real projectId chip
                      (null = global entry, omitted); origin = real provenance when present; age =
                      queuedAt date */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      marginTop: 6,
                      flexWrap: 'wrap',
                    }}
                  >
                    {card.project && (
                      <span style={{ font: `600 11px ${mono}`, color: 'var(--proto-muted)'  }}>{card.project}</span>
                    )}
                    {card.origin && (
                      <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)'  }}>{card.origin}</span>
                    )}
                    {card.age && (
                      <span style={{ marginLeft: 'auto', font: `400 11px ${mono}`, color: 'var(--proto-muted)'  }}>
                        {card.age}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── right detail pane (prototype L1353-1401) ──────────────────────────────────────────────────

const GRID_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.02em',
  color: 'var(--proto-muted)',
  paddingTop: 2,
};

function DetailPane({
  detail,
  armed,
  feedback,
  pending,
  onArm,
  onCancel,
  onApprove,
  onReject,
  onFeedback,
}: {
  detail: ReturnType<typeof toDetail>;
  armed: boolean;
  feedback: string;
  pending: boolean;
  onArm: () => void;
  onCancel: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onFeedback: (value: string) => void;
}) {
  const L = useVocab();
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', overflowWrap: 'anywhere', background: 'var(--proto-card)' }}>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '16px 22px 0' }}>
        {/* title + status pill */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ fontSize: 15.5, fontWeight: 650, color: 'var(--proto-ink)', lineHeight: 1.35, flex: 1 }}>
            {detail.title}
          </div>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 9px',
              borderRadius: 'var(--r-pill)',
              background: detail.pill.bg,
              color: detail.pill.fg,
              flex: 'none',
              marginTop: 2,
            }}
          >
            {detail.pill.text}
          </span>
        </div>

        {/* meta row: queued = queuedAt date; project = real projectId (null = global, omitted);
            from = real provenance; task = parsed taskRef; ttl OMITTED (zero source — no expiry in
            the markdown queue), never fabricated */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            marginTop: 8,
            font: `400 11px ${mono}`,
            color: 'var(--proto-muted)',
            flexWrap: 'wrap',
          }}
        >
          {detail.queued && <span>{detail.queued}</span>}
          {detail.project && (
            <span>
              {L.apProject} <span style={{ color: 'var(--proto-accent)' }}>{detail.project}</span>
            </span>
          )}
          {detail.origin && (
            <span>
              {L.apFrom} <span style={{ color: 'var(--proto-accent)' }}>{detail.origin}</span>
            </span>
          )}
          {detail.task && (
            <span>
              {L.apTask} <span style={{ color: 'var(--proto-accent)' }}>{detail.task}</span>
            </span>
          )}
        </div>

        {/* OPERATION / REASON / IMPACT grid */}
        <div
          style={{
            marginTop: 14,
            display: 'grid',
            gridTemplateColumns: '76px minmax(0, 1fr)' ,
            rowGap: 9,
            columnGap: 14,
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          <span style={GRID_LABEL}>{L.apOperation}</span>
          <span style={{ color: 'var(--proto-ink-2)' }}>{detail.operation}</span>
          <span style={GRID_LABEL}>{L.apReason}</span>
          <span style={{ color: 'var(--proto-ink-2)' }}>{detail.reason}</span>
          <span style={GRID_LABEL}>{L.apImpact}</span>
          <span style={{ color: 'var(--proto-ink-2)' }}>{detail.impact}</span>
        </div>

        {/* COMMAND mono block (real command; prototype's ESTIMATE cost table has no real data) */}
        {detail.hasCommand && (
          <div style={{ marginTop: 13 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '.02em',
                color: 'var(--proto-muted)',
                marginBottom: 6,
              }}
            >
              {L.apCommand}
            </div>
            <div
              style={{
                background: 'var(--proto-alt)',
                border: '1px solid var(--proto-line-2)',
                borderRadius: 'var(--r-control)',
                padding: '9px 14px',
                font: `400 11px/1.75 ${mono}`,
                color: 'var(--proto-muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {detail.command}
            </div>
          </div>
        )}

        {/* feedback echo for a resolved rejected entry (Why-approval note has no real field) */}
        {detail.feedback && (
          <div
            style={{
              margin: '13px 0 14px',
              background: 'var(--proto-danger-bg)',
              border: '1px solid var(--proto-danger-bg)',
              borderRadius: 'var(--r-control)',
              padding: '10px 13px',
              fontSize: 11.5,
              lineHeight: 1.55,
              color: 'var(--proto-danger)',
            }}
          >
            <b style={{ color: 'var(--proto-danger)' }}>{L.apFeedbackLabel}</b> — {detail.feedback}
          </div>
        )}
      </div>

      {/* deny-armed feedback input (prototype L1383-1389) */}
      {armed && (
        <div style={{ flex: 'none', padding: '0 22px 11px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid var(--proto-danger)',
              // Opaque: a field you type into is the canonical occluding surface.
              background: 'var(--proto-card)',
              borderRadius: 'var(--r-control)',
              padding: '7px 12px',
            }}
          >
            <input
              className={focusClass}
              aria-label={L.apFeedbackPh}
              data-approval-feedback=""
              value={feedback}
              onChange={(e) => onFeedback(e.target.value)}
              placeholder={L.apFeedbackPh}
              style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--proto-ink)', fontFamily: 'inherit' }}
            />
          </div>
        </div>
      )}

      {/* footer (prototype L1390-1400) */}
      <div
        style={{
          flex: 'none',
          borderTop: '1px solid var(--proto-line-2)',
          padding: '12px 22px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)', lineHeight: 1.6, flex: '1 1 120px'  }}>
          {L.apFootNote}
        </span>
        {!armed && (
          <>
            <HoverButton
              data-action="arm"
              onClick={pending ? undefined : () => onArm()}
              base={{
                marginLeft: 'auto',
                fontSize: 12,
                fontWeight: 600,
                border: '1px solid var(--proto-danger-bg)',
                borderRadius: 'var(--r-control)',
                padding: '7px 16px',
                color: 'var(--proto-danger)',
                background: 'var(--glass-2)',
                cursor: pending ? 'not-allowed' : 'pointer',
                flex: 'none',
                opacity: pending ? 0.6 : 1,
              }}
              hover={{ background: 'var(--proto-danger-bg)' }}
            >
              {L.rejectFeedback}
            </HoverButton>
            <HoverButton
              data-action="approve"
              onClick={pending ? undefined : () => onApprove(detail.id)}
              base={{
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 'var(--r-control)',
                padding: '8px 20px',
                color: 'var(--ink-solid-fg)',
                background: 'var(--proto-accent)',
                cursor: pending ? 'not-allowed' : 'pointer',
                flex: 'none',
                opacity: pending ? 0.6 : 1,
              }}
              hover={{ background: 'var(--proto-accent-strong)' }}
            >
              {L.approve}
            </HoverButton>
          </>
        )}
        {armed && (
          <>
            <HoverButton
              data-action="cancel"
              onClick={pending ? undefined : () => onCancel()}
              base={{
                marginLeft: 'auto',
                fontSize: 12,
                fontWeight: 600,
                border: '1px solid var(--proto-line-3)',
                borderRadius: 'var(--r-control)',
                padding: '7px 16px',
                color: 'var(--proto-ink)',
                background: 'var(--glass-2)',
                cursor: pending ? 'not-allowed' : 'pointer',
                flex: 'none',
                opacity: pending ? 0.6 : 1,
              }}
              hover={{ background: 'var(--proto-alt)' }}
            >
              {L.cancel}
            </HoverButton>
            <HoverButton
              data-action="reject"
              onClick={pending ? undefined : () => onReject(detail.id)}
              base={{
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 'var(--r-control)',
                padding: '8px 20px',
                color: 'var(--ink-solid-fg)',
                background: 'var(--proto-danger)',
                cursor: pending ? 'not-allowed' : 'pointer',
                flex: 'none',
                opacity: pending ? 0.6 : 1,
              }}
              hover={{ opacity: 0.88 }}
            >
              {L.denyConfirm}
            </HoverButton>
          </>
        )}
      </div>
    </div>
  );
}

function HoverButton({
  base,
  hover,
  onClick,
  children,
  ...rest
}: {
  base: React.CSSProperties;
  hover: React.CSSProperties;
  onClick?: () => void;
  children: React.ReactNode;
} & Record<string, unknown>) {
  const [h, setH] = useState(false);
  return (
    <button
      {...rest}
      type="button"
      className={focusClass}
      disabled={!onClick}
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{ ...base, ...(h && onClick ? hover : {}), opacity: 1,
        ...(!onClick ? { background: 'var(--proto-gray)', color: 'var(--proto-muted)' } : {}) }}
    >
      {children}
    </button>
  );
}

// ── container: adapts the shared queue to desktop-only interaction and feedback ───────────────

export function ApprovalCenterModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const L = useVocab();
  const { toast } = useToast();
  const queue = useApprovalQueue({ enabled: open });

  const [rawSelectedId, setRawSelectedId] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [feedback, setFeedback] = useState('');
  const selectedId = defaultSelectedId(queue.entries, rawSelectedId);

  const resetDeny = () => {
    setArmed(false);
    setFeedback('');
  };
  const approve = (id: string) => {
    void queue.approve(id)
      .then(() => toast({ title: L.apToastApproved, tone: 'done' }), () => undefined)
      .finally(resetDeny);
  };
  const reject = (id: string) => {
    void queue.reject(id, feedback)
      .then(() => toast({ title: L.apToastRejected, tone: 'failed' }), () => undefined)
      .finally(resetDeny);
  };

  // reset transient deny state whenever the overlay opens/closes or the selection changes
  useEffect(() => {
    if (!open) resetDeny();
  }, [open]);
  useEffect(() => {
    resetDeny();
  }, [selectedId]);

  // Escape closes (prototype esc chip + keyboard)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <ApprovalCenterView
      entries={queue.entries}
      selectedId={selectedId}
      armed={armed}
      feedback={feedback}
      pending={queue.isPending}
      onSelect={setRawSelectedId}
      onClose={onClose}
      onArm={() => setArmed(true)}
      onCancel={resetDeny}
      onApprove={approve}
      onReject={reject}
      onFeedback={setFeedback}
    />
  );
}
