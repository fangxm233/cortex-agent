// input:  PlanCardModel, ChatMarkdown, plan reading labels
// output: PlanReadOverlay
// pos:    Plan reading overlay with persistent approval actions
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useEffect, useRef, useState } from 'react';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import type { PlanCardModel } from './interaction-vm';
import { readProgressPct, planStatusLabel, planMetaLine, approveSubLabel } from './plan-read-vm';
import type { DIntCopy } from './InteractionCards';

const mono = "'IBM Plex Mono',monospace";
const focusClass = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent';

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
      ? { text: `${copy.planApprovedPill}${model.timeLabel ? ` · ${model.timeLabel} ${copy.approvedBy}` : ''}`, fg: 'var(--proto-success)', bg: 'var(--proto-success-bg)' }
      : model.status === 'rejected'
        ? { text: `${copy.planRejectedPill}${model.timeLabel ? ` · ${model.timeLabel}` : ''}`, fg: 'var(--proto-muted)', bg: 'var(--proto-gray)' }
        : { text: statusLabel, fg: 'var(--proto-muted)' , bg: 'var(--proto-gray)' };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay-scrim-medium)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        role="dialog"
        aria-label={model.title}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 760, maxWidth: 'calc(100vw - 64px)', height: 'min(720px, calc(100vh - 80px))', background: 'var(--material-overlay-bg)', backdropFilter: 'var(--glass-filter)', WebkitBackdropFilter: 'var(--glass-filter)', borderRadius: 'var(--r-float)', boxShadow: 'var(--material-overlay-shadow)' , display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        {/* header — title · meta · status pill · ✕ · progress bar (6b header, desktop chrome) */}
        <div style={{ flex: 'none', padding: '14px 18px 12px', borderBottom: '1px solid var(--proto-line-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--proto-ink)', letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{model.title}</div>
              <div style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' , marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {planMetaLine(model.filePath, model.lineCount, statusLabel, lang)}
              </div>
            </div>
            {pending ? (
              <span style={{ font: `600 11px ${mono}`, color: 'var(--proto-amber-fg)' , background: 'var(--pill-waiting-bg)', padding: '2.5px 9px', borderRadius: 'var(--r-pill)', flex: 'none' }}>{copy.planPendingPill}</span>
            ) : (
              <span style={{ font: `600 11px ${mono}`, color: stamp.fg, background: stamp.bg, padding: '2.5px 9px', borderRadius: 'var(--r-pill)', flex: 'none' }}>{statusLabel}</span>
            )}
            <button
              type="button"
              className={focusClass}
              aria-label="Close"
              onClick={onClose}
              style={{ width: 26, height: 26, borderRadius: 'var(--r-chip)', border: '1px solid var(--proto-line)', background: 'var(--proto-rail)', color: 'var(--proto-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, cursor: 'pointer', flex: 'none' }}
            >
              ✕
            </button>
          </div>
          {pending && (
            <div style={{ height: 3, borderRadius: 'var(--r-pill)', background: 'var(--proto-line)', overflow: 'hidden', marginTop: 10 }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--proto-accent)' }} />
            </div>
          )}
        </div>

        {/* Keep the long-form reading surface stable; chrome shares the glass shell. */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--proto-card)' }}>
          <div ref={scrollRef} onScroll={onScroll} style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: '18px 22px 28px', boxSizing: 'border-box' }}>
            {model.timeLabel && <div style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' , paddingBottom: 8 }}>{model.timeLabel}</div>}
            <div style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--proto-ink-2)' }}>
              <ChatMarkdown text={model.planContent} />
            </div>
            {model.status === 'rejected' && model.feedback && (
              <div style={{ marginTop: 16, border: '1px solid var(--proto-amber-border)', background: 'var(--proto-amber-bg)', borderRadius: 'var(--r-card)', padding: '10px 13px' }}>
                <div style={{ font: `600 11px ${mono}`, color: 'var(--proto-amber-text)' , paddingBottom: 4 }}>{copy.feedbackHint.split(' · ')[0]}</div>
                <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--proto-amber-fg)', whiteSpace: 'pre-wrap' }}>{model.feedback}</div>
              </div>
            )}
          </div>
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 48, background: 'linear-gradient(180deg,var(--proto-card-transparent),var(--proto-card))', pointerEvents: 'none' }} />
        </div>

        {/* resident action bar (pending) / status stamp (sealed) */}
        <div style={{ flex: 'none', background: 'transparent', borderTop: '1px solid var(--proto-line-2)', padding: '12px 18px' }}>
          {pending ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--proto-muted)', flex: 1 }}>{copy.approveHint}</span>
              <button
                type="button"
                className={focusClass}
                onClick={onRequestChanges}
                style={{ fontSize: 12, fontWeight: 600, border: '1px solid var(--proto-line-3)', background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', color: 'var(--proto-ink)', padding: '7px 14px', borderRadius: 'var(--r-control)', cursor: 'pointer', flex: 'none' }}
              >
                {copy.requestChanges}
              </button>
              <button
                type="button"
                className={focusClass}
                onClick={onApprove}
                style={{ fontSize: 12, fontWeight: 600, borderRadius: 'var(--r-control)', padding: '8px 18px', color: 'var(--ink-solid-fg)', background: 'var(--proto-ink)', cursor: 'pointer', flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}
              >
                <span>{copy.approvePlan}</span>
                {approveSub && <span style={{ font: `400 11px ${mono}`, color: 'var(--ink-solid-fg)' }}>{approveSub}</span>}
              </button>
            </div>
          ) : (
            <div style={{ height: 36, borderRadius: 'var(--r-control)', background: stamp.bg, color: stamp.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, fontWeight: 600 }}>
              {stamp.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
