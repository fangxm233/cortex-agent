// @ds-adherence-ignore -- 6b 计划全文阅读页, chrome extracted 1:1 from scheme-mobile.dc.html
// sec-6 L132-167. Raw px/hex by design §8.3. Renders the REAL plan snapshot markdown with a
// scroll-progress bar; the resident bottom action bar approves/rejects while pending and turns
// into a read-only status stamp after sealing. Pure + presentational: the container
// (MPlanReadScreen) owns data + mutations. Honest gap: the `由 X 生成` source line has no entity
// field → only the real row time is shown.
import { useRef, useState } from 'react';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import { MC, MONO } from '@/mobile/ui/kit';
import type { PlanCardModel } from '@/features/workbench/interaction-vm';
import { readProgressPct, planStatusLabel, planMetaLine, approveSubLabel } from '@/features/workbench/plan-read-vm';

export interface MPlanReadCopy {
  lang: 'zh' | 'en';
  pendingPill: string;
  approvedStamp: string;
  rejectedStamp: string;
  cancelledStamp: string;
  expiredStamp: string;
  approve: string;
  reject: string;
  approvedBy: string;
  feedbackLabel: string;
}

export const M_PLAN_READ_COPY: { zh: MPlanReadCopy; en: MPlanReadCopy } = {
  zh: {
    lang: 'zh',
    pendingPill: '计划待批',
    approvedStamp: '✓ 计划已批准',
    rejectedStamp: '已驳回',
    cancelledStamp: '已取消',
    expiredStamp: '已过期',
    approve: '批准并执行',
    reject: '驳回并反馈',
    approvedBy: '由你批准',
    feedbackLabel: '驳回反馈',
  },
  en: {
    lang: 'en',
    pendingPill: 'Plan pending',
    approvedStamp: '✓ Plan approved',
    rejectedStamp: 'Rejected',
    cancelledStamp: 'Cancelled',
    expiredStamp: 'Expired',
    approve: 'Approve & run',
    reject: 'Reject with note',
    approvedBy: 'approved by you',
    feedbackLabel: 'Reject feedback',
  },
};

export interface MPlanReadViewProps {
  model: PlanCardModel;
  copy: MPlanReadCopy;
  onBack: () => void;
  onApprove: () => void;
  /** 驳回并反馈 — routes back to the chat armed in 5a reject mode. */
  onReject: () => void;
}

export function MPlanReadView({ model, copy, onBack, onApprove, onReject }: MPlanReadViewProps): JSX.Element {
  const pending = model.status === 'pending';
  // Furthest-seen reading progress (6b: main button shows 已读 N% until read to the bottom).
  const [pct, setPct] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const p = readProgressPct(el.scrollTop, el.clientHeight, el.scrollHeight);
    setPct((prev) => Math.max(prev, p));
  };

  const statusLabel = planStatusLabel(model.status, copy.lang);
  const approveSub = approveSubLabel(pct, copy.lang);

  const stamp =
    model.status === 'approved' ? { text: `${copy.approvedStamp}${model.timeLabel ? ` · ${model.timeLabel} ${copy.approvedBy}` : ''}`, fg: MC.done, bg: MC.doneBg }
    : model.status === 'rejected' ? { text: `${copy.rejectedStamp}${model.timeLabel ? ` · ${model.timeLabel}` : ''}`, fg: MC.grayInk, bg: MC.gray }
    : model.status === 'cancelled' ? { text: copy.cancelledStamp, fg: MC.grayInk, bg: MC.gray }
    : { text: copy.expiredStamp, fg: MC.grayInk, bg: MC.gray };

  return (
    <div
      data-screen-label="6b 计划全文阅读页"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', position: 'relative', background: MC.canvas }}
    >
      {/* header — back · title · meta · status pill · progress bar (scheme L136-146) */}
      <div style={{ flex: 'none', padding: '8px 14px 10px', paddingTop: 'calc(8px + env(safe-area-inset-top))', borderBottom: `1px solid ${MC.hairline}`, background: MC.canvas }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <button
            type="button"
            aria-label="Back"
            onClick={onBack}
            style={{ border: 'none', background: 'transparent', color: MC.run, fontSize: 15, lineHeight: 1, padding: '0 2px', margin: 0, cursor: 'pointer', flex: 'none', minHeight: 44, minWidth: 30, display: 'flex', alignItems: 'center' }}
          >
            ‹
          </button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{model.title}</div>
            <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {planMetaLine(model.filePath, model.lineCount, statusLabel, copy.lang)}
            </div>
          </div>
          {pending ? (
            <span style={{ marginLeft: 'auto', font: `600 9.5px ${MONO}`, color: MC.amberInk, background: MC.amberBg, padding: '2px 8px', borderRadius: 999, flex: 'none' }}>{copy.pendingPill}</span>
          ) : (
            <span style={{ marginLeft: 'auto', font: `600 9.5px ${MONO}`, color: stamp.fg, background: stamp.bg, padding: '2px 8px', borderRadius: 999, flex: 'none' }}>{statusLabel}</span>
          )}
        </div>
        {pending && (
          <div style={{ height: 3, borderRadius: 999, background: 'var(--proto-line)', overflow: 'hidden', marginTop: 9 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: MC.run }} />
          </div>
        )}
      </div>

      {/* body — white reading surface, real plan markdown (scheme L147-158) */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--proto-card)' }}>
        <div ref={scrollRef} onScroll={onScroll} style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: '16px 18px 24px', boxSizing: 'border-box' }}>
          {/* `由 X 生成` source line has no entity field (GAP) — only the real row time shows. */}
          {model.timeLabel && <div style={{ font: `400 10px ${MONO}`, color: MC.faint, paddingBottom: 8 }}>{model.timeLabel}</div>}
          <div style={{ fontSize: 13, lineHeight: 1.7, color: MC.body }}>
            <ChatMarkdown text={model.planContent} />
          </div>
          {model.status === 'rejected' && model.feedback && (
            <div style={{ marginTop: 16, border: `1px solid ${MC.amberBorder}`, background: MC.amberCard, borderRadius: 11, padding: '10px 13px' }}>
              <div style={{ font: `600 10px ${MONO}`, color: MC.amberText, paddingBottom: 4 }}>{copy.feedbackLabel}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--proto-amber-fg)', whiteSpace: 'pre-wrap' }}>{model.feedback}</div>
            </div>
          )}
        </div>
        {/* bottom fade into the action bar (scheme L158) */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56, background: 'linear-gradient(180deg,rgba(255,255,255,0),var(--proto-card))', pointerEvents: 'none' }} />
      </div>

      {/* resident action bar (pending) / status stamp (sealed) — scheme L160-165 */}
      <div style={{ flex: 'none', background: 'var(--proto-card)', borderTop: '1px solid var(--proto-line-2)', padding: '10px 14px', paddingBottom: 'calc(14px + env(safe-area-inset-bottom))' }}>
        {pending ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onApprove}
              style={{ flex: 1.3, height: 48, borderRadius: 13, background: MC.ink, color: 'var(--ink-solid-fg)', border: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, cursor: 'pointer' }}
            >
              <span style={{ fontSize: 14, fontWeight: 600 }}>{copy.approve}</span>
              {approveSub && <span style={{ font: `400 9px ${MONO}`, color: 'rgba(255,255,255,.55)' }}>{approveSub}</span>}
            </button>
            <button
              type="button"
              onClick={onReject}
              style={{ flex: 1, height: 48, borderRadius: 13, border: '1.5px solid var(--proto-line-3)', background: 'var(--proto-card)', color: MC.ink, fontSize: 14, fontWeight: 600, boxSizing: 'border-box', cursor: 'pointer' }}
            >
              {copy.reject}
            </button>
          </div>
        ) : (
          <div style={{ height: 48, borderRadius: 13, background: stamp.bg, color: stamp.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13.5, fontWeight: 600 }}>
            {stamp.text}
          </div>
        )}
      </div>
    </div>
  );
}
