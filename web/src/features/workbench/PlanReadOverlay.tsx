// Desktop plan reading overlay — the target of every 13c 阅读 › / 查看计划 › affordance. The
// desktop scheme defines no reading page (13c footnote: 「卡片只负责路由 + 批/驳，全文在阅读页看」;
// the page itself is only drawn as mobile 6b) → this ports the 6b structure (header meta + read
// progress + markdown body + resident action bar / sealed stamp) into the desktop overlay chrome
// (centered card over a scrim, like the approvals overlay). HONEST ADDITION — flagged, not 1:1.
import { useEffect, useRef, useState } from 'react';
import { ChatMarkdown } from './ChatMarkdown';
import type { PlanCardModel } from './interaction-vm';
import { readProgressPct, planStatusLabel, planMetaLine, approveSubLabel } from './plan-read-vm';
import type { DIntCopy } from './InteractionCards';

const mono = "'IBM Plex Mono',monospace";

export interface PlanReadOverlayProps {
  model: PlanCardModel;
  copy: DIntCopy;
  lang?: 'zh' | 'en';
  onClose: () => void;
  onApprove: () => void;
  /** 请求修改 — closes the overlay and opens the card's feedback box (13c middle column). */
  onRequestChanges: () => void;
}

export function PlanReadOverlay({ model, copy, lang = 'zh', onClose, onApprove, onRequestChanges }: PlanReadOverlayProps): JSX.Element {
  const pending = model.status === 'pending';
  const [pct, setPct] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const p = readProgressPct(el.scrollTop, el.clientHeight, el.scrollHeight);
    setPct((prev) => Math.max(prev, p));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const statusLabel = planStatusLabel(model.status, lang);
  const approveSub = approveSubLabel(pct, lang);
  const stamp =
    model.status === 'approved'
      ? { text: `${copy.planApprovedPill}${model.timeLabel ? ` · ${model.timeLabel} ${copy.approvedBy}` : ''}`, fg: '#23854F', bg: '#E9F4EE' }
      : model.status === 'rejected'
        ? { text: `${copy.planRejectedPill}${model.timeLabel ? ` · ${model.timeLabel}` : ''}`, fg: '#8A93A2', bg: '#F1F2F5' }
        : { text: statusLabel, fg: '#8A93A2', bg: '#F1F2F5' };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(16,20,28,.42)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 760, maxWidth: 'calc(100vw - 64px)', height: 'min(720px, calc(100vh - 80px))', background: '#fff', borderRadius: 14, boxShadow: '0 24px 64px rgba(16,24,40,.28)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        {/* header — title · meta · status pill · ✕ · progress bar (6b header, desktop chrome) */}
        <div style={{ flex: 'none', padding: '14px 18px 12px', borderBottom: '1px solid #EFF1F5' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 650, color: '#191C22', letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{model.title}</div>
              <div style={{ font: `400 10px ${mono}`, color: '#8A93A2', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {planMetaLine(model.filePath, model.lineCount, statusLabel, lang)}
              </div>
            </div>
            {pending ? (
              <span style={{ font: `600 9.5px ${mono}`, color: '#8A5B06', background: '#F7ECCE', padding: '2.5px 9px', borderRadius: 999, flex: 'none' }}>{copy.planPendingPill}</span>
            ) : (
              <span style={{ font: `600 9.5px ${mono}`, color: stamp.fg, background: stamp.bg, padding: '2.5px 9px', borderRadius: 999, flex: 'none' }}>{statusLabel}</span>
            )}
            <span
              role="button"
              aria-label="Close"
              onClick={onClose}
              style={{ width: 26, height: 26, borderRadius: 8, border: '1px solid #E7E9EE', background: '#FBFBFC', color: '#5B6472', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, cursor: 'pointer', flex: 'none' }}
            >
              ✕
            </span>
          </div>
          {pending && (
            <div style={{ height: 3, borderRadius: 999, background: '#E3E5EA', overflow: 'hidden', marginTop: 10 }}>
              <div style={{ width: `${pct}%`, height: '100%', background: '#4655D4' }} />
            </div>
          )}
        </div>

        {/* body — the real plan snapshot as markdown */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <div ref={scrollRef} onScroll={onScroll} style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: '18px 22px 28px', boxSizing: 'border-box' }}>
            {model.timeLabel && <div style={{ font: `400 10px ${mono}`, color: '#B6BDC9', paddingBottom: 8 }}>{model.timeLabel}</div>}
            <div style={{ fontSize: 13.5, lineHeight: 1.7, color: '#22262E' }}>
              <ChatMarkdown text={model.planContent} />
            </div>
            {model.status === 'rejected' && model.feedback && (
              <div style={{ marginTop: 16, border: '1px solid #EFDDB0', background: '#FDF9F0', borderRadius: 10, padding: '10px 13px' }}>
                <div style={{ font: `600 10px ${mono}`, color: '#A96B0B', paddingBottom: 4 }}>{copy.feedbackHint.split(' · ')[0]}</div>
                <div style={{ fontSize: 12.5, lineHeight: 1.6, color: '#6B5A1E', whiteSpace: 'pre-wrap' }}>{model.feedback}</div>
              </div>
            )}
          </div>
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 48, background: 'linear-gradient(180deg,rgba(255,255,255,0),#fff)', pointerEvents: 'none' }} />
        </div>

        {/* resident action bar (pending) / status stamp (sealed) */}
        <div style={{ flex: 'none', borderTop: '1px solid #EFF1F5', padding: '12px 18px' }}>
          {pending ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10.5, color: '#98A1B0', flex: 1 }}>{copy.approveHint}</span>
              <span
                role="button"
                onClick={onRequestChanges}
                style={{ fontSize: 12, fontWeight: 600, border: '1px solid #D9DCE3', background: '#fff', color: '#191C22', padding: '7px 14px', borderRadius: 8, cursor: 'pointer', flex: 'none' }}
              >
                {copy.requestChanges}
              </span>
              <span
                role="button"
                onClick={onApprove}
                style={{ fontSize: 12, fontWeight: 600, borderRadius: 8, padding: '8px 18px', color: '#fff', background: '#191C22', cursor: 'pointer', flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}
              >
                <span>{copy.approvePlan}</span>
                {approveSub && <span style={{ font: `400 9px ${mono}`, color: 'rgba(255,255,255,.55)' }}>{approveSub}</span>}
              </span>
            </div>
          ) : (
            <div style={{ height: 36, borderRadius: 9, background: stamp.bg, color: stamp.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, fontWeight: 600 }}>
              {stamp.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
