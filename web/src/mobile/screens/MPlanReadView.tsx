import { useRef, useState } from 'react';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { useVocabOptional } from '@/i18n';
import { MBackChevron, MC, M_NUM } from '@/mobile/ui/kit';
import type { PlanCardModel } from '@/features/session/interaction/interaction-vm';
import { readProgressPct, planStatusLabel, planMetaLine } from '@/features/session/interaction/plan-read-vm';

export interface MPlanReadViewProps {
  model: PlanCardModel;
  onBack: () => void;
  onApprove: () => void;
  /** 驳回并反馈 — routes back to the chat armed in 5a reject mode. */
  onReject: () => void;
}

export function MPlanReadView({ model, onBack, onApprove, onReject }: MPlanReadViewProps): JSX.Element {
  const pending = model.status === 'pending';
  const vocab = useVocabOptional();
  // Furthest-seen reading progress, displayed in the header progress bar.
  const [pct, setPct] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const p = readProgressPct(el.scrollTop, el.clientHeight, el.scrollHeight);
    setPct((prev) => Math.max(prev, p));
  };

  const statusLabel = planStatusLabel(model.status, vocab);

  const stamp =
    model.status === 'approved' ? { text: `${vocab.ixPlanApprovedPill}${model.timeLabel ? ` · ${model.timeLabel} ${vocab.ixApprovedBy}` : ''}`, fg: MC.done, bg: MC.doneBg }
    : model.status === 'rejected' ? { text: `${vocab.ixPlanRejectedPill}${model.timeLabel ? ` · ${model.timeLabel}` : ''}`, fg: MC.grayInk, bg: MC.gray }
    : model.status === 'cancelled' ? { text: vocab.ixCancelled, fg: MC.grayInk, bg: MC.gray }
    : { text: vocab.ixExpired, fg: MC.grayInk, bg: MC.gray };

  return (
    <div
      data-screen-label="6b plan read"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', position: 'relative' }}
    >
      {/* header — back · title · meta · status pill · progress bar (scheme L136-146) */}
      <div style={{ flex: 'none', padding: '8px 14px 10px 8px', paddingTop: 'calc(8px + env(safe-area-inset-top))', borderBottom: `1px solid ${MC.hairline}`, background: MC.glassRaised }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            aria-label={vocab.back}
            onClick={onBack}
            style={{ border: 'none', background: 'transparent', color: MC.ink, padding: 0, margin: 0, cursor: 'pointer', flex: 'none', minHeight: 44, minWidth: 44, display: 'grid', placeItems: 'center' }}
          >
            <MBackChevron />
          </button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15.5, fontWeight: 620, color: MC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{model.title}</div>
            {/* The full path is the one piece of code on the line, so only it takes the code face. */}
            <div style={{ fontSize: 12.5, color: MC.muted, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...M_NUM }}>
              {model.filePath && <span style={{ font: '400 11.5px var(--font-code)' }}>{model.filePath}</span>}
              {model.filePath ? ' · ' : ''}{planMetaLine(null, model.lineCount, statusLabel, vocab)}
            </div>
          </div>
          {pending ? (
            <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: MC.amberInk, background: MC.amberBg, padding: '2px 8px', borderRadius: 'var(--r-pill)', flex: 'none' }}>{vocab.ixPlanPending}</span>
          ) : (
            <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: stamp.fg, background: stamp.bg, padding: '2px 8px', borderRadius: 'var(--r-pill)', flex: 'none' }}>{statusLabel}</span>
          )}
        </div>
        {pending && (
          <div style={{ height: 3, borderRadius: 'var(--r-pill)', background: 'var(--proto-line)', overflow: 'hidden', marginTop: 9 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: MC.run }} />
          </div>
        )}
      </div>

      {/* body — white reading surface, real plan markdown (scheme L147-158) */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--proto-card)' }}>
        <div ref={scrollRef} onScroll={onScroll} style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: '16px 18px 24px', boxSizing: 'border-box' }}>
          {/* `由 X 生成` source line has no entity field (GAP) — only the real row time shows. */}
          {model.timeLabel && <div style={{ fontSize: 12, color: MC.muted, paddingBottom: 8, ...M_NUM }}>{model.timeLabel}</div>}
          <div style={{ fontSize: 14.5, lineHeight: 1.7, color: MC.body, overflowWrap: 'anywhere' }}>
            <ChatMarkdown text={model.planContent} />
          </div>
          {model.status === 'rejected' && model.feedback && (
            <div style={{ marginTop: 16, border: `1px solid ${MC.amberBorder}`, background: MC.amberCard, borderRadius: 'var(--r-control)', padding: '10px 13px' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: MC.amberText, paddingBottom: 4 }}>{vocab.ixRejectFeedback}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--proto-amber-fg)', whiteSpace: 'pre-wrap' }}>{model.feedback}</div>
            </div>
          )}
        </div>
        {/* bottom fade into the action bar (scheme L158) */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56, background: 'linear-gradient(180deg,var(--proto-card-transparent),var(--proto-card))', pointerEvents: 'none' }} />
      </div>

      {/* resident action bar (pending) / status stamp (sealed) — scheme L160-165 */}
      <div style={{ flex: 'none', background: 'var(--proto-card)', borderTop: '1px solid var(--proto-line-2)', padding: '10px 14px', paddingBottom: 'calc(14px + env(safe-area-inset-bottom))' }}>
        {pending ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={onReject}
              style={{ flex: 1, height: 48, borderRadius: 'var(--r-control)', border: '1px solid var(--proto-line-3)', background: 'var(--material-control-bg)', color: MC.ink, fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600, boxSizing: 'border-box', cursor: 'pointer' }}
            >
              {vocab.ixRejectNote}
            </button>
            <button
              type="button"
              onClick={onApprove}
              style={{ flex: 1, height: 48, borderRadius: 'var(--r-control)', background: MC.inkSolid, color: MC.inkSolidFg, border: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, cursor: 'pointer' }}
            >
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600 }}>{vocab.ixApproveRun}</span>
            </button>
          </div>
        ) : (
          <div style={{ minHeight: 48, padding: '8px 12px', boxSizing: 'border-box', overflowWrap: 'anywhere', borderRadius: 'var(--r-control)', background: stamp.bg, color: stamp.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13.5, fontWeight: 600 }}>
            {stamp.text}
          </div>
        )}
      </div>
    </div>
  );
}
