// input:  React, mobile kit, presentation props
// output: MThreadDetailView
// pos:    Mobile ThreadDetailView presentation
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useState, type ReactNode } from 'react';
import { MScreen, MMoreButton, MPill, statusPillTone, MDot, MC, MONO, type PillTone } from '@/mobile/ui/kit';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import { ThreadStepChat } from '@/features/thread/ThreadStepChat';
import type { MThreadDetailVm, MThreadStepVm, MThreadArtifactVm } from './m-thread-detail-vm';

export interface MThreadDetailCopy {
  pause: string;
  cancel: string;
  artifacts: string;
  noArtifacts: string;
  /** faint label on a not-yet-started step (scheme 待). */
  pending: string;
  /** 深度 / Depth word before the N/M meter. */
  depth: string;
  status: Record<PillTone, string>;
}

// The document/file glyph in the 产物 rows (scheme L427).
function FileGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke={MC.muted} strokeWidth="1.5">
      <path d="M3 1.5h5.5L11.5 4v8.5h-8.5z" />
      <path d="M8.5 1.5V4H11" />
    </svg>
  );
}

// ── Header (scheme L392-402): row1 identity + row2 breadcrumb/self-depth ──
function Header({
  vm,
  copy,
  onBack,
  onMore,
}: {
  vm: MThreadDetailVm;
  copy: MThreadDetailCopy;
  onBack: () => void;
  onMore: () => void;
}) {
  const tone = statusPillTone(vm.status);
  return (
    <div
      style={{
        flex: 'none',
        padding: '8px 14px 0',
        paddingTop: 'calc(8px + env(safe-area-inset-top))',
        borderBottom: `1px solid ${MC.hairline}`,
        background: MC.glassRaised,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          style={{
            border: 'none',
            background: 'transparent',
            color: MC.run,
            fontSize: 15,
            lineHeight: 1,
            padding: '0 2px',
            margin: 0,
            cursor: 'pointer',
            flex: 'none',
            minHeight: 44,
            minWidth: 44,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          ‹
        </button>
        <span style={{ font: `600 15px ${MONO}`, color: MC.ink, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vm.name}</span>
        <MPill tone={tone}>{copy.status[tone]}</MPill>
        <div style={{ marginLeft: 'auto', flex: 'none' }}>
          <MMoreButton onClick={onMore} />
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          font: `400 11px ${MONO}`,
          color: MC.muted,
          padding: '6px 0 9px 24px',
          flexWrap: 'wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {vm.crumbs.map((c, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ color: MC.run }}>{c.name}</span>
            <span>›</span>
          </span>
        ))}
        <span style={{ color: MC.ink, fontWeight: 600 }}>{vm.name}</span>
        <span>
          {vm.selfLevel != null ? ` · L${vm.selfLevel}` : ''} · {copy.depth} {vm.depthText}
        </span>
      </div>
    </div>
  );
}

// ── One PIPELINE row: dot column (with connector) + content (scheme L406-422) ──
function StepDotColumn({ kind, hasConnector }: { kind: MThreadStepVm['kind']; hasConnector: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {kind === 'done' && (
        <span
          style={{
            width: 13,
            height: 13,
            borderRadius: '50%',
            background: MC.doneBg,
            color: MC.done,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 7.5,
            fontWeight: 700,
            flex: 'none',
          }}
        >
          ✓
        </span>
      )}
      {kind === 'running' && (
        <span
          style={{
            width: 13,
            height: 13,
            borderRadius: '50%',
            background: MC.run,
            flex: 'none',
            boxShadow: `0 0 0 3px ${MC.runBg}`,
            animation: 'cxpulse 1.6s ease-in-out infinite',
          }}
        />
      )}
      {kind === 'pending' && (
        <span
          style={{ width: 13, height: 13, borderRadius: '50%', border: '1.5px solid var(--proto-line-3)', boxSizing: 'border-box', flex: 'none' }}
        />
      )}
      {hasConnector && <span style={{ flex: 1, width: 1.5, background: 'var(--proto-line-2)', margin: '3px 0' }} />}
    </div>
  );
}

function AgentBox({ agent }: { agent: NonNullable<MThreadStepVm['agent']> }) {
  return (
    <div style={{ border: '1px solid var(--proto-accent-bg)', background: 'var(--proto-rail)', borderRadius: 'var(--r-chip)', padding: '9px 11px', marginTop: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px ${MONO}`, color: MC.muted }}>
        {agent.live && <MDot color={MC.run} size={5} pulse />}
        <span>{agent.turnLabel}</span>
        {agent.cost && <span style={{ marginLeft: 'auto' }}>{agent.cost}</span>}
      </div>
      {agent.text && (
        <div style={{ fontSize: 11, lineHeight: 1.65, color: MC.sub, marginTop: 6, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
          <ChatMarkdown text={agent.text} />
        </div>
      )}
    </div>
  );
}

function StepRow({ step, copy, selected, onSelect }: { step: MThreadStepVm; copy: MThreadDetailCopy; selected: boolean; onSelect: () => void }) {
  const active = step.kind === 'running';
  const expanded = selected && (step.kind === 'done' || step.kind === 'running');
  const nameColor = active ? MC.ink : step.kind === 'done' ? MC.sub : MC.muted;
  const timeLabel = step.kind === 'pending' ? copy.pending : step.time;
  const tappable = step.kind !== 'pending';
  return (
    <>
      <StepDotColumn kind={step.kind} hasConnector={step.hasConnector} />
      <div
        onClick={tappable ? onSelect : undefined}
        style={{ paddingBottom: step.hasConnector ? 9 : 4, minWidth: 0, cursor: tappable ? 'pointer' : undefined }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, minHeight: 44 }}>
          <span style={{ fontSize: 11.5, fontWeight: active || selected ? 600 : 500, color: selected ? MC.ink : nameColor, minWidth: 0, overflowWrap: 'anywhere' }}>{step.name}</span>
          {step.note && !expanded && <span style={{ fontSize: 9, color: MC.muted, marginLeft: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{step.note}</span>}
          {timeLabel && (
            <span style={{ marginLeft: 'auto', font: `400 11px ${MONO}`, color: active ? MC.run : MC.muted, flex: 'none' }}>
              {timeLabel}
            </span>
          )}
          {tappable && (
            <span style={{ color: MC.muted, fontSize: 8, flex: 'none', marginLeft: 4, transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }}>▸</span>
          )}
        </div>
        {/* Running step: live agent box (always shown when selected) */}
        {step.agent && selected && <AgentBox agent={step.agent} />}
        {/* Done step: full session transcript when expanded */}
        {step.kind === 'done' && selected && step.sessionId && (
          <div style={{ border: '1px solid var(--proto-line-2)', background: 'var(--proto-rail)', borderRadius: 'var(--r-chip)', padding: '9px 11px', marginTop: 6, overflow: 'hidden', maxHeight: 400, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <ThreadStepChat sessionId={step.sessionId} live={false} />
          </div>
        )}
      </div>
    </>
  );
}

function ArtifactsCard({ vm, copy, onArtifactClick }: { vm: MThreadDetailVm; copy: MThreadDetailCopy; onArtifactClick?: (artifact: MThreadArtifactVm) => void }) {
  return (
    <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '9px 13px', borderBottom: '1px solid var(--proto-line-2)' }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: MC.ink }}>{copy.artifacts}</span>
        <span style={{ font: `400 11px ${MONO}`, color: MC.muted, marginLeft: 7 }}>{vm.artifactCount}</span>
      </div>
      {vm.artifacts.length === 0 ? (
        <div style={{ padding: '9px 13px', font: `400 11px ${MONO}`, color: MC.muted }}>{copy.noArtifacts}</div>
      ) : (
        vm.artifacts.map((a, i) => (
          <div
            key={i}
            onClick={onArtifactClick ? () => onArtifactClick(a) : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '9px 13px',
              borderBottom: i < vm.artifacts.length - 1 ? '1px solid var(--proto-alt)' : undefined,
              cursor: onArtifactClick ? 'pointer' : undefined,
            }}
          >
            <FileGlyph />
            <span style={{ font: `500 12px ${MONO}`, color: MC.body, minWidth: 0, overflowWrap: 'anywhere' }}>{a.filename}</span>
            <span style={{ marginLeft: 'auto', font: `400 11px ${MONO}`, color: MC.muted }}>{a.meta}</span>
            {onArtifactClick && <span style={{ color: MC.run, fontSize: 8, flex: 'none' }}>▸</span>}
          </div>
        ))
      )}
    </div>
  );
}

// ── Footer (scheme L431-435): 暂停 (inert, GAP) + 取消 + Σ cost, ≥44px ──
function Footer({ vm, copy, onCancel }: { vm: MThreadDetailVm; copy: MThreadDetailCopy; onCancel: () => void }) {
  return (
    <div
      style={{
        flex: 'none',
        borderTop: `1px solid ${MC.hairline}`,
        background: 'var(--proto-rail)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px 34px',
        paddingBottom: 'calc(14px + env(safe-area-inset-bottom))',
        minHeight: 44,
        boxSizing: 'border-box',
      }}
    >
      {/* Pause/Cancel only apply to a live thread (the backend rejects cancel on a terminal one). */}
      {vm.live && (
        <>
          {/* GAP: no pause backend op — rendered per scheme but inert. */}
          <div
            title="Pause has no backend op yet"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 'var(--r-control)',
              border: '1.5px solid var(--proto-line-3)',
              background: 'var(--proto-card)',
              color: MC.ink,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              fontWeight: 600,
              boxSizing: 'border-box',
              cursor: 'not-allowed',
              opacity: 0.6,
            }}
          >
            {copy.pause}
          </div>
          <button
            type="button"
            data-cancel-thread-id={vm.tid}
            onClick={onCancel}
            style={{
              flex: 1,
              height: 44,
              borderRadius: 'var(--r-control)',
              border: '1.5px solid var(--proto-danger-bg)',
              background: 'var(--proto-card)',
              color: MC.fail,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              fontWeight: 600,
              boxSizing: 'border-box',
              cursor: 'pointer',
            }}
          >
            {copy.cancel}
          </button>
        </>
      )}
      <span style={{ font: `500 11px ${MONO}`, color: MC.muted, flex: 'none', marginLeft: 'auto', paddingLeft: 4 }}>
        Σ {vm.cost}
      </span>
    </div>
  );
}

export function MThreadDetailView({
  vm,
  copy,
  onBack,
  onMore,
  onCancel,
  onArtifactClick,
}: {
  vm: MThreadDetailVm;
  copy: MThreadDetailCopy;
  onBack: () => void;
  onMore: () => void;
  onCancel: () => void;
  onArtifactClick?: (artifact: MThreadArtifactVm) => void;
}): ReactNode {
  // Default selection follows the running step, else the last step for terminal threads.
  const runningIdx = vm.steps.findIndex((s) => s.kind === 'running');
  const defaultIdx = runningIdx >= 0 ? runningIdx : vm.steps.length - 1;
  const [manualIdx, setManualIdx] = useState<number | null>(null);
  const selectedIdx = manualIdx ?? defaultIdx;

  return (
    <MScreen
      label="1g 线程详情"
      header={<Header vm={vm} copy={copy} onBack={onBack} onMore={onMore} />}
      footer={<Footer vm={vm} copy={copy} onCancel={onCancel} />}
    >
      <div style={{ padding: '12px 14px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* meta line: thr_xxxx · agent X · machine · elapsed */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, font: `400 11px ${MONO}`, color: MC.muted, padding: '0 2px' }}>
          <span>{vm.metaParts.join(' · ')}</span>
          <span style={{ marginLeft: 'auto', color: MC.run }}>{vm.elapsed}</span>
        </div>

        {/* PIPELINE */}
        <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', padding: '11px 13px 7px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '15px minmax(0, 1fr)', columnGap: 8 }}>
            {vm.steps.map((step, i) => (
              <StepRow
                key={i}
                step={step}
                copy={copy}
                selected={i === selectedIdx}
                onSelect={() => setManualIdx(i === selectedIdx ? -1 : i)}
              />
            ))}
          </div>
        </div>

        {/* 产物 */}
        <ArtifactsCard vm={vm} copy={copy} onArtifactClick={onArtifactClick} />
        <div style={{ height: 4, flex: 'none' }} />
      </div>
    </MScreen>
  );
}
