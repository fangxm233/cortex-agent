import { useEffect, useState } from 'react';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { Button, EmptyState, IconButton, useToast } from '@/design';
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
//
// Type follows the v2 rules: labels are sentence case in the UI face, and only the command — the
// thing being approved, verbatim — is set in the code face.

const mono = "'IBM Plex Mono',monospace";
const META_TEXT: React.CSSProperties = { fontSize: 12, color: 'var(--proto-muted)', fontVariantNumeric: 'tabular-nums' };

function CloseGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" aria-hidden="true">
      <path d="m4.5 4.5 7 7m0-7-7 7" />
    </svg>
  );
}
// The empty queue's mark (prototype L1329-1335): a green tick over the title.
const ALL_CLEAR_ICON = (
  <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--proto-success-bg)', color: 'var(--proto-success)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700 }}>✓</span>
);

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
  // The displayed entry is the source of truth for the footer actions, so Approve/Reject always act
  // on what the user sees. The container already defaulted the selection to the first entry.
  const selected = entries.find((e) => e.id === selectedId) ?? null;
  const detail = selected ? toDetail(selected, L) : null;

  return (
    <>
      {/* backdrop (prototype L1292) */}
      <div
        onClick={props.onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--overlay-scrim)',
          backdropFilter: 'var(--material-scrim-filter)',
          WebkitBackdropFilter: 'var(--material-scrim-filter)',
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
          background: 'var(--material-overlay-bg)',
          backdropFilter: 'var(--glass-filter)',
          WebkitBackdropFilter: 'var(--glass-filter)',
          borderRadius: 'var(--r-float)',
          boxShadow: 'var(--material-overlay-shadow)',
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
            padding: '12px 14px 12px 20px',
            borderBottom: '1px solid var(--proto-line-2)',
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 620, color: 'var(--proto-ink)' }}>{L.approvals}</span>
          {/* the one status capsule: a hairline pill with a leading amber dot, not a filled badge */}
          {hasItems && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 28,
                boxSizing: 'border-box',
                background: 'var(--material-control-bg)',
                border: '1px solid var(--proto-line)',
                borderRadius: 'var(--r-pill)',
                padding: '0 10px',
                marginLeft: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--proto-amber)',
                }}
              />
              <span style={{ fontSize: 12, fontWeight: 550, color: 'var(--proto-ink-3)', fontVariantNumeric: 'tabular-nums' }}>
                {pendingLabel(count, L)}
              </span>
            </span>
          )}
          {/* a quiet × — Escape still closes, so the header no longer carries a keycap */}
          <IconButton label={L.cmClose} size={28} onClick={props.onClose} style={{ marginLeft: 'auto' }}>
            <CloseGlyph />
          </IconButton>
        </div>

        {/* body (prototype L1328) */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
          {!hasItems && <EmptyState className="m-auto" icon={ALL_CLEAR_ICON} title={L.aprEmptyTitle} />}
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
                  status={selected?.status ?? 'pending'}
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
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
        scrollbarGutter: 'stable',
      }}
    >
      <div
        style={{
          padding: '13px 16px 8px',
          fontSize: 12,
          fontWeight: 550,
          color: 'var(--proto-muted-3)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {L.apPending} · {count}
      </div>
      <div style={{ padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {entries.map((e) => (
          <PendingRow key={e.id} entry={e} selected={e.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

const ROW_HOVER = 'hover:[background:var(--proto-line-2)]';

function activateOnKey(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.currentTarget.click();
}

// A plain row in the rail's grammar: the 16px status column, the title, then a meta line. Selection
// is the gray tint alone; no card, border or shadow.
function PendingRow({ entry, selected, onSelect }: {
  entry: ApprovalInfo;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const card = toListCard(entry);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={selected ? focusClass : `${focusClass} ${ROW_HOVER}`}
      onKeyDown={activateOnKey}
      data-approval-id={entry.id}
      onClick={() => onSelect(entry.id)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        background: selected ? 'var(--proto-gray)' : undefined,
        borderRadius: 'var(--r-chip)',
        padding: '8px 10px 8px 6px',
        overflowWrap: 'anywhere',
        cursor: 'pointer',
      }}
    >
      <span style={{ width: 16, flex: 'none', display: 'flex', justifyContent: 'center', paddingTop: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--proto-amber)' }} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: selected ? 'var(--proto-ink)' : 'var(--proto-ink-2)', lineHeight: 1.4 }}>
          {card.title}
        </div>
        {/* meta row: tag OMITTED (no safety-class field); project = real projectId (null = global
            entry, omitted); origin = real provenance when present; age = queuedAt date */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3, flexWrap: 'wrap' }}>
          {card.project && <span style={{ ...META_TEXT, fontWeight: 550 }}>{card.project}</span>}
          {card.origin && <span style={META_TEXT}>{card.origin}</span>}
          {card.age && <span style={{ ...META_TEXT, marginLeft: 'auto' }}>{card.age}</span>}
        </div>
      </div>
    </div>
  );
}

// ── right detail pane (prototype L1353-1401) ──────────────────────────────────────────────────

const GRID_LABEL: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 550,
  color: 'var(--proto-muted)',
};

// The one set of status dots: amber = needs you (pending), green = done, red = rejected or failed.
const STATUS_DOT: Record<ApprovalInfo['status'], string> = {
  pending: 'var(--proto-amber)',
  approved: 'var(--proto-success)',
  rejected: 'var(--proto-danger)',
  failed: 'var(--proto-danger)',
};

function DetailPane({
  detail,
  status,
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
  status: ApprovalInfo['status'];
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
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', overflowWrap: 'anywhere', background: 'transparent' }}>
      <div style={{ flex: 1, overflow: 'auto', scrollbarGutter: 'stable', minHeight: 0, padding: '16px 22px 0' }}>
        {/* title + status: the status dot and its word, the same form as the header capsule's — not
            a filled badge competing with the title */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ fontSize: 15.5, fontWeight: 650, color: 'var(--proto-ink)', lineHeight: 1.35, flex: 1 }}>
            {detail.title}
          </div>
          <span
            data-approval-status=""
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
              fontWeight: 550,
              color: 'var(--proto-ink-3)',
              flex: 'none',
              marginTop: 3,
            }}
          >
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_DOT[status] }} />
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
            ...META_TEXT,
            flexWrap: 'wrap',
          }}
        >
          {detail.queued && <span>{detail.queued}</span>}
          {detail.project && (
            <span>
              {L.apProject} <span style={{ color: 'var(--proto-ink-2)', fontWeight: 550 }}>{detail.project}</span>
            </span>
          )}
          {detail.origin && (
            <span>
              {L.apFrom} <span style={{ color: 'var(--proto-ink-2)', fontWeight: 550 }}>{detail.origin}</span>
            </span>
          )}
          {detail.task && (
            <span>
              {L.apTask} <span style={{ color: 'var(--proto-ink-2)', fontFamily: mono }}>{detail.task}</span>
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
            fontSize: 13,
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
            <div style={{ ...GRID_LABEL, marginBottom: 6 }}>
              {L.apCommand}
            </div>
            <div
              style={{
                background: 'var(--proto-alt)',
                border: '1px solid var(--proto-line-2)',
                borderRadius: 'var(--r-control)',
                padding: '9px 14px',
                font: `400 12px/1.7 ${mono}`,
                color: 'var(--proto-ink-3)',
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
              background: 'var(--material-inset-bg)',
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
        <div style={{ display: 'flex', gap: 10, marginLeft: 'auto', alignItems: 'center' }}>
        {!armed && (
          <>
            <Button variant="danger-outline" data-action="arm" disabled={pending} onClick={() => onArm()}>
              {L.rejectFeedback}
            </Button>
            <Button variant="primary" data-action="approve" disabled={pending} onClick={() => onApprove(detail.id)}>
              {L.approve}
            </Button>
          </>
        )}
        {armed && (
          <>
            <Button data-action="cancel" disabled={pending} onClick={() => onCancel()}>
              {L.cancel}
            </Button>
            <Button variant="danger" data-action="reject" disabled={pending} onClick={() => onReject(detail.id)}>
              {L.denyConfirm}
            </Button>
          </>
        )}
        </div>
      </div>
    </div>
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
