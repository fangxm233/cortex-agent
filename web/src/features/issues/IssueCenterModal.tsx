import { useEffect, useMemo, useState } from 'react';
import '@/design/content-surfaces.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { IssueInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { Button, EmptyState, IconButton, useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from '@/features/session/state/SelectedSessionProvider';
import { DRAFT_SENTINEL } from '@/features/session/state/selected-session';
import { draftStorageKey, saveDraft } from '@/features/session/composer/composer-draft';
import { defaultSelectedId } from '@/features/approvals/approval-center-vm';
import { toIssueDetail, buildIssuePrompt } from './issues-vm';

// Issues modal (design sec-24 24b), isomorphic to the approval center 7a overlay: backdrop +
// centered shell, left queue + right detail. Differences BY DESIGN: no amber anywhere (issues never
// block a thread), no status pill / status column (being listed == pending), read-only content, and
// the footer actions are 删除 (danger outline, two-step confirm) / 处理 (accent solid → a NEW direct
// session carrying the issue full text; the entry leaves the list on either action).
//
// DATA GAPS (real IssueInfo vs the design mock) — honest, never fabricated:
//   • source slot (`nightly-eval › report · thr_4a1b`) — ISSUES.md has no source field → omitted.
//   • 相关文件 chips — no structured files field → omitted (paths live inside the body text).
//   • time-of-day — entries carry a date only → the date is shown, no fabricated clock.
//   • field labels — VERBATIM from the markdown sub-bullets (问题/建议/Fix/…), not the mock's
//     fixed 描述/证据/相关文件 schema.

// The empty queue's mark: a green tick over the title.
const ALL_CLEAR_ICON = (
  <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--proto-success-bg)', color: 'var(--proto-success)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700 }}>✓</span>
);

const META_TEXT: React.CSSProperties = { fontSize: 12, color: 'var(--proto-muted)', fontVariantNumeric: 'tabular-nums' };

function CloseGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" aria-hidden="true">
      <path d="m4.5 4.5 7 7m0-7-7 7" />
    </svg>
  );
}

// ── pure presentational view ──────────────────────────────────────────────────────────────────

interface IssueCenterViewProps {
  entries: IssueInfo[];
  selectedId: string | null;
  /** Delete armed (two-step confirm). */
  armed: boolean;
  pending: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  onArm: () => void;
  onCancelArm: () => void;
  onDelete: (id: string) => void;
  onHandle: (id: string) => void;
}

function IssueCenterView(props: IssueCenterViewProps) {
  const L = useVocab();
  const { entries, selectedId, armed, pending } = props;
  const count = entries.length;
  const hasItems = count > 0;
  // The displayed entry is the source of truth for the footer actions (approval-center precedent).
  const selected = entries.find((e) => e.id === selectedId) ?? null;
  const detail = selected ? toIssueDetail(selected) : null;

  return (
    <>
      {/* backdrop */}
      <div
        onClick={props.onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--overlay-scrim-soft)',
          backdropFilter: 'var(--material-scrim-filter)',
          WebkitBackdropFilter: 'var(--material-scrim-filter)',
          zIndex: 60,
          animation: 'cxfade .18s ease',
        }}
      />
      {/* shell (design 24b: 1150×730) */}
      <div
        className="content-surface issue-center"
        data-issue-center=""
        data-issue-selected={selected?.id ?? ''}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%,-50%)',
          animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
          width: 1150,
          maxWidth: '94vw',
          height: 730,
          maxHeight: '90vh',
          // Floating glass sheet, matching design/Modal and the approval centre it is a sibling of:
          // one static top-level overlay, so its blur is read once per open, not per scroll frame.
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
        {/* header (24b): title, a plain neutral count (issues never block, so no amber), and the
            same quiet × as the approval centre — Escape still closes */}
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
          <span style={{ fontSize: 16, fontWeight: 620, color: 'var(--proto-ink)' }}>{L.issuesTitle}</span>
          {hasItems && (
            <span data-issue-count="" style={{ ...META_TEXT, fontSize: 13, color: 'var(--proto-muted-3)' }}>{count}</span>
          )}
          <IconButton label={L.cmClose} size={28} onClick={props.onClose} style={{ marginLeft: 'auto' }}>
            <CloseGlyph />
          </IconButton>
        </div>

        {/* body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
          {!hasItems && <EmptyState className="m-auto" icon={ALL_CLEAR_ICON} title={L.isEmptyTitle} description={L.isEmptyDesc} />}
          {hasItems && (
            <>
              <IssueQueue
                entries={entries}
                selectedId={selected?.id ?? null}
                count={count}
                onSelect={props.onSelect}
              />
              {detail && (
                <DetailPane
                  detail={detail}
                  armed={armed}
                  pending={pending}
                  onArm={props.onArm}
                  onCancelArm={props.onCancelArm}
                  onDelete={props.onDelete}
                  onHandle={props.onHandle}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ── left queue (24b: 400px, title + date meta, no status column) ──────────────────────────────

function IssueQueue({
  entries,
  selectedId,
  count,
  onSelect,
}: {
  entries: IssueInfo[];
  selectedId: string | null;
  count: number;
  onSelect: (id: string) => void;
}) {
  const L = useVocab();
  return (
    <div
      style={{
        width: 'clamp(180px, 34%, 400px)',
        flex: 'none',
        borderRight: '1px solid var(--proto-line-2)',
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '13px 18px 8px',
          fontSize: 12,
          fontWeight: 550,
          color: 'var(--proto-muted-3)',
          fontVariantNumeric: 'tabular-nums',
          flex: 'none',
        }}
      >
        {L.isListLabel} · {count}
      </div>
      <div style={{ flex: 1, overflow: 'auto', scrollbarGutter: 'stable', minHeight: 0, padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {entries.map((e) => (
          <IssueRow key={e.id} entry={e} selected={e.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

const ROW_HOVER = 'hover:[background:var(--proto-line-2)]';

// A plain row: title over its date, selection as the gray tint (the rail's grammar). No status
// column by design — being listed is the status.
function IssueRow({ entry, selected, onSelect }: { entry: IssueInfo; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <div
      data-issue-id={entry.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={selected ? undefined : ROW_HOVER}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(entry.id); } }}
      onClick={() => onSelect(entry.id)}
      style={{
        background: selected ? 'var(--proto-gray)' : undefined,
        borderRadius: 'var(--r-chip)',
        padding: '8px 10px',
        cursor: 'pointer',
        flex: 'none',
        overflowWrap: 'anywhere',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: selected ? 'var(--proto-ink)' : 'var(--proto-ink-2)', lineHeight: 1.35 }}>
        {entry.title}
      </div>
      {entry.date && (
        <div style={{ ...META_TEXT, marginTop: 3, textAlign: 'right' }}>{entry.date}</div>
      )}
    </div>
  );
}

// ── right detail pane (24b: read-only grid, verbatim field labels) ────────────────────────────

const GRID_LABEL: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 550,
  color: 'var(--proto-muted)',
};

function DetailPane({
  detail,
  armed,
  pending,
  onArm,
  onCancelArm,
  onDelete,
  onHandle,
}: {
  detail: ReturnType<typeof toIssueDetail>;
  armed: boolean;
  pending: boolean;
  onArm: () => void;
  onCancelArm: () => void;
  onDelete: (id: string) => void;
  onHandle: (id: string) => void;
}) {
  const L = useVocab();
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'transparent' }}>
      <div style={{ flex: 1, overflow: 'auto', scrollbarGutter: 'stable', minHeight: 0, padding: '18px 24px 0' }}>
        {/* title — no status pill by design (在列表即待处理) */}
        <div style={{ fontSize: 16, fontWeight: 650, color: 'var(--proto-ink)', lineHeight: 1.35 }}>
          {detail.title}
        </div>

        {/* meta row: real date only — the design's source/thread slots have no markdown field */}
        {detail.date && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              marginTop: 8,
              ...META_TEXT,
            }}
          >
            <span>
              {L.isRecorded} {detail.date}
            </span>
          </div>
        )}

        {/* body grid — labels VERBATIM from the markdown sub-bullets */}
        <div
          style={{
            margin: '16px 0 14px',
            display: 'grid',
            gridTemplateColumns: '76px minmax(0, 1fr)',
            rowGap: 10,
            columnGap: 14,
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {detail.desc && (
            <>
              <span style={GRID_LABEL}>{L.isDescLabel}</span>
              <span style={{ color: 'var(--proto-ink-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {detail.desc}
              </span>
            </>
          )}
          {detail.fields.map((f, i) => (
            <FieldRow key={`${f.label}-${i}`} label={f.label} text={f.text} />
          ))}
        </div>
      </div>

      {/* footer (24b): note + 删除 (outline danger, two-step) / 处理 (accent solid) */}
      <div
        style={{
          flex: 'none',
          borderTop: '1px solid var(--proto-line-2)',
          padding: '14px 22px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--proto-muted)', lineHeight: 1.6, flex: 1, minWidth: 0 }}>
          {L.isFootNote}
        </span>
        {!armed && (
          <>
            <Button variant="danger-outline" data-action="arm-delete" disabled={pending} onClick={() => onArm()}>
              {L.isDelete}
            </Button>
            <Button variant="primary" data-action="handle" disabled={pending} onClick={() => onHandle(detail.id)}>
              {L.isHandle}
            </Button>
          </>
        )}
        {armed && (
          <>
            <Button data-action="cancel-delete" disabled={pending} onClick={() => onCancelArm()}>
              {L.cancel}
            </Button>
            <Button variant="danger" data-action="confirm-delete" disabled={pending} onClick={() => onDelete(detail.id)}>
              {L.isConfirmDelete}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function FieldRow({ label, text }: { label: string; text: string }) {
  return (
    <>
      <span style={GRID_LABEL}>{label}</span>
      <span style={{ color: 'var(--proto-ink-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</span>
    </>
  );
}

// ── container: binds real tRPC data + mutations ───────────────────────────────────────────────

export function IssueCenterModal({
  open,
  initialId,
  onClose,
}: {
  open: boolean;
  initialId: string | null;
  onClose: () => void;
}) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentProjectId } = useCurrentProject();
  const { setSelectedSession } = useSelectedSession();

  const listQuery = useQuery({
    ...trpc.issues.list.queryOptions({ projectId: currentProjectId ?? '' }),
    enabled: open && !!currentProjectId,
  });
  const entries = useMemo<IssueInfo[]>(() => listQuery.data ?? [], [listQuery.data]);

  const [rawSelectedId, setRawSelectedId] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const selectedId = defaultSelectedId(entries, rawSelectedId ?? initialId);

  const invalidate = () => queryClient.invalidateQueries(trpc.issues.list.queryFilter());

  const del = useMutation(
    trpc.issues.delete.mutationOptions({
      onSettled: () => {
        setArmed(false);
        invalidate();
      },
    }),
  );
  const pending = del.isPending;

  // reset transient state whenever the overlay opens/closes or the selection changes
  useEffect(() => {
    if (!open) {
      setArmed(false);
      setRawSelectedId(null);
    }
  }, [open]);
  useEffect(() => {
    setArmed(false);
  }, [selectedId]);

  // Escape closes
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
    <IssueCenterView
      entries={entries}
      selectedId={selectedId}
      armed={armed}
      pending={pending}
      onSelect={setRawSelectedId}
      onClose={onClose}
      onArm={() => setArmed(true)}
      onCancelArm={() => setArmed(false)}
      onDelete={(id) => {
        if (!currentProjectId) return;
        del.mutate({ projectId: currentProjectId, id }, {
          onSuccess: () => toast({ title: L.isToastDeleted, tone: 'done' }),
        });
      }}
      onHandle={(id) => {
        if (!currentProjectId) return;
        const entry = entries.find((e) => e.id === id);
        if (!entry) return;
        // Pre-fill the new-session draft composer with the issue prompt (editable before send).
        const prompt = buildIssuePrompt(currentProjectId, entry, L);
        const key = draftStorageKey({ isDraft: true, projectId: currentProjectId });
        saveDraft(key, { text: prompt, attachments: [] });
        // Enter draft mode + navigate (optimistic — don't wait for the delete round-trip).
        setSelectedSession(DRAFT_SENTINEL);
        onClose();
        navigate('/workbench');
        // Remove the issue entry from ISSUES.md in the background.
        del.mutate({ projectId: currentProjectId, id }, {
          onSuccess: () => toast({ title: L.isToastHandled, tone: 'done' }),
        });
      }}
    />
  );
}
