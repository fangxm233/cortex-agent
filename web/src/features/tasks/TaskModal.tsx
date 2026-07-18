import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { buildTaskModalVm } from './task-modal-vm';
import { buildTaskVerificationVm, type TaskVerificationVm } from './task-verification-vm';

// Task detail modal (screen 10a), rebuilt 1:1 from prototype.dc.html L1462-1540 (+ shared backdrop
// L1292). Exact inline styles / px / hex / font-size / weight / EN copy from the source; real tRPC
// `tasks.list` data substituted into the structure (see task-modal-vm.ts). Backdrop / esc-chip /
// Escape-key all close. Complete → tasks.complete, Unblock → tasks.unblock (owned by TasksPanel).
//
// REAL centerpiece: WHY + DONE-WHEN in Card A now bind the real `TaskInfo.why` / `TaskInfo.doneWhen`
// (task store `why` / `done-when`); when a task genuinely has neither, the honest placeholder shows
// (null-safe — no fabrication).
// Card C (Dispatch history) consumes the REAL `tasks.verification` scope: the per-task
// execution/dispatch join. Where the scope returns [] (never dispatched) the card shows an honest
// placeholder — never fabricated evidence.
// DATA GAP still flagged:
//   • GAP-GPU          : no gpu on TaskInfo → Fields gpu renders "—" (matches the T-046 proto-shot).

const CARD: React.CSSProperties = {
  background: 'var(--proto-card)',
  border: '1px solid var(--proto-line)',
  borderRadius: 10,
  boxShadow: '0 1px 2px rgba(16,24,40,.03)',
};

const CARD_HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '10px 15px',
  borderBottom: '1px solid var(--proto-line-2)',
};

const CARD_TITLE: React.CSSProperties = { fontSize: 11.5, fontWeight: 650, color: 'var(--proto-ink)' };

// A muted note flagging a field with no real value (task not completed / never dispatched, etc.).
function GapNote({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontStyle: 'italic', color: 'var(--proto-faint)' }}>{children}</span>
  );
}

// Card C body — real per-task execution/dispatch rows (newest first).
function DispatchHistoryBody({ vv }: { vv: TaskVerificationVm }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {vv.dispatches.map((d) => (
        <div
          key={d.executionId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 9px',
            background: d.isCompleting ? 'var(--proto-accent-bg)' : 'var(--proto-rail)',
            border: `1px solid ${d.isCompleting ? 'var(--proto-accent-bg)' : 'var(--proto-line-2)'}`,
            borderRadius: 7,
          }}
        >
          <span
            style={{ width: 6, height: 6, borderRadius: '50%', background: d.statusColor, flex: 'none' }}
          />
          <span style={{ font: "600 10px 'IBM Plex Mono',monospace", color: 'var(--proto-accent)' }}>
            {d.executionId}
          </span>
          <span style={{ fontSize: 9.5, color: 'var(--proto-muted-2)' }}>{d.machine}</span>
          <span
            style={{
              marginLeft: 'auto',
              font: "400 9px 'IBM Plex Mono',monospace",
              color: 'var(--proto-muted-3)',
              flex: 'none',
            }}
          >
            {d.when} · {d.duration} · {d.cost}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface TaskModalProps {
  task: TaskInfo;
  allTasks: TaskInfo[];
  pending: boolean;
  onClose: () => void;
  onComplete: (task: TaskInfo) => void;
  onUnblock: (task: TaskInfo) => void;
}

export function TaskModal({ task, allTasks, pending, onClose, onComplete, onUnblock }: TaskModalProps) {
  const L = useVocab();
  const tm = buildTaskModalVm(task, allTasks);
  const trpc = useTRPC();
  // The modal mounts only when a task is opened, so this per-task query fires on open only.
  const verifyQuery = useQuery(
    trpc.tasks.verification.queryOptions({ projectId: task.project, taskId: task.id }),
  );
  const vv: TaskVerificationVm | null = verifyQuery.data
    ? buildTaskVerificationVm(verifyQuery.data)
    : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      {/* backdrop (prototype L1292) */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(25,28,34,.34)',
          zIndex: 60,
          animation: 'cxfade .18s ease',
        }}
      />
      {/* shell (prototype L1464) */}
      <div
        data-task-modal-id={task.id}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%,-50%)',
          animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
          width: 760,
          maxHeight: '84vh',
          background: 'var(--proto-alt)',
          borderRadius: 14,
          boxShadow: '0 24px 64px rgba(16,24,40,.3)',
          zIndex: 61,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* header (prototype L1465-1470) */}
        <div
          style={{
            flex: 'none',
            background: 'var(--proto-card)',
            borderBottom: '1px solid var(--proto-line)',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '12px 18px',
          }}
        >
          <span style={{ font: "600 12.5px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)' }}>
            {tm.id}
          </span>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              padding: '1.5px 8px',
              borderRadius: 999,
              background: tm.pill.bg,
              color: tm.pill.fg,
            }}
          >
            {tm.pill.text}
          </span>
          <span
            style={{ font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)', marginLeft: 4 }}
          >
            TASKS.yaml
          </span>
          <span
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              font: "500 9.5px 'IBM Plex Mono',monospace",
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

        {/* body grid (prototype L1471) */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            minHeight: 0,
            padding: '14px 18px',
            display: 'grid',
            gridTemplateColumns: '1.5fr 1fr',
            gap: 12,
            alignContent: 'start',
          }}
        >
          {/* LEFT column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            {/* Card A — title / WHY / DONE-WHEN (prototype L1473-1482) */}
            <div style={{ ...CARD, padding: '13px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: tm.priColor,
                    flex: 'none',
                    marginTop: 5,
                  }}
                />
                <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--proto-ink)', lineHeight: 1.4 }}>
                  {tm.title}
                </div>
              </div>
              <div style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--proto-muted)', marginTop: 7 }}>
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: '.05em',
                    color: 'var(--proto-muted-3)',
                    marginRight: 7,
                  }}
                >
                  {L.tkWhy}
                </span>
                {task.why != null ? (
                  <span>{task.why}</span>
                ) : (
                  <GapNote>— {L.tkNoWhy}</GapNote>
                )}
              </div>
              <div
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: '.05em',
                  color: 'var(--proto-muted-3)',
                  margin: '11px 0 5px',
                }}
              >
                {L.tkDoneWhen}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {/* Real `doneWhen` (single done-when string from the task store) rendered in the
                    prototype checklist-row shape; honest placeholder when the task has none. */}
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    fontSize: 11.5,
                    lineHeight: 1.5,
                    color: 'var(--proto-ink-2)',
                    background: 'var(--proto-rail)',
                    border: '1px solid var(--proto-line-2)',
                    borderRadius: 7,
                    padding: '6px 10px',
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 4,
                      border: '1.5px solid var(--proto-line-3)',
                      background: 'var(--proto-card)',
                      boxSizing: 'border-box',
                      flex: 'none',
                      marginTop: 1.5,
                    }}
                  />
                  {task.doneWhen != null ? (
                    <span>{task.doneWhen}</span>
                  ) : (
                    <GapNote>— {L.tkNoDoneWhen}</GapNote>
                  )}
                </div>
              </div>
            </div>

            {/* Card C — Dispatch history (prototype L1493-1506). Real per-task execution/dispatch join. */}
            <div style={CARD}>
              <div style={CARD_HEADER}>
                <span style={CARD_TITLE}>{L.tkDispatchHistory}</span>
                {vv && vv.hasDispatches && (
                  <span
                    style={{
                      marginLeft: 'auto',
                      font: "400 9px 'IBM Plex Mono',monospace",
                      color: 'var(--proto-muted-3)',
                    }}
                  >
                    {vv.dispatches.length} run{vv.dispatches.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div style={{ padding: '10px 15px', fontSize: 11, lineHeight: 1.55 }}>
                {verifyQuery.isPending ? (
                  <GapNote>— {L.tkLoadingDispatch}</GapNote>
                ) : verifyQuery.isError || !vv ? (
                  <GapNote>— {L.tkDispatchFailed}</GapNote>
                ) : !vv.hasDispatches ? (
                  <GapNote>— {L.tkNoDispatches}</GapNote>
                ) : (
                  <DispatchHistoryBody vv={vv} />
                )}
              </div>
            </div>
          </div>

          {/* RIGHT column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            {/* Fields (prototype L1510-1517) */}
            <div style={CARD}>
              <div style={CARD_HEADER}>
                <span style={CARD_TITLE}>{L.tkFields}</span>
              </div>
              <div
                style={{
                  padding: '8px 15px 10px',
                  font: "400 10px/2 'IBM Plex Mono',monospace",
                  color: 'var(--proto-muted)',
                }}
              >
                {tm.fields.map((f) => (
                  <div key={f.k} style={{ display: 'flex' }}>
                    <span style={{ color: 'var(--proto-muted-3)' }}>{f.k}</span>
                    <span style={{ marginLeft: 'auto', color: f.vColor, textAlign: 'right' }}>
                      {f.v}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Dependencies (prototype L1518-1530) */}
            <div style={CARD}>
              <div style={CARD_HEADER}>
                <span style={CARD_TITLE}>{L.tkDependencies}</span>
              </div>
              <div
                style={{ padding: '10px 15px', display: 'flex', flexDirection: 'column', gap: 5 }}
              >
                {tm.deps.map((dp) => (
                  <div
                    key={`${dp.label}:${dp.id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 9px',
                      background: dp.bg,
                      border: `1px solid ${dp.border}`,
                      borderRadius: 7,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: dp.dotColor,
                        flex: 'none',
                      }}
                    />
                    <span style={{ font: "600 10.5px 'IBM Plex Mono',monospace", color: dp.idColor }}>
                      {dp.id}
                    </span>
                    <span
                      style={{
                        fontSize: 10.5,
                        color: 'var(--proto-muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {dp.name}
                    </span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        font: "400 8.5px 'IBM Plex Mono',monospace",
                        color: 'var(--proto-muted-3)',
                        flex: 'none',
                      }}
                    >
                      {dp.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions (prototype L1531-1536) */}
            <div style={{ ...CARD, padding: '11px 14px', display: 'flex', gap: 8 }}>
              {tm.canUnblock && (
                <span
                  onClick={() => !pending && onUnblock(task)}
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    fontSize: 11,
                    fontWeight: 600,
                    border: '1px solid var(--proto-line-3)',
                    borderRadius: 8,
                    padding: '6px 0',
                    color: 'var(--proto-ink)',
                    cursor: pending ? 'not-allowed' : 'pointer',
                    opacity: pending ? 0.5 : 1,
                  }}
                >
                  {L.mUnblock}
                </span>
              )}
              <span
                data-complete-task-id={task.id}
                onClick={() => tm.completable && !pending && onComplete(task)}
                style={{
                  flex: 1.3,
                  textAlign: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                  borderRadius: 8,
                  padding: '7px 0',
                  color: 'var(--ink-solid-fg)',
                  background: tm.completeBg,
                  cursor: tm.completable && !pending ? 'pointer' : 'not-allowed',
                  opacity: pending ? 0.6 : 1,
                }}
              >
                {tm.completeLabel}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
