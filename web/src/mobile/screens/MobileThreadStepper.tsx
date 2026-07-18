// @ds-adherence-ignore -- mobile inline thread card, 1:1 from scheme.dc.html L2954-2973 (raw px/hex/
// font/svg by design, §8.3; mobile palette is not in the light `proto.*` token set).
import { Fragment } from 'react';
import type { ProtoPill } from '@/features/workbench/thread-card-proto';
import type { MobileStepper, StepperNode } from './mobile-session-vm';

const mono = "'IBM Plex Mono',monospace";

function StepDot({ state }: { state: StepperNode['state'] }): JSX.Element {
  if (state === 'done')
    return (
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: 'var(--proto-success-bg)',
          color: 'var(--proto-success)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 8,
          fontWeight: 700,
        }}
      >
        ✓
      </span>
    );
  if (state === 'running')
    return (
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: 'var(--proto-accent)',
          boxShadow: '0 0 0 3px var(--proto-accent-bg)',
          animation: 'cxpulse 1.6s ease-in-out infinite',
        }}
      />
    );
  return (
    <span
      style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px solid var(--proto-line-3)', boxSizing: 'border-box' }}
    />
  );
}

function nodeLabelColor(state: StepperNode['state']): string {
  return state === 'running' ? 'var(--proto-ink)' : state === 'done' ? 'var(--proto-muted)' : 'var(--proto-faint)';
}

export function MobileThreadStepper({
  card,
  pill,
  subthreadsLabel,
  openLabel,
  onOpen,
}: {
  card: MobileStepper;
  pill: ProtoPill;
  subthreadsLabel: string;
  openLabel: string;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div style={{ border: '1px solid var(--proto-line)', borderRadius: 12, overflow: 'hidden', background: 'var(--proto-card)' }}>
      {/* header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          borderBottom: '1px solid var(--proto-line-2)',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--proto-accent)" strokeWidth="1.6">
          <circle cx="3.5" cy="3" r="1.9" />
          <circle cx="3.5" cy="11" r="1.9" />
          <circle cx="10.5" cy="7" r="1.9" />
          <path d="M3.5 5v4M5.4 3.7 8.7 6.1M5.4 10.3 8.7 7.9" />
        </svg>
        <span style={{ font: `600 12px ${mono}`, color: 'var(--proto-ink)' }}>{card.name}</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
            background: pill.bg,
            color: pill.color,
          }}
        >
          {card.pillText}
        </span>
      </div>

      {/* horizontal stepper */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px' }}>
        {card.nodes.map((node, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <div
                style={{ flex: 1, height: 1.5, background: node.lineDone ? 'var(--proto-success-bg)' : 'var(--proto-line)', margin: '0 6px' }}
              />
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <StepDot state={node.state} />
              <span
                style={{
                  fontSize: 10.5,
                  color: nodeLabelColor(node.state),
                  fontWeight: node.state === 'running' ? 600 : undefined,
                }}
              >
                {node.label}
              </span>
            </div>
          </Fragment>
        ))}
      </div>

      {/* footer */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--proto-line-2)' }}>
        <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>
          {card.footer.elapsed} · {card.footer.cost} · {card.footer.subCount} {subthreadsLabel}
        </span>
        <span
          onClick={onOpen}
          style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}
        >
          {openLabel} →
        </span>
      </div>
    </div>
  );
}
