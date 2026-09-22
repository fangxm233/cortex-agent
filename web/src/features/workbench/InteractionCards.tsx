// input:  Interaction models, answer state, notice tones, TTL
// output: DeskAskCard, DeskPlanCard, D_INT_COPY
// pos:    Filter-free question and plan material cards
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useState } from 'react';
import { noticeTone } from './ChatNotice';
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

const cardMaterial = { background: 'var(--material-card-bg)', boxShadow: 'var(--material-card-shadow)' };
const controlMaterial = { background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)' };

const mono = "'IBM Plex Mono',monospace";
const focusClass = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent';

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
    askFootnote: 'Agent 暂停中 · 提交后继续',
    submit: '提交回答',
    ttlPrefix: '阻塞中 · TTL',
    planPendingPill: 'PLAN · 等待批准',
    planApprovedPill: '✓ 计划已批准',
    planRejectedPill: '已驳回',
    planTtl: 'Agent 暂停中 · TTL',
    approvedBy: '由你批准',
    fileSub: '已写入 · 批准前建议通读全文',
    readLink: '阅读 ›',
    approveHint: '',
    requestChanges: '请求修改',
    approvePlan: '批准计划',
    feedbackHint: '反馈必填 · 确认后退回重新规划',
    feedbackPlaceholder: '说明需要修改什么…',
    cancel: '取消',
    confirmReturn: '确认退回',
    approvedFoot: '· Agent 继续执行',
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
    askFootnote: 'Agent paused · continues after submit',
    submit: 'Submit answers',
    ttlPrefix: 'Blocking · TTL',
    planPendingPill: 'PLAN · awaiting approval',
    planApprovedPill: '✓ Plan approved',
    planRejectedPill: 'Rejected',
    planTtl: 'Agent paused · TTL',
    approvedBy: 'approved by you',
    fileSub: 'written · read the full plan before approving',
    readLink: 'Read ›',
    approveHint: '',
    requestChanges: 'Request changes',
    approvePlan: 'Approve plan',
    feedbackHint: 'Feedback required · confirming returns it for replanning',
    feedbackPlaceholder: 'What needs to change…',
    cancel: 'Cancel',
    confirmReturn: 'Confirm return',
    approvedFoot: '· agent continues',
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
      <div style={{ ...cardMaterial, border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)', padding: '13px 16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flex: 'none' }}>?</span>
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2.5px 9px', borderRadius: 'var(--r-pill)', background: 'var(--proto-gray)', color: 'var(--proto-muted)' }}>{copy.askAnsweredPill}</span>
          <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>AskUserQuestion</span>
          {model.timeLabel && <span style={{ marginLeft: 'auto', font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>{model.timeLabel}</span>}
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {model.questions.map((q) => (
            <div key={q.question} style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.5, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--proto-success)', fontWeight: 700, flex: 'none' }}>✓</span>
              <div style={{ minWidth: 0, display: 'flex', flexWrap: 'wrap', columnGap: 8, rowGap: 2 }}>
                <span style={{ color: 'var(--proto-muted)', overflowWrap: 'anywhere' }}>{q.question}</span>
                <span style={{ color: 'var(--proto-ink)', fontWeight: 600, overflowWrap: 'anywhere' }}>{q.answer ?? '—'}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // pending — 13b left column (an explicit level reuses the ChatNotice tone on border/badge)
  const tone = model.level ? noticeTone(model.level) : null;
  return (
    <div
      {...(model.level ? { 'data-ask-level': model.level } : {})}
      style={{ ...cardMaterial, border: `1px solid ${tone ? tone.border : 'var(--proto-accent-border)'}`, borderRadius: 'var(--r-card)', padding: '13px 16px' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 18, height: 18, borderRadius: '50%', background: tone ? tone.bg : 'var(--proto-accent-bg)', color: tone ? tone.fg : 'var(--proto-accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flex: 'none' }}>{tone ? tone.icon : '?'}</span>
        <span style={{ fontSize: 11, fontWeight: 600, padding: '2.5px 9px', borderRadius: 'var(--r-pill)', background: tone ? tone.bg : 'var(--proto-accent-bg)', color: tone ? tone.fg : 'var(--proto-accent)' }}>{copy.askPill}</span>
        <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>AskUserQuestion</span>
        <span style={{ marginLeft: 'auto', font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>
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
              <span style={{ font: `500 11px ${mono}`, color: 'var(--proto-muted)', background: 'var(--proto-gray)', padding: '1px 6px', borderRadius: 'var(--r-chip)', flex: 'none'  }}>{copy.askTag(q.multiSelect)}</span>
            </div>
            <div style={{ display: 'flex', gap: 7, marginTop: 8, flexWrap: 'wrap' }}>
              {q.options.map((o) => {
                const on = picks.includes(o.label);
                const mark = q.multiSelect ? (on ? '☑' : '☐') : on ? '●' : '○';
                return (
                  <button
                    key={o.label}
                    type="button"
                    className={focusClass}
                    aria-pressed={on}
                    title={o.description ?? undefined}
                    onClick={() => onState(deskTogglePick(state, qi, o.label, q.multiSelect))}
                    style={{
                      fontSize: 12,
                      fontWeight: on ? 600 : 500,
                      border: `1px solid ${on ? 'var(--proto-accent)' : 'var(--proto-accent-border)'}`,
                      ...controlMaterial,
                      background: on ? 'var(--proto-accent-bg)' : controlMaterial.background,
                      color: 'var(--proto-accent)',
                      padding: '5px 12px',
                      borderRadius: 'var(--r-control)',
                      cursor: 'pointer',
                    }}
                  >
                    {mark} {o.label}
                  </button>
                );
              })}
              <button
                type="button"
                className={focusClass}
                aria-pressed={otherOn}
                onClick={() => onState(deskToggleOther(state, qi, q.multiSelect))}
                style={{
                  fontSize: 12,
                  fontWeight: otherOn ? 600 : 500,
                  border: `1px solid ${otherOn ? 'var(--proto-accent)' : 'var(--proto-accent-border)'}`,
                  ...controlMaterial,
                  background: otherOn ? 'var(--proto-accent-bg)' : controlMaterial.background,
                  color: 'var(--proto-accent)',
                  padding: '5px 12px',
                  borderRadius: 'var(--r-control)',
                  cursor: 'pointer',
                }}
              >
                {q.multiSelect ? (otherOn ? '☑' : '☐') : otherOn ? '●' : '○'} {copy.otherChip}
              </button>
            </div>
            {/* 其他… free-text — expands only while selected (13b) */}
            {otherOn && (
              <input
                className={focusClass}
                aria-label={copy.otherPlaceholder}
                value={state.otherText[qi] ?? ''}
                onChange={(e) => onState(deskSetOtherText(state, qi, e.target.value))}
                placeholder={copy.otherPlaceholder}
                style={{
                  marginTop: 7,
                  width: '100%',
                  boxSizing: 'border-box',
                  border: '1px solid var(--proto-accent-border)',
                  borderRadius: 'var(--r-control)',
                  padding: '7px 11px',
                  fontSize: 12,
                  color: 'var(--proto-ink)',
                  background: 'var(--material-inset-bg)',
                }}
              />
            )}
          </div>
        );
      })}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 13 }}>
        <span style={{ fontSize: 11, color: 'var(--proto-muted)', flex: 1, lineHeight: 1.5 }}>{copy.askFootnote}</span>
        <button
          type="button"
          className={focusClass}
          disabled={!canSubmit}
          onClick={canSubmit ? () => onSubmit(deskBuildAnswers(model, state)) : undefined}
          style={{
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 'var(--r-control)',
            padding: '7px 16px',
            color: canSubmit ? 'var(--ink-solid-fg)' : 'var(--proto-muted)',
            background: canSubmit ? 'var(--proto-ink)' : 'var(--proto-gray)',
            flex: 'none',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {copy.submit}
        </button>
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
    <button
      type="button"
      className={focusClass}
      onClick={onOpenRead}
      style={{ width: '100%', textAlign: 'left', marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--proto-accent-border)' , background: 'var(--proto-accent-bg)', borderRadius: 'var(--r-control)', padding: '9px 12px', cursor: 'pointer' }}
    >
      <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="var(--proto-accent)" strokeWidth="1.4" style={{ flex: 'none' }}>
        <path d="M3 1.5h5.5L11.5 4.5V12.5H3z" />
        <path d="M5 6.5h4M5 9h4" />
      </svg>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', font: `500 11px ${mono}`, color: 'var(--proto-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{model.filePath ?? `${model.lineCount} lines`}</span>
        <span style={{ display: 'block', fontSize: 11, color: 'var(--proto-muted)', marginTop: 2 }}>{copy.fileSub}</span>
      </span>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-accent)', flex: 'none' }}>{copy.readLink}</span>
    </button>
  ) : null;

  // sealed — 13c right column (approved) / 4c isomorph (rejected)
  if (!pending) {
    return (
      <>
        <div style={{ ...cardMaterial, border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 9, padding: '10px 15px', borderBottom: '1px solid var(--proto-line-2)', background: 'var(--proto-alt)' }}>
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2.5px 9px', borderRadius: 'var(--r-pill)', background: approved ? 'var(--proto-success-bg)' : 'var(--proto-gray)', color: approved ? 'var(--proto-success)' : 'var(--proto-muted)' }}>
              {approved ? copy.planApprovedPill : rejected ? copy.planRejectedPill : model.status}
            </span>
            <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>ExitPlanMode</span>
            {model.timeLabel && (
              <span style={{ marginLeft: 'auto', font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>
                {model.timeLabel}{approved ? ` ${copy.approvedBy}` : ''}
              </span>
            )}
          </div>
          <div style={{ padding: '12px 16px 13px' }}>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--proto-ink)',
                overflowWrap: 'break-word',
                ...(rejected ? { textDecoration: 'line-through', textDecorationColor: 'var(--proto-line)' } : {}),
              }}
            >
              {model.title}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 16px', borderTop: '1px solid var(--proto-line-2)', font: `400 11px ${mono}`, color: 'var(--proto-muted)', flexWrap: 'wrap' }}>
            {model.filePath && <span style={{ color: 'var(--proto-accent)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.filePath}</span>}
            <span>{approved ? copy.approvedFoot : rejected ? copy.rejectedFoot : ''}</span>
            <button type="button" className={focusClass} onClick={onOpenRead} style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontWeight: 600, cursor: 'pointer', flex: 'none', borderRadius: 'var(--r-control)' }}>
              {rejected ? copy.viewOriginalPlan : copy.viewPlan}
            </button>
          </div>
        </div>
        {/* 4c — the reject feedback enters the flow as the user bubble (real result.feedback) */}
        {rejected && model.feedback && (
          <div style={{ alignSelf: 'flex-end', maxWidth: '75%', ...cardMaterial, border: '1px solid var(--proto-line-2)' , borderRadius: 'var(--r-card) var(--r-card) 4px var(--r-card)', padding: '9px 14px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--proto-ink)', whiteSpace: 'pre-wrap', marginTop: 10 }}>
            {model.feedback}
          </div>
        )}
      </>
    );
  }

  // pending — 13c left/middle columns (feedback box only after 请求修改)
  return (
    <div style={{ ...cardMaterial, border: '1px solid var(--proto-accent-border)', borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 9, padding: '10px 15px', borderBottom: '1px solid var(--proto-line-2)', background: 'var(--proto-alt)' }}>
        <span style={{ fontSize: 11, fontWeight: 600, padding: '2.5px 9px', borderRadius: 'var(--r-pill)', background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' }}>{copy.planPendingPill}</span>
        <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>ExitPlanMode</span>
        <span style={{ marginLeft: 'auto', font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>
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
            className={focusClass}
            aria-label={copy.feedbackHint}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={copy.feedbackPlaceholder}
            rows={2}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid var(--proto-amber)',
              background: 'var(--material-inset-bg)',
              borderRadius: 'var(--r-control)',
              padding: '8px 11px',
              fontSize: 12,
              lineHeight: 1.55,
              color: 'var(--proto-ink)',
              resize: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '11px 16px', borderTop: '1px solid var(--proto-line-2)' }}>
        <span style={{ fontSize: 11, color: 'var(--proto-muted)', flex: 1, lineHeight: 1.5 }}>
          {feedbackOpen ? copy.feedbackHint : copy.approveHint}
        </span>
        {feedbackOpen ? (
          <>
            <button
              type="button"
              className={focusClass}
              onClick={() => { onFeedbackOpen(false); setFeedback(''); }}
              style={{ ...controlMaterial, fontSize: 12, fontWeight: 600, border: '1px solid var(--proto-line-3)', color: 'var(--proto-ink)', padding: '6px 13px', borderRadius: 'var(--r-control)', flex: 'none', cursor: 'pointer' }}
            >
              {copy.cancel}
            </button>
            <button
              type="button"
              className={focusClass}
              disabled={!canReturn}
              onClick={canReturn ? () => onReject(feedback.trim()) : undefined}
              style={{ fontSize: 12, fontWeight: 600, borderRadius: 'var(--r-control)', padding: '7px 16px', color: canReturn ? 'var(--ink-solid-fg)' : 'var(--proto-muted)', background: canReturn ? 'var(--proto-ink)' : 'var(--proto-gray)', flex: 'none', cursor: canReturn ? 'pointer' : 'not-allowed' }}
            >
              {copy.confirmReturn}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={focusClass}
              onClick={() => onFeedbackOpen(true)}
              style={{ ...controlMaterial, fontSize: 12, fontWeight: 600, border: '1px solid var(--proto-line-3)', color: 'var(--proto-ink)', padding: '6px 13px', borderRadius: 'var(--r-control)', flex: 'none', cursor: 'pointer' }}
            >
              {copy.requestChanges}
            </button>
            <button
              type="button"
              className={focusClass}
              disabled={busy}
              onClick={busy ? undefined : onApprove}
              style={{ fontSize: 12, fontWeight: 600, borderRadius: 'var(--r-control)', padding: '7px 16px', color: busy ? 'var(--proto-muted)' : 'var(--ink-solid-fg)', background: busy ? 'var(--proto-gray)' : 'var(--proto-ink)', flex: 'none', cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              {copy.approvePlan}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
