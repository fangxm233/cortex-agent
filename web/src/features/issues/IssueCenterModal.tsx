import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { IssueInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useCurrentProject } from '@/features/workbench/CurrentProjectProvider';
import { useSelectedSession } from '@/features/workbench/SelectedSessionProvider';
import { DRAFT_SENTINEL } from '@/features/workbench/selected-session';
import { draftStorageKey, saveDraft } from '@/features/workbench/composer-draft';
import { defaultSelectedId, toIssueDetail, toIssueListCard, buildIssuePrompt } from './issues-vm';

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

const mono = "'IBM Plex Mono',monospace";

// ── pure presentational view (render-testable without the tRPC provider) ──────────────────────

export interface IssueCenterViewProps {
  entries: IssueInfo[];
  selectedId: string | null;
  /** Current project id — shown in the header path label `<project>/ISSUES.md`. */
  projectId: string | null;
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

export function IssueCenterView(props: IssueCenterViewProps) {
  const L = useVocab();
  const { entries, selectedId, armed, pending } = props;
  const count = entries.length;
  const hasItems = count > 0;
  // The displayed entry is the source of truth for the footer actions (approval-center precedent).
  const selected = entries.find((e) => e.id === selectedId) ?? entries[0] ?? null;
  const detail = selected ? toIssueDetail(selected) : null;

  return (
    <>
      {/* backdrop */}
      <div
        onClick={props.onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(25,28,34,.32)',
          zIndex: 60,
          animation: 'cxfade .18s ease',
        }}
      />
      {/* shell (design 24b: 1150×730) */}
      <div
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
          background: 'var(--proto-card)',
          borderRadius: 14,
          boxShadow: '0 24px 64px rgba(16,24,40,.28)',
          zIndex: 61,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* header (24b) — neutral count pill, NOT amber (issues never block) */}
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
          <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.issuesTitle}</span>
          {hasItems && (
            <span
              style={{
                font: `600 10.5px ${mono}`,
                color: 'var(--proto-muted)',
                background: 'var(--proto-line-2)',
                padding: '2px 9px',
                borderRadius: 999,
                marginLeft: 2,
              }}
            >
              {count}
            </span>
          )}
          <span style={{ marginLeft: 'auto', font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>
            {props.projectId ? `${props.projectId}/ISSUES.md` : 'ISSUES.md'}
          </span>
          <span
            onClick={props.onClose}
            style={{
              font: `500 9.5px ${mono}`,
              color: 'var(--proto-muted-3)',
              border: '1px solid var(--proto-line)',
              borderRadius: 5,
              padding: '2px 6px',
              cursor: 'pointer',
            }}
          >
            esc
          </span>
        </div>

        {/* body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
          {!hasItems && <EmptyState />}
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

// ── empty state ───────────────────────────────────────────────────────────────────────────────

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
        background: 'var(--proto-rail)',
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
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.isEmptyTitle}</div>
      <div style={{ fontSize: 11, color: 'var(--proto-muted-2)' }}>{L.isEmptyDesc}</div>
    </div>
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
        width: 400,
        flex: 'none',
        borderRight: '1px solid var(--proto-line)',
        background: 'var(--proto-rail)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '14px 18px 9px',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '.06em',
          color: 'var(--proto-muted-3)',
          flex: 'none',
        }}
      >
        {L.isListLabel} · {count}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.map((e) => {
          const card = toIssueListCard(e);
          const sel = e.id === selectedId;
          return (
            <div
              key={e.id}
              data-issue-id={e.id}
              onClick={() => onSelect(e.id)}
              style={{
                background: 'var(--proto-card)',
                border: `1px solid ${sel ? 'var(--proto-accent-border)' : 'var(--proto-line-2)'}`,
                borderRadius: 10,
                padding: '11px 13px',
                boxShadow: sel ? '0 1px 3px rgba(70,85,212,.08)' : 'none',
                cursor: 'pointer',
                flex: 'none',
              }}
            >
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: sel ? 'var(--proto-ink)' : 'var(--proto-ink-2)',
                  lineHeight: 1.35,
                }}
              >
                {card.title}
              </div>
              {card.date && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6 }}>
                  <span style={{ marginLeft: 'auto', font: `400 9.5px ${mono}`, color: 'var(--proto-faint)' }}>
                    {card.date}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 'auto',
          padding: '12px 18px',
          borderTop: '1px solid var(--proto-line-2)',
          font: `400 9.5px ${mono}`,
          color: 'var(--proto-faint)',
          lineHeight: 1.7,
          flex: 'none',
        }}
      >
        {L.isNoStatusNote}
      </div>
    </div>
  );
}

// ── right detail pane (24b: read-only grid, verbatim field labels) ────────────────────────────

const GRID_LABEL: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '.05em',
  color: 'var(--proto-muted-3)',
  paddingTop: 2,
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
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '18px 24px 0' }}>
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
              font: `400 10.5px ${mono}`,
              color: 'var(--proto-muted-3)',
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
            gridTemplateColumns: '76px 1fr',
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
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-faint)', lineHeight: 1.6, flex: 1, minWidth: 0 }}>
          {L.isFootNote}
        </span>
        {!armed && (
          <>
            <HoverButton
              data-action="arm-delete"
              onClick={pending ? undefined : () => onArm()}
              base={{
                fontSize: 12,
                fontWeight: 600,
                border: '1px solid var(--proto-danger-bg)',
                borderRadius: 8,
                padding: '7px 16px',
                color: 'var(--proto-danger)',
                background: 'var(--proto-card)',
                cursor: pending ? 'not-allowed' : 'pointer',
                flex: 'none',
                opacity: pending ? 0.6 : 1,
              }}
              hover={{ background: 'var(--proto-danger-bg)' }}
            >
              {L.isDelete}
            </HoverButton>
            <HoverButton
              data-action="handle"
              onClick={pending ? undefined : () => onHandle(detail.id)}
              base={{
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 8,
                padding: '8px 22px',
                color: 'var(--ink-solid-fg)',
                background: 'var(--proto-accent)',
                cursor: pending ? 'not-allowed' : 'pointer',
                flex: 'none',
                opacity: pending ? 0.6 : 1,
              }}
              hover={{ background: 'var(--proto-accent-strong)' }}
            >
              {L.isHandle}
            </HoverButton>
          </>
        )}
        {armed && (
          <>
            <HoverButton
              data-action="cancel-delete"
              onClick={pending ? undefined : () => onCancelArm()}
              base={{
                fontSize: 12,
                fontWeight: 600,
                border: '1px solid var(--proto-line-3)',
                borderRadius: 8,
                padding: '7px 16px',
                color: 'var(--proto-ink)',
                background: 'var(--proto-card)',
                cursor: pending ? 'not-allowed' : 'pointer',
                flex: 'none',
                opacity: pending ? 0.6 : 1,
              }}
              hover={{ background: 'var(--proto-alt)' }}
            >
              {L.cancel}
            </HoverButton>
            <HoverButton
              data-action="confirm-delete"
              onClick={pending ? undefined : () => onDelete(detail.id)}
              base={{
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 8,
                padding: '8px 20px',
                color: 'var(--ink-solid-fg)',
                background: 'var(--proto-danger)',
                cursor: pending ? 'not-allowed' : 'pointer',
                flex: 'none',
                opacity: pending ? 0.6 : 1,
              }}
              hover={{ opacity: 0.88 }}
            >
              {L.isConfirmDelete}
            </HoverButton>
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
    <span
      {...rest}
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={h ? { ...base, ...hover } : base}
    >
      {children}
    </span>
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
      projectId={currentProjectId}
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
        const prompt = buildIssuePrompt(currentProjectId, entry);
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
