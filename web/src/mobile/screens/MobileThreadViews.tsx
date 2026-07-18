// Presentational views for the 5b 移动端线程 screen — 1:1 from scheme.dc.html L3005–3108.
// Exact inline styles / px / hex / font / weight reproduced verbatim (§8.3 raw-value-first; the mobile
// palette is not in the light `proto.*` token set). All structural L2/L3/dot/level/depth/pill RULES
// are REUSED from the desktop helpers (right-panel-vm / nested-threads / thread-steps) — this file only
// re-authors the mobile chrome. Prop-driven so the containers stay thin and these render-test cleanly.
import { useState } from 'react';
import type {
  ThreadInfo,
  ThreadDetail,
  ThreadStepDetail,
  ThreadChildNode,
} from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';
import type { Scope } from '@/features/workbench/scope';
import { stepDotKind, threadPill, depthInfo, formatCost } from '@/features/workbench/right-panel-vm';
import { dispatchesForStep } from '@/features/thread/thread-steps';
import { nodeLevel } from '@/features/thread/nested-threads';
import {
  budgetBand as buildBand,
  type BudgetBand,
  threadMetaLineZh,
  threadSubLine,
  stepTimeLabel,
  pillLabel,
} from './mobile-thread-vm';

export { buildBand as budgetBand };

const MONO = "'IBM Plex Mono',monospace";

// 3-node graph icon (scheme L3029). Color set by the caller via `stroke`.
function NodeIcon({ size = 13, color }: { size?: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.6}>
      <circle cx="3.5" cy="3" r="1.9" />
      <circle cx="3.5" cy="11" r="1.9" />
      <circle cx="10.5" cy="7" r="1.9" />
      <path d="M3.5 5v4M5.4 3.7 8.7 6.1M5.4 10.3 8.7 7.9" />
    </svg>
  );
}

// ── Header (title + Active/History segment + today budget band) — scheme L3010–3023 ──
export function MobileThreadsHeader({
  vocab,
  segment,
  activeCount,
  band,
  onSegment,
}: {
  vocab: Vocab;
  segment: Scope;
  activeCount: number;
  band: BudgetBand;
  onSegment: (s: Scope) => void;
}) {
  return (
    <div style={{ flex: 'none', padding: '6px 14px 10px', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-alt)' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--proto-ink)', letterSpacing: '-.02em' }}>{vocab.threads}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', background: 'var(--proto-line)', borderRadius: 8, padding: 2 }}>
          <span
            onClick={() => onSegment('active')}
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: segment === 'active' ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
              background: segment === 'active' ? 'var(--proto-card)' : 'transparent',
              borderRadius: 6,
              padding: '4px 12px',
              boxShadow: segment === 'active' ? '0 1px 2px rgba(16,24,40,.06)' : 'none',
              cursor: 'pointer',
            }}
          >
            {vocab.active} {activeCount}
          </span>
          <span
            onClick={() => onSegment('history')}
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: segment === 'history' ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
              background: segment === 'history' ? 'var(--proto-card)' : 'transparent',
              borderRadius: 6,
              padding: '4px 12px',
              boxShadow: segment === 'history' ? '0 1px 2px rgba(16,24,40,.06)' : 'none',
              cursor: 'pointer',
            }}
          >
            {vocab.history}
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--proto-muted-2)' }}>{vocab.today}</span>
        <div style={{ flex: 1, height: 4, borderRadius: 999, background: 'var(--proto-line)', overflow: 'hidden' }}>
          <div style={{ width: `${band.pct}%`, height: '100%', background: 'var(--proto-accent)' }} />
        </div>
        <span style={{ font: `500 10px ${MONO}`, color: 'var(--proto-ink)' }}>
          {band.numerator} / {band.denominator}
        </span>
      </div>
    </div>
  );
}

// ── Step dot + tail (scheme L3037/3039/3041/3070) ──
function StepDot({ kind, hasTail }: { kind: 'done' | 'running' | 'pending'; hasTail: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {kind === 'done' && (
        <span style={{ width: 13, height: 13, borderRadius: '50%', background: 'var(--proto-success-bg)', color: 'var(--proto-success)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 7.5, fontWeight: 700, flex: 'none' }}>✓</span>
      )}
      {kind === 'running' && (
        <span style={{ width: 13, height: 13, borderRadius: '50%', background: 'var(--proto-accent)', flex: 'none', boxShadow: '0 0 0 3px var(--proto-accent-bg)', animation: 'cxpulse 1.6s ease-in-out infinite' }} />
      )}
      {kind === 'pending' && (
        <span style={{ width: 13, height: 13, borderRadius: '50%', border: '1.5px solid var(--proto-line-3)', boxSizing: 'border-box', flex: 'none' }} />
      )}
      {hasTail && <span style={{ flex: 1, width: 1.5, background: 'var(--proto-line-2)', margin: '3px 0' }} />}
    </div>
  );
}

// ── L3 drill row: "name L3 ● 打开 ›" (scheme L3054–3059) ──
function MobileDrillRow({
  node,
  vocab,
  onDrill,
}: {
  node: ThreadChildNode;
  vocab: Vocab;
  onDrill: (n: ThreadChildNode) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--proto-line-2)', background: 'var(--proto-card)', borderRadius: 8, padding: '7px 9px', marginTop: 5 }}>
      <span style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-ink-2)' }}>{node.templateName ?? node.id}</span>
      <span style={{ font: `400 8.5px ${MONO}`, color: 'var(--proto-faint)' }}>L{nodeLevel(node)}</span>
      {node.status === 'running' && (
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--proto-accent)', animation: 'cxpulse 1.6s ease-in-out infinite' }} />
      )}
      <span
        onClick={() => onDrill(node)}
        style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}
      >
        {vocab.open} ›
      </span>
    </div>
  );
}

// ── L2 sub-card: expands in place (▾) to its L3 drill rows; collapsed (▸) header only (scheme L3045–3067) ──
function MobileSubCard({
  node,
  vocab,
  onDrill,
}: {
  node: ThreadChildNode;
  vocab: Vocab;
  onDrill: (n: ThreadChildNode) => void;
}) {
  const [expanded, setExpanded] = useState(node.status === 'running');
  const pill = threadPill(node.status);
  const pillText = pillLabel(node.status, vocab);
  const running = node.status === 'running';
  return (
    <div style={{ border: `1px solid ${running ? 'var(--proto-accent-bg)' : 'var(--proto-line-2)'}`, background: running ? 'var(--proto-rail)' : 'var(--proto-rail)', borderRadius: 9 }}>
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', cursor: 'pointer' }}
      >
        <span style={{ color: running ? 'var(--proto-muted-2)' : 'var(--proto-faint)', fontSize: 8.5 }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ font: `600 11px ${MONO}`, color: running ? 'var(--proto-ink)' : 'var(--proto-muted)' }}>{node.templateName ?? node.id}</span>
        <span style={{ font: `400 8.5px ${MONO}`, color: 'var(--proto-faint)' }}>L{nodeLevel(node)}</span>
        <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 600, padding: '1.5px 7px', borderRadius: 999, background: pill.bg, color: pill.fg }}>
          {pillText}
        </span>
      </div>
      {expanded && node.children.length > 0 && (
        <div style={{ padding: '0 10px 8px 24px' }}>
          {node.children.map((ch) => (
            <MobileDrillRow key={ch.id} node={ch} vocab={vocab} onDrill={onDrill} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── One pipeline step row: dot column + content; the running step expands its L2 sub-cards ──
function MobileStepRow({
  step,
  isLast,
  detail,
  now,
  vocab,
  onDrill,
}: {
  step: ThreadStepDetail;
  isLast: boolean;
  detail: ThreadDetail;
  now: number;
  vocab: Vocab;
  onDrill: (n: ThreadChildNode) => void;
}) {
  const kind = stepDotKind(step);
  const active = kind === 'running';
  // Reuse the desktop join: a dispatch bound to this step surfaces its machine inline (GAP-gpu honest —
  // ThreadStepDetail has no machine field; shown only when a real dispatch is joined).
  const machine = dispatchesForStep(detail, step).map((d) => d.machine).find(Boolean) ?? null;
  const subthreads = active ? detail.children : [];
  const time = stepTimeLabel(step, now);
  const label = step.stage ?? `${vocab.step} ${step.stepIndex + 1}`;
  return (
    <>
      <StepDot kind={kind} hasTail={!isLast} />
      <div style={{ paddingBottom: isLast ? 4 : 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <span style={{ fontSize: 11.5, fontWeight: active ? 600 : 500, color: active ? 'var(--proto-ink)' : kind === 'done' ? 'var(--proto-muted)' : 'var(--proto-faint)' }}>
            {label}
          </span>
          {machine && <span style={{ fontSize: 9, color: 'var(--proto-muted-3)', marginLeft: 6 }}>{machine} ✓</span>}
          {time && (
            <span style={{ marginLeft: 'auto', font: `400 9px ${MONO}`, color: active ? 'var(--proto-accent)' : 'var(--proto-faint)' }}>{time}</span>
          )}
        </div>
        {subthreads.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {subthreads.map((n) => (
              <MobileSubCard key={n.id} node={n} vocab={vocab} onDrill={onDrill} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Step tree grid (scheme L3036) — reused by the expanded card + the drill view ──
export function MobileStepTree({
  detail,
  now,
  vocab,
  onDrill,
}: {
  detail: ThreadDetail;
  now: number;
  vocab: Vocab;
  onDrill: (n: ThreadChildNode) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '15px 1fr', columnGap: 8 }}>
      {detail.steps.map((step) => (
        <MobileStepRow
          key={step.stepIndex}
          step={step}
          isLast={step.stepIndex === detail.steps.length - 1}
          detail={detail}
          now={now}
          vocab={vocab}
          onDrill={onDrill}
        />
      ))}
    </div>
  );
}

// ── One thread card: collapsed (Card B) or expanded (Card A) purely from props ──
export function MobileThreadCardView({
  thread,
  detail,
  now,
  vocab,
  expanded,
  onToggle,
  onCancel,
  onDrill,
  loading,
}: {
  thread: ThreadInfo;
  detail?: ThreadDetail;
  now: number;
  vocab: Vocab;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onDrill: (n: ThreadChildNode) => void;
  loading?: boolean;
}) {
  const pill = threadPill(thread.status);
  const pillText = pillLabel(thread.status, vocab);
  const showBody = expanded && !!detail;

  if (!showBody) {
    // Card B — collapsed row (scheme L3081–3097).
    return (
      <div style={{ background: 'var(--proto-card)', border: '1px solid var(--proto-line)', borderRadius: 12, padding: '10px 13px' }}>
        <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
          <span style={{ color: 'var(--proto-faint)', fontSize: 8.5 }}>▸</span>
          <span style={{ font: `600 11.5px ${MONO}`, color: 'var(--proto-ink)' }}>{thread.templateName}</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: pill.bg, color: pill.fg }}>
            {pillText}
          </span>
        </div>
        <div style={{ font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)', marginTop: 4, paddingLeft: 16 }}>
          {loading ? '…' : threadSubLine(thread)}
        </div>
      </div>
    );
  }

  // Card A — expanded card (scheme L3026–3078).
  const depth = depthInfo(detail);
  return (
    <div style={{ background: 'var(--proto-card)', border: '1px solid var(--proto-line)', borderRadius: 12 }}>
      <div onClick={onToggle} style={{ padding: '11px 13px 9px', borderBottom: '1px solid var(--proto-line-soft)', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <NodeIcon color={thread.status === 'running' ? 'var(--proto-accent)' : 'var(--proto-muted-2)'} />
          <span style={{ font: `600 12.5px ${MONO}`, color: 'var(--proto-ink)' }}>{thread.templateName}</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: pill.bg, color: pill.fg }}>
            {pillText}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <span style={{ font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)' }}>{threadMetaLineZh(thread, now, vocab.step)}</span>
          {depth.filled > 1 && (
            <span style={{ marginLeft: 'auto', font: `500 9px ${MONO}`, color: 'var(--proto-muted)' }}>
              {vocab.depth} {depth.text}
            </span>
          )}
        </div>
      </div>
      <div style={{ padding: '10px 13px 6px' }}>
        <MobileStepTree detail={detail} now={now} vocab={vocab} onDrill={onDrill} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', padding: '9px 13px', borderTop: '1px solid var(--proto-line-2)' }}>
        <span title="Pause has no backend mutate op yet" style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-muted)', padding: '4px 10px 4px 0', cursor: 'not-allowed', opacity: 0.6 }}>
          {vocab.pause}
        </span>
        <span data-cancel-thread-id={thread.id} onClick={onCancel} style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-danger)', padding: '4px 10px', cursor: 'pointer' }}>
          {vocab.cancel}
        </span>
        <span style={{ marginLeft: 'auto', font: `500 10px ${MONO}`, color: 'var(--proto-muted-3)' }}>Σ {formatCost(detail.totalCostUsd)}</span>
      </div>
    </div>
  );
}
