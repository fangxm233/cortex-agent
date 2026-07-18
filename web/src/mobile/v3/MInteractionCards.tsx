// @ds-adherence-ignore -- mobile v3 interaction cards, chrome extracted 1:1 from
// scheme-mobile.dc.html sec-6 (6a 薄审批卡 L85-129) · sec-5 (5b 多问题 L224-267, 5a 压暗态
// L192-198) · sec-4 (4a 已答 L278-315 · 4b 已批准 L319-372 · 4c 已驳回 L375-410). Raw px/hex by
// design §8.3. Pure + presentational: models come from the shared interaction-vm; the container
// (MChatScreen / MessageStream) owns data + mutations. Honest gaps: the `来自 X` footer source has
// no entity field → omitted; the TTL countdown derives from the row ts + the server's 30m constant.
import { useState } from 'react';
import { MC, MONO } from '@/mobile/ui/kit';
import {
  type AskCardModel,
  type PlanCardModel,
  type AskAnswerState,
  currentQuestionIndex,
  formatTtl,
} from '@/features/workbench/interaction-vm';
import { useTtlSeconds } from '@/features/workbench/useInteractionTtl';

export interface MIntCopy {
  askPill: string;
  answeredPill: string;
  defaultBadge: string;
  customOption: string;
  confirm: string;
  queued: string;
  multiTag: string;
  askFooter: string;
  ttlSuffix: string;
  planPendingPill: string;
  planApprovedPill: string;
  planRejectedPill: string;
  approvedBy: string;
  readHint: string;
  readLink: string;
  approve: string;
  reject: string;
  approveHint: string;
  viewFullPlan: string;
  viewOriginalPlan: string;
  rewriteNote: string;
}

export const M_INT_COPY: { zh: MIntCopy; en: MIntCopy } = {
  zh: {
    askPill: 'Agent 提问',
    answeredPill: '✓ 已回答',
    defaultBadge: '默认',
    customOption: '自定义…',
    confirm: '确认',
    queued: '待答',
    multiTag: '多选',
    askFooter: '答一题进一题 · 全答完继续',
    ttlSuffix: '后按默认继续',
    planPendingPill: '计划待批',
    planApprovedPill: '✓ 计划已批准',
    planRejectedPill: '已驳回',
    approvedBy: '由你批准',
    readHint: '批准前建议通读全文',
    readLink: '阅读 ›',
    approve: '批准并执行',
    reject: '驳回并反馈',
    approveHint: '批准 = 开始执行',
    viewFullPlan: '查看完整计划 ›',
    viewOriginalPlan: '查看原计划 ›',
    rewriteNote: '',
  },
  en: {
    askPill: 'Agent question',
    answeredPill: '✓ answered',
    defaultBadge: 'default',
    customOption: 'Custom…',
    confirm: 'Confirm',
    queued: 'queued',
    multiTag: 'multi',
    askFooter: 'one at a time · continues when all answered',
    ttlSuffix: 'until defaults apply',
    planPendingPill: 'Plan pending',
    planApprovedPill: '✓ Plan approved',
    planRejectedPill: 'Rejected',
    approvedBy: 'approved by you',
    readHint: 'read the full plan before approving',
    readLink: 'Read ›',
    approve: 'Approve & run',
    reject: 'Reject with note',
    approveHint: 'approve = start execution',
    viewFullPlan: 'View full plan ›',
    viewOriginalPlan: 'View original plan ›',
    rewriteNote: '',
  },
};

// ── shared chrome bits ─────────────────────────────────────────────────────────

function Pill({ bg, fg, text }: { bg: string; fg: string; text: string }): JSX.Element {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, flex: 'none' }}>{text}</span>
  );
}

function cardShell(pending: boolean, dimmed: boolean, rejected: boolean): React.CSSProperties {
  return {
    border: `1px solid ${pending && !dimmed ? MC.runBorder : MC.hairline}`,
    background: 'var(--proto-card)',
    borderRadius: 14,
    overflow: 'hidden',
    boxShadow: pending && !dimmed ? '0 1px 3px rgba(70,85,212,.08)' : undefined,
    // 5a rejecting = .55 (scheme L192) · 4c rejected seal = .9 (scheme L388)
    ...(dimmed ? { opacity: 0.55 } : rejected ? { opacity: 0.9 } : {}),
  };
}

const FILE_SVG = (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke={MC.run} strokeWidth="1.4" style={{ flex: 'none' }}>
    <path d="M3 1.5h5.5L11.5 4.5V12.5H3z" />
    <path d="M5 6.5h4M5 9h4" />
  </svg>
);

// ── MAskCard — 5b 多问题逐问推进 + 4a 封存 ─────────────────────────────────────

export interface MAskCardProps {
  model: AskCardModel;
  /** Session-local progressive answers (the entity resolves once, at the end). */
  state: AskAnswerState;
  copy: MIntCopy;
  /** Tap an option of the CURRENT single-select question (commits + advances / submits). */
  onPick: (label: string) => void;
  /** Toggle a label of the CURRENT multi-select question. */
  onToggle: (label: string) => void;
  /** Commit the multi-select set of the CURRENT question. */
  onConfirmMulti: () => void;
  /** 自定义… — routes the answer to the composer (5b `点选项，或直接输入回答`). */
  onCustom: () => void;
}

export function MAskCard({ model, state, copy, onPick, onToggle, onConfirmMulti, onCustom }: MAskCardProps): JSX.Element {
  const pending = model.status === 'pending';
  const cur = currentQuestionIndex(model, state);
  const total = model.questions.length;
  const ttlSec = useTtlSeconds(model.ts, pending);
  // Sealed card (4a): tap to expand the full per-question options for review (不可撤销).
  const [expanded, setExpanded] = useState(false);

  const answerOf = (q: AskCardModel['questions'][number]): string | null => q.answer ?? state.answers[q.question] ?? null;

  return (
    <div style={cardShell(pending, false, false)} onClick={pending ? undefined : () => setExpanded((e) => !e)}>
      {/* header */}
      <div style={{ padding: '12px 14px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {pending ? (
            <Pill bg={MC.runBg} fg={MC.run} text={total > 1 ? `${copy.askPill} · ${Math.min(cur + 1, total)}/${total}` : copy.askPill} />
          ) : (
            <Pill bg={MC.doneBg} fg={MC.done} text={copy.answeredPill} />
          )}
          <span style={{ font: `400 10px ${MONO}`, color: MC.faint }}>{model.shortId}</span>
          {pending && ttlSec != null ? (
            <span style={{ marginLeft: 'auto', font: `500 10px ${MONO}`, color: MC.amberText }}>{formatTtl(ttlSec)} {copy.ttlSuffix}</span>
          ) : model.timeLabel ? (
            <span style={{ marginLeft: 'auto', font: `400 10px ${MONO}`, color: MC.faint }}>{model.timeLabel}</span>
          ) : null}
        </div>
      </div>

      {/* questions */}
      {model.questions.map((q, i) => {
        const a = answerOf(q);
        const isCurrent = pending && i === cur;
        const isQueued = pending && i > cur;
        const last = i === total - 1;

        // answered — sealed green row (scheme 5b L242-244 / 4a L297-299)
        if (a != null && !isCurrent) {
          return (
            <div key={q.question} style={{ padding: `10px 14px ${last ? '14px' : '0'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--proto-alt)', border: '1px solid var(--proto-line-2)', borderRadius: 11, padding: '9px 13px' }}>
                <span style={{ width: 16, height: 16, borderRadius: '50%', background: MC.done, color: 'var(--ink-solid-fg)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, flex: 'none' }}>✓</span>
                <span style={{ fontSize: 12, color: MC.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {q.question} → <b style={{ color: MC.ink }}>{a}</b>
                </span>
              </div>
              {/* sealed expand — read-only options review */}
              {!pending && expanded && q.options.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0 0' }}>
                  {q.options.map((o) => (
                    <div key={o.label} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${a.includes(o.label) ? MC.runBorder : 'var(--proto-line-2)'}`, borderRadius: 9, padding: '6px 11px' }}>
                      <span style={{ fontSize: 11.5, color: a.includes(o.label) ? MC.ink : MC.muted }}>{o.label}</span>
                      {a.includes(o.label) && <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: MC.done }}>✓</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }

        // current — expanded options (scheme 5b L245-252)
        if (isCurrent) {
          return (
            <div key={q.question} style={{ padding: `12px 14px ${last ? '14px' : '0'}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ font: `600 10px ${MONO}`, color: MC.run, flex: 'none' }}>Q{i + 1}</span>
                <span style={{ fontSize: 14.5, fontWeight: 600, color: MC.ink, lineHeight: 1.4 }}>{q.question}</span>
                {q.multiSelect && (
                  <span style={{ font: `500 9px ${MONO}`, color: MC.muted, background: MC.gray, padding: '1px 6px', borderRadius: 5, flex: 'none' }}>{copy.multiTag}</span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0 0' }}>
                {q.options.map((o, oi) => {
                  const selected = q.multiSelect && state.selected.includes(o.label);
                  const isDefault = !q.multiSelect && oi === 0;
                  return (
                    <button
                      key={o.label}
                      type="button"
                      onClick={() => (q.multiSelect ? onToggle(o.label) : onPick(o.label))}
                      style={{
                        minHeight: 44,
                        border: `1.5px solid ${selected || isDefault ? MC.run : 'var(--proto-line-3)'}`,
                        borderRadius: 11,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 13px',
                        boxSizing: 'border-box',
                        background: 'var(--proto-card)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        width: '100%',
                      }}
                    >
                      {q.multiSelect && (
                        <span style={{ fontSize: 12, fontWeight: 700, color: selected ? MC.run : MC.faint, flex: 'none' }}>{selected ? '☑' : '☐'}</span>
                      )}
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: MC.ink }}>{o.label}</span>
                      {isDefault ? (
                        <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 600, padding: '1.5px 7px', borderRadius: 999, background: MC.runBg, color: MC.run, flex: 'none' }}>{copy.defaultBadge}</span>
                      ) : o.description ? (
                        <span style={{ marginLeft: 'auto', font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)', flex: 'none' }}>{o.description}</span>
                      ) : null}
                    </button>
                  );
                })}
                {/* 自定义… — free-text via the composer (scheme 5b L250) */}
                <button
                  type="button"
                  onClick={onCustom}
                  style={{ minHeight: 44, border: '1.5px solid var(--proto-line-3)', borderRadius: 11, display: 'flex', alignItems: 'center', padding: '8px 13px', boxSizing: 'border-box', background: 'var(--proto-card)', cursor: 'pointer', textAlign: 'left', width: '100%' }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: MC.sub }}>{copy.customOption}</span>
                </button>
                {/* multi-select commit (13b semantics carried into the 5b skeleton — the mobile
                    scheme draws only single-select; flagged isomorphic completion) */}
                {q.multiSelect && (
                  <button
                    type="button"
                    onClick={onConfirmMulti}
                    disabled={state.selected.length === 0}
                    style={{ height: 44, borderRadius: 11, background: MC.ink, color: 'var(--ink-solid-fg)', border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: state.selected.length === 0 ? 0.45 : 1, width: '100%' }}
                  >
                    {copy.confirm}
                  </button>
                )}
              </div>
            </div>
          );
        }

        // queued — dimmed dashed row (scheme 5b L253-255)
        if (isQueued) {
          return (
            <div key={q.question} style={{ padding: `12px 14px ${last ? '14px' : '0'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px dashed var(--proto-line-3)', borderRadius: 11, padding: '9px 13px', opacity: 0.6 }}>
                <span style={{ font: `600 10px ${MONO}`, color: 'var(--proto-muted-3)', flex: 'none' }}>Q{i + 1}</span>
                <span style={{ fontSize: 12, color: MC.grayInk, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.question}</span>
                <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint, flex: 'none' }}>{copy.queued}</span>
              </div>
            </div>
          );
        }

        // pending question with no local answer on a sealed card (shouldn't happen) — skip
        return null;
      })}

      {/* footer (scheme 5b L256; `来自 X` source has no entity field → omitted, GAP) */}
      {pending && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderTop: '1px solid var(--proto-line-2)', font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)', marginTop: 12 }}>
          <span style={{ marginLeft: 'auto' }}>{copy.askFooter}</span>
        </div>
      )}
    </div>
  );
}

// ── MPlanCard — 6a 薄卡 + 5a 压暗 + 4b/4c 封存 ────────────────────────────────

export interface MPlanCardProps {
  model: PlanCardModel;
  copy: MIntCopy;
  /** 5a rejecting mode — the card dims and its actions collapse while the composer takes over. */
  dimmed?: boolean;
  onApprove: () => void;
  onRejectStart: () => void;
  onOpenRead: () => void;
}

export function MPlanCard({ model, copy, dimmed = false, onApprove, onRejectStart, onOpenRead }: MPlanCardProps): JSX.Element {
  const pending = model.status === 'pending';
  const rejected = model.status === 'rejected';
  const approved = model.status === 'approved';

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      {approved ? (
        <Pill bg={MC.doneBg} fg={MC.done} text={copy.planApprovedPill} />
      ) : rejected ? (
        <Pill bg={MC.gray} fg={MC.grayInk} text={copy.planRejectedPill} />
      ) : (
        <Pill bg={MC.runBg} fg={MC.run} text={copy.planPendingPill} />
      )}
      <span style={{ font: `400 10px ${MONO}`, color: MC.faint }}>ExitPlanMode</span>
      {model.timeLabel && (
        <span style={{ marginLeft: 'auto', font: `400 10px ${MONO}`, color: MC.faint }}>
          {model.timeLabel}{approved ? ` ${copy.approvedBy}` : ''}
        </span>
      )}
    </div>
  );

  const title = (
    <div
      style={{
        fontSize: pending && !dimmed ? 14.5 : 13.5,
        fontWeight: 600,
        color: approved ? MC.sub : rejected ? MC.grayInk : MC.ink,
        lineHeight: 1.4,
        marginTop: 8,
        overflowWrap: 'break-word' as const,
        ...(rejected ? { textDecoration: 'line-through', textDecorationColor: 'var(--proto-line)' } : {}),
      }}
    >
      {model.title}
    </div>
  );

  // 5a rejecting — dimmed card: header + title + compact file row, no buttons (scheme L192-198)
  if (pending && dimmed) {
    return (
      <div style={cardShell(true, true, false)}>
        <div style={{ padding: '11px 14px 12px' }}>
          {header}
          {title}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--proto-alt)', border: '1px solid var(--proto-line-2)', borderRadius: 11, padding: '9px 13px', marginTop: 9 }}>
            <span style={{ font: `500 10.5px ${MONO}`, color: MC.sub, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.filePath ?? ''}</span>
            <span role="button" onClick={onOpenRead} style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: MC.run, flex: 'none', cursor: 'pointer' }}>{copy.viewFullPlan}</span>
          </div>
        </div>
      </div>
    );
  }

  // 6a pending — thin approval card: file row is the main entry (scheme L99-119)
  if (pending) {
    return (
      <div style={cardShell(true, false, false)}>
        <div style={{ padding: '12px 14px 0' }}>
          {header}
          {title}
        </div>
        <div style={{ padding: '11px 14px 12px' }}>
          <div
            role="button"
            onClick={onOpenRead}
            style={{ minHeight: 52, border: '1px solid var(--proto-accent-bg)', background: 'var(--proto-accent-bg)', borderRadius: 11, display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', boxSizing: 'border-box', cursor: 'pointer' }}
          >
            {FILE_SVG}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ font: `500 11px ${MONO}`, color: MC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{model.filePath ?? `${model.lineCount} lines`}</div>
              <div style={{ fontSize: 10, color: 'var(--proto-muted-3)', marginTop: 2 }}>{copy.readHint}</div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: MC.run, flex: 'none' }}>{copy.readLink}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '0 14px 12px' }}>
          <button type="button" onClick={onApprove} style={{ flex: 1.3, height: 44, borderRadius: 11, background: MC.ink, color: 'var(--ink-solid-fg)', border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>{copy.approve}</button>
          <button type="button" onClick={onRejectStart} style={{ flex: 1, height: 44, borderRadius: 11, border: '1.5px solid var(--proto-line-3)', background: 'var(--proto-card)', color: MC.ink, fontSize: 14, fontWeight: 600, boxSizing: 'border-box', cursor: 'pointer' }}>{copy.reject}</button>
        </div>
        {/* footer — `来自 X` source has no entity field → left slot omitted (GAP) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderTop: '1px solid var(--proto-line-2)', font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)' }}>
          <span style={{ marginLeft: 'auto', color: MC.faint }}>{copy.approveHint}</span>
        </div>
      </div>
    );
  }

  // 4b approved / 4c rejected — sealed in place
  return (
    <>
      <div style={cardShell(false, false, rejected)}>
        <div style={{ padding: '11px 14px 12px' }}>
          {header}
          {title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderTop: '1px solid var(--proto-line-2)', font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)' }}>
          {model.filePath && <span style={{ color: MC.run, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.filePath}</span>}
          {rejected && <span>{copy.rewriteNote}</span>}
          <span role="button" onClick={onOpenRead} style={{ marginLeft: 'auto', color: MC.run, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
            {rejected ? copy.viewOriginalPlan : copy.viewFullPlan}
          </span>
        </div>
      </div>
      {/* 4c — the reject feedback enters the stream as the user bubble (real result.feedback) */}
      {rejected && model.feedback && (
        <div style={{ alignSelf: 'flex-end', maxWidth: '82%', background: MC.ink, color: 'var(--ink-solid-fg)', borderRadius: '16px 16px 4px 16px', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
          {model.feedback}
        </div>
      )}
    </>
  );
}
