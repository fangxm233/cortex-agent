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
// Card B (Done-when verification) + Card C (Dispatch history) now consume the REAL `tasks.verification`
// scope: done-when achievement evidence (completed-note / completed-at / the completing
// execution's output) + the per-task execution/dispatch join. Where the scope returns null / [] (task
// not completed, no note, no completing execution, never dispatched) the card shows an honest
// placeholder — never fabricated evidence.
// DATA GAP still flagged:
//   • GAP-GPU          : no gpu on TaskInfo → Fields gpu renders "—" (matches the T-046 proto-shot).

const CARD: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #E7E9EE',
  borderRadius: 10,
  boxShadow: '0 1px 2px rgba(16,24,40,.03)',
};

const CARD_HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '10px 15px',
  borderBottom: '1px solid #EFF1F5',
};

const CARD_TITLE: React.CSSProperties = { fontSize: 11.5, fontWeight: 650, color: '#191C22' };

// A muted note flagging a field with no real value (task not completed / never dispatched, etc.).
function GapNote({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontStyle: 'italic', color: '#B6BDC9' }}>{children}</span>
  );
}

const EVIDENCE_LABEL: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '.05em',
  color: '#98A1B0',
  display: 'block',
  marginBottom: 3,
};

// Card B body — real done-when achievement evidence (completed-note / completed-at / completing
// execution output). Honest placeholder when the task is not yet completed.
function VerificationBody({ vv }: { vv: TaskVerificationVm }) {
  const L = useVocab();
  if (!vv.completed) {
    return (
      <GapNote>
        — {L.tkGapNotCompleted}
      </GapNote>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9, color: '#22262E' }}>
      <div>
        <span style={EVIDENCE_LABEL}>{L.tkCompletedAt}</span>
        {vv.completedAt != null ? (
          <span style={{ font: "400 10.5px 'IBM Plex Mono',monospace", color: '#5B6472' }}>
            {vv.completedAt}
          </span>
        ) : (
          <GapNote>— {L.tkNotRecorded}</GapNote>
        )}
      </div>
      <div>
        <span style={EVIDENCE_LABEL}>{L.tkCompletionNote}</span>
        {vv.completedNote != null ? (
          <span>{vv.completedNote}</span>
        ) : (
          <GapNote>— {L.tkNoCompletionNote}</GapNote>
        )}
      </div>
      <div>
        <span style={EVIDENCE_LABEL}>{L.tkCompletingRun}</span>
        {vv.completingExecutionId != null ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ font: "600 10.5px 'IBM Plex Mono',monospace", color: '#4655D4' }}>
              {vv.completingExecutionId}
            </span>
            {vv.completingOutput != null ? (
              <span
                style={{
                  fontSize: 10.5,
                  color: '#5B6472',
                  background: '#FBFBFC',
                  border: '1px solid #EFF1F5',
                  borderRadius: 7,
                  padding: '6px 10px',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {vv.completingOutput}
              </span>
            ) : (
              <GapNote>— {L.tkNoFinalOutput}</GapNote>
            )}
          </div>
        ) : (
          <GapNote>— {L.tkNoExecLinked}</GapNote>
        )}
      </div>
    </div>
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
            background: d.isCompleting ? '#F5F7FF' : '#FBFBFC',
            border: `1px solid ${d.isCompleting ? '#DDE3FB' : '#EFF1F5'}`,
            borderRadius: 7,
          }}
        >
          <span
            style={{ width: 6, height: 6, borderRadius: '50%', background: d.statusColor, flex: 'none' }}
          />
          <span style={{ font: "600 10px 'IBM Plex Mono',monospace", color: '#4655D4' }}>
            {d.executionId}
          </span>
          <span style={{ fontSize: 9.5, color: '#8A93A2' }}>{d.machine}</span>
          <span
            style={{
              marginLeft: 'auto',
              font: "400 9px 'IBM Plex Mono',monospace",
              color: '#98A1B0',
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
          background: '#F7F8FA',
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
            background: '#fff',
            borderBottom: '1px solid #E7E9EE',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '12px 18px',
          }}
        >
          <span style={{ font: "600 12.5px 'IBM Plex Mono',monospace", color: '#191C22' }}>
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
            style={{ font: "400 9.5px 'IBM Plex Mono',monospace", color: '#98A1B0', marginLeft: 4 }}
          >
            TASKS.yaml
          </span>
          <span
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              font: "500 9.5px 'IBM Plex Mono',monospace",
              color: '#98A1B0',
              border: '1px solid #E7E9EE',
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
                <div style={{ fontSize: 13.5, fontWeight: 650, color: '#191C22', lineHeight: 1.4 }}>
                  {tm.title}
                </div>
              </div>
              <div style={{ fontSize: 11.5, lineHeight: 1.6, color: '#5B6472', marginTop: 7 }}>
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: '.05em',
                    color: '#98A1B0',
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
                  color: '#98A1B0',
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
                    color: '#22262E',
                    background: '#FBFBFC',
                    border: '1px solid #EFF1F5',
                    borderRadius: 7,
                    padding: '6px 10px',
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 4,
                      border: '1.5px solid #D9DCE3',
                      background: '#fff',
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

            {/* Card B — Done-when verification (prototype L1483-1492). Real evidence via tasks.verification. */}
            <div style={CARD}>
              <div style={CARD_HEADER}>
                <span style={CARD_TITLE}>{L.tkVerification}</span>
                {vv && (
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 9.5,
                      fontWeight: 600,
                      padding: '1px 7px',
                      borderRadius: 999,
                      background: vv.completed ? '#E9F4EE' : '#F1F2F5',
                      color: vv.completed ? '#23854F' : '#8A93A2',
                    }}
                  >
                    {vv.completed ? `✓ ${L.tkCompleted}` : L.tkNotCompleted}
                  </span>
                )}
              </div>
              <div style={{ padding: '10px 15px', fontSize: 11, lineHeight: 1.55 }}>
                {verifyQuery.isPending ? (
                  <GapNote>— {L.tkLoadingVerification}</GapNote>
                ) : verifyQuery.isError || !vv ? (
                  <GapNote>— {L.tkVerificationFailed}</GapNote>
                ) : (
                  <VerificationBody vv={vv} />
                )}
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
                      color: '#98A1B0',
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
                  color: '#5B6472',
                }}
              >
                {tm.fields.map((f) => (
                  <div key={f.k} style={{ display: 'flex' }}>
                    <span style={{ color: '#98A1B0' }}>{f.k}</span>
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
                        color: '#5B6472',
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
                        color: '#98A1B0',
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
                    border: '1px solid #D9DCE3',
                    borderRadius: 8,
                    padding: '6px 0',
                    color: '#191C22',
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
                  color: '#fff',
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
