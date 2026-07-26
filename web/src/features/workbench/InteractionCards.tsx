// input:  interaction view models and localized card copy
// output: Desktop ask-user and plan-approval cards
// pos:    Controlled workbench interaction-card presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useState } from 'react';
import {
  type AskCardModel,
  type PlanCardModel,
  type DeskAskState,
  deskTogglePick,
  deskToggleOther,
  deskSetOtherText,
  deskCanSubmit,
  deskBuildAnswers,
  formatTtl,
} from './interaction-vm';
import { useTtlSeconds } from './useInteractionTtl';

const mono = "'IBM Plex Mono',monospace";

export interface DIntCopy {
  askPill: string;
  askAnsweredPill: string;
  askTag: (multi: boolean) => string;
  otherChip: string;
  otherPlaceholder: string;
  askFootnote: string;
  submit: string;
  ttlPrefix: string;
  planPendingPill: string;
  planApprovedPill: string;
  planRejectedPill: string;
  planTtl: string;
  approvedBy: string;
  fileSub: string;
  readLink: string;
  approveHint: string;
  requestChanges: string;
  approvePlan: string;
  feedbackHint: string;
  feedbackPlaceholder: string;
  cancel: string;
  confirmReturn: string;
  approvedFoot: string;
  rejectedFoot: string;
  viewPlan: string;
  viewOriginalPlan: string;
}

export const D_INT_COPY: { zh: DIntCopy; en: DIntCopy } = {
  zh: {
    askPill: '需要你拍板',
    askAnsweredPill: '已回答',
    askTag: (m) => (m ? '多选' : '单选'),
    otherChip: '其他…',
    otherPlaceholder: '补充你的答案…',
    askFootnote: '线程暂停中 · 提交后继续',
    submit: '提交回答',
    ttlPrefix: '阻塞中 · TTL',
    planPendingPill: 'PLAN · 等待批准',
    planApprovedPill: '✓ 计划已批准',
    planRejectedPill: '已驳回',
    planTtl: '线程暂停中 · TTL',
    approvedBy: '由你批准',
    fileSub: '已写入 · 批准前建议通读全文',
    readLink: '阅读 ›',
    approveHint: '批准 = 开始执行',
    requestChanges: '请求修改',
    approvePlan: '批准计划',
    feedbackHint: '反馈必填 · 确认后退回重新规划',
    feedbackPlaceholder: '说明需要修改什么…',
    cancel: '取消',
    confirmReturn: '确认退回',
    approvedFoot: '· 线程继续执行',
    rejectedFoot: '',
    viewPlan: '查看计划 ›',
    viewOriginalPlan: '查看原计划 ›',
  },
  en: {
    askPill: 'Your call',
    askAnsweredPill: 'Answered',
    askTag: (m) => (m ? 'multi' : 'single'),
    otherChip: 'Other…',
    otherPlaceholder: 'Type your answer…',
    askFootnote: 'Thread paused · continues after submit',
    submit: 'Submit answers',
    ttlPrefix: 'Blocking · TTL',
    planPendingPill: 'PLAN · awaiting approval',
    planApprovedPill: '✓ Plan approved',
    planRejectedPill: 'Rejected',
    planTtl: 'Thread paused · TTL',
    approvedBy: 'approved by you',
    fileSub: 'written · read the full plan before approving',
    readLink: 'Read ›',
    approveHint: 'approve = start execution',
    requestChanges: 'Request changes',
    approvePlan: 'Approve plan',
    feedbackHint: 'Feedback required · confirming returns it for replanning',
    feedbackPlaceholder: 'What needs to change…',
    cancel: 'Cancel',
    confirmReturn: 'Confirm return',
    approvedFoot: '· thread continues',
    rejectedFoot: '',
    viewPlan: 'View plan ›',
    viewOriginalPlan: 'View original plan ›',
  },
};

// ── 13b AskUserQuestion ───────────────────────────────────────────────────────

export interface DeskAskCardProps {
  model: AskCardModel;
  /** Controlled 13b answer state (picks / 其他 text) — owned by InteractionRowCard. */
  state: DeskAskState;
  copy: DIntCopy;
  onState: (next: DeskAskState) => void;
  onSubmit: (answers: Record<string, string>) => void;
  busy: boolean;
}

export function DeskAskCard({ model, state, copy, onState, onSubmit, busy }: DeskAskCardProps): JSX.Element {
  const pending = model.status === 'pending';
  const ttlSec = useTtlSeconds(model.ts, pending);
  const canSubmit = pending && !busy && deskCanSubmit(model, state);

  // sealed — 13b right column: per-question ✓ rows
  if (!pending) {
    return (
      <div style={{ border: '1px solid var(--proto-line)', background: 'var(--proto-rail)', borderRadius: 10, padding: '13px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, flex: 'none' }}>?</span>
          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2.5px 9px', borderRadius: 999, background: 'var(--proto-gray)', color: 'var(--proto-muted-2)' }}>{copy.askAnsweredPill}</span>
          <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>AskUserQuestion</span>
          {model.timeLabel && <span style={{ marginLeft: 'auto', font: `400 9.5px ${mono}`, color: 'var(--proto-faint)' }}>{model.timeLabel}</span>}
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {model.questions.map((q) => (
            <div key={q.question} style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.5, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--proto-success)', fontWeight: 700, flex: 'none' }}>✓</span>
              <div style={{ minWidth: 0, display: 'flex', flexWrap: 'wrap', columnGap: 8, rowGap: 2 }}>
                <span style={{ color: 'var(--proto-muted-2)', overflowWrap: 'anywhere' }}>{q.question}</span>
                <span style={{ color: 'var(--proto-ink)', fontWeight: 600, overflowWrap: 'anywhere' }}>{q.answer ?? '—'}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // pending — 13b left column
  return (
    <div style={{ border: '1px solid var(--proto-accent-border)', background: 'var(--proto-rail)', borderRadius: 10, padding: '13px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, flex: 'none' }}>?</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2.5px 9px', borderRadius: 999, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' }}>{copy.askPill}</span>
        <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>AskUserQuestion</span>
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${mono}`, color: 'var(--proto-faint)' }}>
          {copy.ttlPrefix} {ttlSec != null ? formatTtl(ttlSec) : '30m'}
        </span>
      </div>

      {model.questions.map((q, qi) => {
        const picks = state.picks[qi] ?? [];
        const otherOn = state.otherOn[qi] ?? false;
        return (
          <div key={q.question} style={{ marginTop: qi === 0 ? 10 : 13 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{q.question}</span>
              <span style={{ font: `500 9px ${mono}`, color: 'var(--proto-muted-3)', background: 'var(--proto-gray)', padding: '1px 6px', borderRadius: 5 }}>{copy.askTag(q.multiSelect)}</span>
            </div>
            <div style={{ display: 'flex', gap: 7, marginTop: 8, flexWrap: 'wrap' }}>
              {q.options.map((o) => {
                const on = picks.includes(o.label);
                const mark = q.multiSelect ? (on ? '☑' : '☐') : on ? '●' : '○';
                return (
                  <span
                    key={o.label}
                    role="button"
                    title={o.description ?? undefined}
                    onClick={() => onState(deskTogglePick(state, qi, o.label, q.multiSelect))}
                    style={{
                      fontSize: 12,
                      fontWeight: on ? 600 : 500,
                      border: `1px solid ${on ? 'var(--proto-accent)' : 'var(--proto-accent-border)'}`,
                      background: on ? 'var(--proto-accent-bg)' : 'var(--proto-card)',
                      color: 'var(--proto-accent)',
                      padding: '5px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                    }}
                  >
                    {mark} {o.label}
                  </span>
                );
              })}
              <span
                role="button"
                onClick={() => onState(deskToggleOther(state, qi, q.multiSelect))}
                style={{
                  fontSize: 12,
                  fontWeight: otherOn ? 600 : 500,
                  border: `1px solid ${otherOn ? 'var(--proto-accent)' : 'var(--proto-accent-border)'}`,
                  background: otherOn ? 'var(--proto-accent-bg)' : 'var(--proto-card)',
                  color: 'var(--proto-accent)',
                  padding: '5px 12px',
                  borderRadius: 8,
                  cursor: 'pointer',
                }}
              >
                {q.multiSelect ? (otherOn ? '☑' : '☐') : otherOn ? '●' : '○'} {copy.otherChip}
              </span>
            </div>
            {/* 其他… free-text — expands only while selected (13b) */}
            {otherOn && (
              <input
                value={state.otherText[qi] ?? ''}
                onChange={(e) => onState(deskSetOtherText(state, qi, e.target.value))}
                placeholder={copy.otherPlaceholder}
                style={{
                  marginTop: 7,
                  width: '100%',
                  boxSizing: 'border-box',
                  border: '1px solid var(--proto-accent-border)',
                  borderRadius: 8,
                  padding: '7px 11px',
                  fontSize: 12,
                  color: 'var(--proto-ink)',
                  background: 'var(--proto-card)',
                  outline: 'none',
                }}
              />
            )}
          </div>
        );
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 13 }}>
        <span style={{ fontSize: 10.5, color: 'var(--proto-muted-3)', flex: 1, lineHeight: 1.5 }}>{copy.askFootnote}</span>
        <span
          role="button"
          onClick={canSubmit ? () => onSubmit(deskBuildAnswers(model, state)) : undefined}
          style={{
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 8,
            padding: '7px 16px',
            color: 'var(--ink-solid-fg)',
            background: canSubmit ? 'var(--proto-ink)' : 'var(--proto-faint)',
            flex: 'none',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {copy.submit}
        </span>
      </div>
    </div>
  );
}

// ── 13c Plan 审批（薄卡） ─────────────────────────────────────────────────────

export interface DeskPlanCardProps {
  model: PlanCardModel;
  copy: DIntCopy;
  /** Controlled 请求修改 state — the feedback box shows only after the button (13c middle). */
  feedbackOpen: boolean;
  onFeedbackOpen: (open: boolean) => void;
  onApprove: () => void;
  onReject: (feedback: string) => void;
  onOpenRead: () => void;
  busy: boolean;
}

export function DeskPlanCard({ model, copy, feedbackOpen, onFeedbackOpen, onApprove, onReject, onOpenRead, busy }: DeskPlanCardProps): JSX.Element {
  const pending = model.status === 'pending';
  const approved = model.status === 'approved';
  const rejected = model.status === 'rejected';
  const ttlSec = useTtlSeconds(model.ts, pending);
  const [feedback, setFeedback] = useState('');
  const canReturn = feedback.trim().length > 0 && !busy;

  const fileRow = (model.filePath || model.planContent) ? (
    <div
      role="button"
      onClick={onOpenRead}
      style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--proto-accent-bg)', background: 'var(--proto-accent-bg)', borderRadius: 8, padding: '9px 12px', cursor: 'pointer' }}
    >
      <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="var(--proto-accent)" strokeWidth="1.4" style={{ flex: 'none' }}>
        <path d="M3 1.5h5.5L11.5 4.5V12.5H3z" />
        <path d="M5 6.5h4M5 9h4" />
      </svg>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ font: `500 11px ${mono}`, color: 'var(--proto-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{model.filePath ?? `${model.lineCount} lines`}</div>
        <div style={{ fontSize: 10, color: 'var(--proto-muted-3)', marginTop: 2 }}>{copy.fileSub}</div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-accent)', flex: 'none' }}>{copy.readLink}</span>
    </div>
  ) : null;

  // sealed — 13c right column (approved) / 4c isomorph (rejected)
  if (!pending) {
    return (
      <>
        <div style={{ border: '1px solid var(--proto-line)', background: 'var(--proto-rail)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 15px', borderBottom: '1px solid var(--proto-line-2)', background: 'var(--proto-rail)' }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2.5px 9px', borderRadius: 999, background: approved ? 'var(--proto-success-bg)' : 'var(--proto-gray)', color: approved ? 'var(--proto-success)' : 'var(--proto-muted-2)' }}>
              {approved ? copy.planApprovedPill : rejected ? copy.planRejectedPill : model.status}
            </span>
            <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>ExitPlanMode</span>
            {model.timeLabel && (
              <span style={{ marginLeft: 'auto', font: `400 9.5px ${mono}`, color: 'var(--proto-faint)' }}>
                {model.timeLabel}{approved ? ` ${copy.approvedBy}` : ''}
              </span>
            )}
          </div>
          <div style={{ padding: '12px 16px 13px' }}>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: approved ? 'var(--proto-muted)' : 'var(--proto-muted-2)',
                overflowWrap: 'break-word',
                ...(rejected ? { textDecoration: 'line-through', textDecorationColor: 'var(--proto-line)' } : {}),
              }}
            >
              {model.title}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 16px', borderTop: '1px solid var(--proto-line-2)', font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>
            {model.filePath && <span style={{ color: 'var(--proto-accent)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.filePath}</span>}
            <span>{approved ? copy.approvedFoot : rejected ? copy.rejectedFoot : ''}</span>
            <span role="button" onClick={onOpenRead} style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
              {rejected ? copy.viewOriginalPlan : copy.viewPlan}
            </span>
          </div>
        </div>
        {/* 4c — the reject feedback enters the flow as the user bubble (real result.feedback) */}
        {rejected && model.feedback && (
          <div style={{ alignSelf: 'flex-end', maxWidth: '75%', background: 'var(--proto-gray)', borderRadius: '14px 14px 4px 14px', padding: '9px 14px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--proto-ink)', whiteSpace: 'pre-wrap', marginTop: 10 }}>
            {model.feedback}
          </div>
        )}
      </>
    );
  }

  // pending — 13c left/middle columns (feedback box only after 请求修改)
  return (
    <div style={{ border: '1px solid var(--proto-accent-border)', background: 'var(--proto-card)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 15px', borderBottom: '1px solid var(--proto-line-2)', background: 'var(--proto-rail)' }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2.5px 9px', borderRadius: 999, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' }}>{copy.planPendingPill}</span>
        <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>ExitPlanMode</span>
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${mono}`, color: 'var(--proto-faint)' }}>
          {copy.planTtl} {ttlSec != null ? formatTtl(ttlSec) : '30m'}
        </span>
      </div>
      <div style={{ padding: '12px 16px 13px' }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--proto-ink)', overflowWrap: 'break-word' }}>{model.title}</div>
        {fileRow}
      </div>
      {feedbackOpen && (
        <div style={{ padding: '0 16px 11px' }}>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={copy.feedbackPlaceholder}
            rows={2}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1.5px solid var(--proto-amber)',
              boxShadow: '0 0 0 3px rgba(201,154,46,.08)',
              background: 'var(--proto-card)',
              borderRadius: 8,
              padding: '8px 11px',
              fontSize: 12,
              lineHeight: 1.55,
              color: 'var(--proto-ink)',
              outline: 'none',
              resize: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 16px', borderTop: '1px solid var(--proto-line-2)' }}>
        <span style={{ fontSize: 10.5, color: 'var(--proto-muted-3)', flex: 1, lineHeight: 1.5 }}>
          {feedbackOpen ? copy.feedbackHint : copy.approveHint}
        </span>
        {feedbackOpen ? (
          <>
            <span
              role="button"
              onClick={() => { onFeedbackOpen(false); setFeedback(''); }}
              style={{ fontSize: 12, fontWeight: 600, border: '1px solid var(--proto-line-3)', background: 'var(--proto-card)', color: 'var(--proto-ink)', padding: '6px 13px', borderRadius: 8, flex: 'none', cursor: 'pointer' }}
            >
              {copy.cancel}
            </span>
            <span
              role="button"
              onClick={canReturn ? () => onReject(feedback.trim()) : undefined}
              style={{ fontSize: 12, fontWeight: 600, borderRadius: 8, padding: '7px 16px', color: 'var(--ink-solid-fg)', background: canReturn ? 'var(--proto-ink)' : 'var(--proto-faint)', flex: 'none', cursor: canReturn ? 'pointer' : 'not-allowed' }}
            >
              {copy.confirmReturn}
            </span>
          </>
        ) : (
          <>
            <span
              role="button"
              onClick={() => onFeedbackOpen(true)}
              style={{ fontSize: 12, fontWeight: 600, border: '1px solid var(--proto-line-3)', background: 'var(--proto-card)', color: 'var(--proto-ink)', padding: '6px 13px', borderRadius: 8, flex: 'none', cursor: 'pointer' }}
            >
              {copy.requestChanges}
            </span>
            <span
              role="button"
              onClick={busy ? undefined : onApprove}
              style={{ fontSize: 12, fontWeight: 600, borderRadius: 8, padding: '7px 16px', color: 'var(--ink-solid-fg)', background: busy ? 'var(--proto-faint)' : 'var(--proto-ink)', flex: 'none', cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              {copy.approvePlan}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
