// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1c L174–238)
// Presentational views for the 1c 线程 screen: the tab header (title + qn + 活跃/历史 segment + 今日 budget
// band) and the thread pipeline card. Both running and waiting (a manager SUSPENDED on its children —
// DR-0014 parent suspension) render as the same drill-in pipeline card; only the status pill differs.
// Prop-driven & framework-free of tRPC so they render-test cleanly; the container (MThreadsScreen)
// binds the real queries and per-card detail.
import { MTabHeader, MCard, MPill, MSegmented, statusPillTone, MC, MONO } from '@/mobile/ui/kit';
import type { ThreadInfo, ThreadDetail } from '@cortex-agent/ui-contract';
import type { Scope } from '@/features/workbench/scope';
import {
  pipelineSteps,
  runningMeta,
  activeSegmentLabel,
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
// `waiting` = a manager suspended on its children → the amber "waiting" pill tone with the 等待子线程
// label (NOT an approval block).
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
      return { tone: statusPillTone(status) as 'running', label: copy.running };
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

// ── Header — MTabHeader(title, qn, trailing=segment, below=今日 budget band) ─────
export function MThreadsHeader({
  copy,
  qn,
  segment,
  activeCount,
  band,
  onSegment,
}: {
  copy: MThreadsCopy;
  qn?: string;
  segment: Scope;
  activeCount: number;
  band: MBudgetBand;
  onSegment: (s: Scope) => void;
}) {
  return (
    <MTabHeader
      title={copy.title}
      qn={qn}
      trailing={
        <MSegmented<Scope>
          options={[
            { id: 'active', label: activeSegmentLabel(copy.active, activeCount) },
            { id: 'history', label: copy.history },
          ]}
          value={segment}
          onChange={onSegment}
        />
      }
      below={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: MC.muted }}>{copy.today}</span>
          <div style={{ flex: 1, height: 4, borderRadius: 999, background: 'var(--proto-line)', overflow: 'hidden' }}>
            <div style={{ width: `${band.pct}%`, height: '100%', background: MC.run }} />
          </div>
          <span style={{ font: `500 10px ${MONO}`, color: MC.ink }}>
            {band.numerator} / {band.denominator}
          </span>
        </div>
      }
    />
  );
}

// ── Horizontal pipeline (scheme L201–209) ─────────────────────────────────────
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
      <span style={{ width: 14, height: 14, borderRadius: '50%', background: MC.run, boxShadow: `0 0 0 3px ${MC.runBg}`, animation: 'cxpulse 1.6s ease-in-out infinite', flex: 'none' }} />
    );
  }
  return <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px solid var(--proto-line-3)', boxSizing: 'border-box', flex: 'none' }} />;
}

function Pipeline({ steps }: { steps: MPipelineStep[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '10px 0 4px' }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
            <PipelineDot state={s.state} />
            <span
              style={{
                fontSize: 10.5,
                color: s.state === 'active' ? MC.ink : s.state === 'done' ? MC.sub : MC.faint,
                fontWeight: s.state === 'active' ? 600 : 400,
                whiteSpace: 'nowrap',
              }}
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div style={{ flex: 1, height: 1.5, margin: '0 6px', background: s.state === 'done' ? 'var(--proto-success-bg)' : MC.hairline }} />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Running pipeline card (scheme L195–211) ───────────────────────────────────
export function MRunningCard({
  info,
  detail,
  now,
  copy,
  onOpen,
}: {
  info: ThreadInfo;
  detail?: ThreadDetail;
  now: number;
  copy: MThreadsCopy;
  onOpen: () => void;
}) {
  const steps = pipelineSteps(info, detail);
  const pill = threadPill(info.status, copy);
  const nodeColor = info.status === 'running' ? MC.run : info.status === 'waiting' ? MC.amber : MC.muted;
  return (
    <MCard onClick={onOpen}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <NodeIcon color={nodeColor} />
        <span style={{ font: `600 12.5px ${MONO}`, color: MC.ink }}>{info.templateName}</span>
        <span style={{ marginLeft: 'auto' }}>
          <MPill tone={pill.tone}>{pill.label}</MPill>
        </span>
      </div>
      {steps.length > 0 && <Pipeline steps={steps} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span style={{ font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)' }}>
          {runningMeta(info, detail, now, copy.subthread)}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: MC.run }}>{copy.open} ›</span>
      </div>
    </MCard>
  );
}
