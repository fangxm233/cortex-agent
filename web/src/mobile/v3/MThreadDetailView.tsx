// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1g L387-438)
// Presentational 1g 线程详情 — the drill-in detail of a single thread (from 1c「打开 ›」). Non-Tab page:
// custom header (‹ back + template name + status pill + ⋯, then a breadcrumb + self-depth row), a
// meta line, the vertical PIPELINE step list (collapsed done / expanded running agent-flow / faint
// pending), the 产物 refs card, and a footer (暂停 inert + 取消 + Σ cost). Prop-driven so it render-tests
// without tRPC. Reuses the kit chrome (MScreen/MMoreButton/MPill/statusPillTone/MDot/MC/MONO).
import type { ReactNode } from 'react';
import { MScreen, MMoreButton, MPill, statusPillTone, MDot, MC, MONO, type PillTone } from '@/mobile/ui/kit';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import type { MThreadDetailVm, MThreadStepVm } from './m-thread-detail-vm';

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
        background: MC.canvas,
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
            minHeight: 34,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          ‹
        </button>
        <span style={{ font: `600 15px ${MONO}`, color: MC.ink }}>{vm.name}</span>
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
          font: `400 9.5px ${MONO}`,
          color: 'var(--proto-muted-3)',
          padding: '6px 0 9px 24px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        {vm.crumbs.map((c, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
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
    <div style={{ border: '1px solid var(--proto-accent-bg)', background: 'var(--proto-rail)', borderRadius: 9, padding: '9px 11px', marginTop: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 9px ${MONO}`, color: 'var(--proto-muted-3)' }}>
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

function StepRow({ step, copy }: { step: MThreadStepVm; copy: MThreadDetailCopy }) {
  const active = step.kind === 'running';
  const nameColor = active ? MC.ink : step.kind === 'done' ? MC.sub : MC.faint;
  const timeLabel = step.kind === 'pending' ? copy.pending : step.time;
  return (
    <>
      <StepDotColumn kind={step.kind} hasConnector={step.hasConnector} />
      <div style={{ paddingBottom: step.hasConnector ? 9 : 4, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <span style={{ fontSize: 11.5, fontWeight: active ? 600 : 500, color: nameColor }}>{step.name}</span>
          {step.note && <span style={{ fontSize: 9, color: 'var(--proto-muted-3)', marginLeft: 6 }}>{step.note}</span>}
          {timeLabel && (
            <span style={{ marginLeft: 'auto', font: `400 9px ${MONO}`, color: active ? MC.run : MC.faint }}>
              {timeLabel}
            </span>
          )}
        </div>
        {step.agent && <AgentBox agent={step.agent} />}
      </div>
    </>
  );
}

function ArtifactsCard({ vm, copy }: { vm: MThreadDetailVm; copy: MThreadDetailCopy }) {
  return (
    <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '9px 13px', borderBottom: '1px solid var(--proto-line-2)' }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: MC.ink }}>{copy.artifacts}</span>
        <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint, marginLeft: 7 }}>{vm.artifactCount}</span>
      </div>
      {vm.artifacts.length === 0 ? (
        <div style={{ padding: '9px 13px', font: `400 10px ${MONO}`, color: MC.faint }}>{copy.noArtifacts}</div>
      ) : (
        vm.artifacts.map((a, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '9px 13px',
              borderBottom: i < vm.artifacts.length - 1 ? '1px solid var(--proto-alt)' : undefined,
            }}
          >
            <FileGlyph />
            <span style={{ font: `500 12px ${MONO}`, color: MC.body }}>{a.filename}</span>
            <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint }}>{a.meta}</span>
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
              borderRadius: 11,
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
              borderRadius: 11,
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
      <span style={{ font: `500 10.5px ${MONO}`, color: 'var(--proto-muted-3)', flex: 'none', marginLeft: 'auto', paddingLeft: 4 }}>
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
}: {
  vm: MThreadDetailVm;
  copy: MThreadDetailCopy;
  onBack: () => void;
  onMore: () => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <MScreen
      label="1g 线程详情"
      header={<Header vm={vm} copy={copy} onBack={onBack} onMore={onMore} />}
      footer={<Footer vm={vm} copy={copy} onCancel={onCancel} />}
    >
      <div style={{ padding: '12px 14px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* meta line: thr_xxxx · agent X · machine · elapsed */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)', padding: '0 2px' }}>
          <span>{vm.metaParts.join(' · ')}</span>
          <span style={{ marginLeft: 'auto', color: MC.run }}>{vm.elapsed}</span>
        </div>

        {/* PIPELINE */}
        <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 12, padding: '11px 13px 7px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '15px 1fr', columnGap: 8 }}>
            {vm.steps.map((step, i) => (
              <StepRow key={i} step={step} copy={copy} />
            ))}
          </div>
        </div>

        {/* 产物 */}
        <ArtifactsCard vm={vm} copy={copy} />
        <div style={{ height: 4, flex: 'none' }} />
      </div>
    </MScreen>
  );
}
