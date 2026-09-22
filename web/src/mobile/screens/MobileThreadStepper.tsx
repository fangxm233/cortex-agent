// @ds-adherence-ignore -- mobile inline thread card, 1:1 from Cortex_Glass_Mobile.dc.html L109-115
// (raw px/font/svg by design, §8.3).
import type { CSSProperties, KeyboardEvent } from 'react';
import type { ProtoPill } from '@/features/workbench/thread-card-proto';
import type { MobileStepper, StepperNode } from './mobile-session-vm';

const mono = "'IBM Plex Mono',monospace";

const cardStyle: CSSProperties = {
  borderRadius: 'var(--r-float)',
  background: 'var(--glass-2)',
  boxShadow: 'var(--shadow-card), 0 0 0 1px var(--proto-accent-border), var(--accent-glow)',
  padding: '12px 14px',
  cursor: 'pointer',
};

function barColor(state: StepperNode['state']): string {
  return state === 'done' ? 'var(--proto-success)' : state === 'running' ? 'var(--proto-accent)' : 'var(--proto-line-3)';
}

/** Done steps carry their tick, the running one its elapsed — the stepper model has no per-step
 *  clock, so that is the thread's own elapsed. */
function nodeLabel(node: StepperNode, elapsed: string): string {
  if (node.state === 'done') return `${node.label} ✓`;
  if (node.state === 'running') return `${node.label} · ${elapsed}`;
  return node.label;
}

export function MobileThreadStepper({
  card,
  pill,
  running,
  subthreadsLabel,
  openLabel,
  onOpen,
}: {
  card: MobileStepper;
  pill: ProtoPill;
  /** Thread-level running state — the pill goes solid accent for it. */
  running: boolean;
  subthreadsLabel: string;
  openLabel: string;
  onOpen: () => void;
}): JSX.Element {
  const hasRunningStep = card.nodes.some((node) => node.state === 'running');
  const meta = hasRunningStep
    ? `${card.footer.cost} · ${card.footer.subCount} ${subthreadsLabel}`
    : `${card.footer.elapsed} · ${card.footer.cost} · ${card.footer.subCount} ${subthreadsLabel}`;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${openLabel} · ${card.name}`}
      onClick={onOpen}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') onOpen();
      }}
      style={cardStyle}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--proto-accent)" strokeWidth="1.6">
          <circle cx="3.5" cy="3" r="1.9" />
          <circle cx="3.5" cy="11" r="1.9" />
          <circle cx="10.5" cy="7" r="1.9" />
          <path d="M3.5 5v4M5.4 3.7 8.7 6.1M5.4 10.3 8.7 7.9" />
        </svg>
        <span style={{ font: `600 12.5px ${mono}`, color: 'var(--m-ink)' }}>{card.name}</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10.5,
            fontWeight: 600,
            padding: '2px 9px',
            borderRadius: 'var(--r-pill)',
            background: running ? 'var(--proto-accent)' : pill.bg,
            color: running ? 'var(--ink-solid-fg)' : pill.color,
          }}
        >
          {card.pillText}
        </span>
      </div>

      {/* Cost and sub-threads used to sit in a divided footer beside an `Open →` link; the card
          itself is the link now, so they ride the header block instead. */}
      <div style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)', textAlign: 'right', marginTop: 4 }}>
        {meta}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
        {card.nodes.map((node, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 'var(--r-pill)',
              background: barColor(node.state),
              animation: node.state === 'running' ? 'cxpulse 1.6s ease-in-out infinite' : undefined,
            }}
          />
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>
        {card.nodes.map((node, i) => (
          <span key={i} style={node.state === 'running' ? { color: 'var(--proto-accent)' } : undefined}>
            {nodeLabel(node, card.footer.elapsed)}
          </span>
        ))}
      </div>
    </div>
  );
}
