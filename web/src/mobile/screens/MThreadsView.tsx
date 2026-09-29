import type { ReactNode } from 'react';
import { statusTone } from '@/design/tone';
import { MTabHeader, MGroup, MGroupLabel, MPill, MC, M_NUM } from '@/mobile/ui/kit';
import type { ThreadInfo, ThreadDetail } from '@cortex-agent/ui-contract';
import type { TimeLang } from '@/lib/time-format';
import type { ThreadGroup } from '@/features/session/composer/scope';
import {
  pipelineSteps,
  runningMeta,
  type MBudgetBand,
  type MPipelineStep,
} from './m-threads-vm';

export interface MThreadsCopy {
  title: string;
  active: string;
  history: string;
  today: string;
  open: string;
  subthread: string;
  empty: string;
  running: string;
  waiting: string;
  done: string;
  failed: string;
  cancelled: string;
}

// Status → { pill tone, localized label } for a thread card (history shows terminal statuses too).
// `waiting` covers any non-terminal pause normalized by the UI contract, not an approval block.
function threadPill(status: ThreadInfo['status'], copy: MThreadsCopy): { tone: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'; label: string } {
  switch (status) {
    case 'running':
      return { tone: 'running', label: copy.running };
    case 'waiting':
      return { tone: 'waiting', label: copy.waiting };
    case 'completed':
      return { tone: 'done', label: copy.done };
    case 'failed':
    case 'aborted':
      return { tone: 'failed', label: copy.failed };
    case 'cancelled':
      return { tone: 'cancelled', label: copy.cancelled };
    default:
      return { tone: statusTone(status) as 'running', label: copy.running };
  }
}

// 3-node graph icon (scheme L197); color set by the caller.
function NodeIcon({ color }: { color: string }) {
  return (
    <svg width={13} height={13} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.6} style={{ flex: 'none' }}>
      <circle cx="3.5" cy="3" r="1.9" />
      <circle cx="3.5" cy="11" r="1.9" />
      <circle cx="10.5" cy="7" r="1.9" />
      <path d="M3.5 5v4M5.4 3.7 8.7 6.1M5.4 10.3 8.7 7.9" />
    </svg>
  );
}

// ── Header — MTabHeader(title, qn, below=今日 budget band) ─────────────────────
export function MThreadsHeader({ copy, qn, band }: {
  copy: MThreadsCopy;
  qn?: string;
  band: MBudgetBand;
}) {
  return (
    <MTabHeader
      title={copy.title}
      qn={qn}
      below={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: MC.muted }}>{copy.today}</span>
          <div style={{ flex: 1, height: 4, borderRadius: 'var(--r-pill)', background: 'var(--proto-line-2)', overflow: 'hidden' }}>
            <div style={{ width: `${band.pct}%`, height: '100%', borderRadius: 'var(--r-pill)', background: MC.run }} />
          </div>
          <span style={{ fontSize: 12, color: MC.muted, ...M_NUM }}>
            <b style={{ fontWeight: 600, color: MC.ink }}>{band.numerator}</b> / {band.denominator}
          </span>
        </div>
      }
    />
  );
}

export function MThreadSections({ groups, copy, renderThread }: {
  groups: ThreadGroup[];
  copy: MThreadsCopy;
  renderThread: (thread: ThreadInfo) => ReactNode;
}) {
  return <>{groups.map((group, index) => (
    <section key={group.kind} style={{ marginTop: index === 0 ? 0 : 18 }}>
      <MGroupLabel>
        {copy[group.kind]} <span style={{ color: MC.faint, fontWeight: 500, ...M_NUM }}>{group.threads.length}</span>
      </MGroupLabel>
      <MGroup inset={37}>{group.threads.map(renderThread)}</MGroup>
    </section>
  ))}</>;
}

// ── Responsive pipeline (scheme L201–209) ────────────────────────────────────
function PipelineDot({ state }: { state: MPipelineStep['state'] }) {
  if (state === 'done') {
    return (
      <span style={{ width: 14, height: 14, borderRadius: '50%', background: MC.doneBg, color: MC.done, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, flex: 'none' }}>
        ✓
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span style={{ width: 14, height: 14, borderRadius: '50%', background: MC.run, boxShadow: `0 0 0 3px ${MC.runBg}`, flex: 'none' }} />
    );
  }
  return <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px solid var(--proto-line-3)', boxSizing: 'border-box', flex: 'none' }} />;
}

const PIPELINE_COLUMNS = 4;

function PipelineLabel({ step }: { step: MPipelineStep }) {
  const color = step.state === 'active' ? MC.ink : step.state === 'done' ? MC.sub : MC.muted;
  return (
    <span
      title={step.label}
      style={{
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 11,
        color,
        fontWeight: step.state === 'active' ? 600 : 400,
      }}
    >
      {step.label}
    </span>
  );
}

function PipelineStep({ step, connected }: { step: MPipelineStep; connected: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: '0 1 auto' }}>
        <PipelineDot state={step.state} />
        <PipelineLabel step={step} />
      </div>
      {connected && (
        <div style={{ flex: 1, minWidth: 2, height: 1.5, margin: '0 6px', background: step.state === 'done' ? 'var(--proto-success-bg)' : MC.hairline }} />
      )}
    </div>
  );
}

function Pipeline({ steps }: { steps: MPipelineStep[] }) {
  const columns = Math.min(PIPELINE_COLUMNS, steps.length);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, rowGap: 8, padding: '10px 0 4px' }}>
      {steps.map((step, index) => (
        <PipelineStep
          key={index}
          step={step}
          connected={index < steps.length - 1 && (index + 1) % PIPELINE_COLUMNS !== 0}
        />
      ))}
    </div>
  );
}

// ── Thread row (scheme L195–211) ─────────────────────────────────────────────
// Template + status pill, the live pipeline when the thread has stages, then the id/age/cost meta.
// The whole row opens the thread; text hangs off one x after the node glyph (divider inset 37).
export function MThreadRow({
  info,
  detail,
  now,
  copy,
  lang,
  onOpen,
}: {
  info: ThreadInfo;
  detail?: ThreadDetail;
  now: number;
  copy: MThreadsCopy;
  lang: TimeLang;
  onOpen: () => void;
}) {
  const steps = pipelineSteps(info, detail);
  const pill = threadPill(info.status, copy);
  const nodeColor = info.status === 'running' ? MC.run : info.status === 'waiting' ? MC.amber : MC.muted;
  return (
    <div className="m-press" onClick={onOpen} style={{ display: 'flex', gap: 10, padding: '11px 14px', borderRadius: 10, cursor: 'pointer' }}>
      <span style={{ paddingTop: 2 }}><NodeIcon color={nodeColor} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: MC.ink, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{info.templateName}</span>
          <span style={{ marginLeft: 'auto', flex: 'none' }}>
            <MPill tone={pill.tone}>{pill.label}</MPill>
          </span>
        </div>
        {steps.length > 0 && <Pipeline steps={steps} />}
        <div style={{ fontSize: 12, color: MC.muted, marginTop: steps.length > 0 ? 2 : 3, ...M_NUM }}>
          {runningMeta(info, detail, now, copy.subthread, lang)}
        </div>
      </div>
    </div>
  );
}
