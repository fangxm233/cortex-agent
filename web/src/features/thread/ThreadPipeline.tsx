import { useState } from 'react';
import { useVocab } from '@/i18n';
import type { DetailStep, DetailStepSub, ThreadDetailVm } from './thread-detail-vm';

// PIPELINE column — 1:1 from prototype.dc.html L425–487. Single-column vertical step list: completed
// / pending steps collapse to a one-line card; only the running (active) step expands into a bordered
// card with the live AGENT flow + SUB-THREADS cards. Data-driven off ThreadDetailVm (real threads.get).
//
// Flagged gaps: the AGENT feed is `agentFlow.lastOutput` only — the DTO has no per-agent tool-call
// trace, so the prototype's tool-chip feed rows are omitted (execution-log surface, Stage 4).

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: '#98A1B0' }}>
      {children}
    </span>
  );
}

function CompactStep({ step }: { step: DetailStep }) {
  const [hover, setHover] = useState(false);
  const pending = step.kind === 'pending';
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-step-kind={step.kind}
      style={{
        background: '#fff',
        border: pending ? '1px dashed #D9DCE3' : '1px solid ' + (hover ? '#C9CFF2' : '#E7E9EE'),
        borderRadius: 10,
        padding: '9px 13px',
        boxShadow: '0 1px 2px rgba(16,24,40,.03)',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {step.kind === 'done' ? (
          <span
            style={{
              width: 15,
              height: 15,
              borderRadius: '50%',
              background: '#E9F4EE',
              color: '#23854F',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 8.5,
              fontWeight: 700,
              flex: 'none',
            }}
          >
            ✓
          </span>
        ) : (
          <span
            style={{
              width: 15,
              height: 15,
              borderRadius: '50%',
              border: '1.5px solid #D9DCE3',
              boxSizing: 'border-box',
              flex: 'none',
            }}
          />
        )}
        <span
          style={{ fontSize: 12.5, fontWeight: 600, color: pending ? '#B6BDC9' : '#5B6472', flex: 'none' }}
        >
          {step.title}
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: '#98A1B0',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {step.note}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            font: "400 10px 'IBM Plex Mono',monospace",
            color: pending ? '#D9DCE3' : '#B6BDC9',
            flex: 'none',
          }}
        >
          {step.meta}
        </span>
        <span style={{ color: '#D9DCE3', fontSize: 9, flex: 'none' }}>▸</span>
      </div>
    </div>
  );
}

function SubCard({ sub, onOpen }: { sub: DetailStepSub; onOpen: () => void }) {
  const L = useVocab();
  const running = sub.pill.text === 'Running';
  return (
    <div
      data-sub-thread-id={sub.id}
      style={{
        border: '1px solid ' + (running ? '#E3E6F5' : '#EFF1F5'),
        background: running ? '#FBFBFE' : '#FBFBFC',
        borderRadius: 8,
        padding: '8px 11px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ font: "600 11px 'IBM Plex Mono',monospace", color: '#191C22' }}>{sub.name}</span>
        <span style={{ font: "400 9px 'IBM Plex Mono',monospace", color: '#B6BDC9' }}>{sub.level}</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 9.5,
            fontWeight: 600,
            padding: '1.5px 7px',
            borderRadius: 999,
            background: sub.pill.bg,
            color: sub.pill.fg,
          }}
        >
          {sub.pill.text}
        </span>
      </div>
      {(sub.hasLine || sub.drillable) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#5B6472', marginTop: 5 }}>
          {sub.hasLine && sub.line}
          {sub.drillable && (
            <span
              data-drill-thread-id={sub.id}
              onClick={onOpen}
              style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, color: '#4655D4', cursor: 'pointer' }}
            >
              {L.thOpenSub} ›
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function RunningStep({ step, onOpenSub }: { step: DetailStep; onOpenSub: (s: DetailStepSub) => void }) {
  const L = useVocab();
  const agent = step.agent;
  return (
    <div
      data-active-step="true"
      style={{
        background: '#fff',
        border: '1.5px solid #4655D4',
        borderRadius: 10,
        boxShadow: '0 0 0 3px #EEF0FA',
        overflow: 'hidden',
      }}
    >
      {/* header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 13px' }}>
        <span
          style={{
            width: 15,
            height: 15,
            borderRadius: '50%',
            background: '#4655D4',
            boxShadow: '0 0 0 3px #EEF0FA',
            animation: 'cxpulse 1.6s ease-in-out infinite',
            flex: 'none',
          }}
        />
        <span style={{ fontSize: 12.5, fontWeight: 650, color: '#191C22' }}>{step.title}</span>
        {agent && (
          <span
            style={{
              font: "500 9px 'IBM Plex Mono',monospace",
              border: '1px solid #E7E9EE',
              color: '#8A93A2',
              padding: '1px 6px',
              borderRadius: 5,
            }}
          >
            {L.thAgentLabel}: {agent.profile}
          </span>
        )}
        {agent?.execInfo && (
          <span style={{ font: "400 10px 'IBM Plex Mono',monospace", color: '#98A1B0' }}>{agent.execInfo}</span>
        )}
        <span style={{ marginLeft: 'auto', font: "400 10px 'IBM Plex Mono',monospace", color: '#4655D4' }}>
          {step.meta}
        </span>
      </div>

      {/* agent flow */}
      {agent && (
        <div style={{ borderTop: '1px solid #EFF1F5', padding: '10px 13px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <SectionLabel>{L.thAgentSection}</SectionLabel>
            {agent.live && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#4655D4',
                  animation: 'cxpulse 1.6s ease-in-out infinite',
                }}
              />
            )}
          </div>
          {agent.lastOutput && (
            <div style={{ fontSize: 12.5, lineHeight: 1.6, color: '#22262E', maxWidth: 640 }}>
              {agent.lastOutput}
              {agent.streaming && (
                <span
                  style={{
                    display: 'inline-block',
                    width: 6,
                    height: 13,
                    background: '#4655D4',
                    borderRadius: 1,
                    verticalAlign: -2,
                    marginLeft: 2,
                    animation: 'cxblink 1.1s steps(1) infinite',
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* sub-threads */}
      {step.subCount > 0 && (
        <div style={{ borderTop: '1px solid #EFF1F5', padding: '10px 13px 12px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: '#98A1B0', marginBottom: 7 }}>
            {L.thSubThreads} · {step.subCount}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {step.subs.map((sub) => (
              <SubCard key={sub.id} sub={sub} onOpen={() => onOpenSub(sub)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export interface ThreadPipelineProps {
  vm: ThreadDetailVm;
  onOpenSub: (sub: DetailStepSub) => void;
}

export function ThreadPipeline({ vm, onOpenSub }: ThreadPipelineProps): JSX.Element {
  const L = useVocab();
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }} data-pipeline="true">
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 8px' }}>
        <SectionLabel>{L.thPipeline}</SectionLabel>
        <span style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: '#B6BDC9' }}>
          {L.thPipelineHint}
        </span>
      </div>
      {vm.steps.map((step, i) => (
        <div key={i}>
          {step.hasConnector && (
            <div style={{ width: 1.5, height: 12, background: '#DCE0E8', marginLeft: 20 }} />
          )}
          {step.kind === 'running' ? (
            <RunningStep step={step} onOpenSub={onOpenSub} />
          ) : (
            <CompactStep step={step} />
          )}
        </div>
      ))}
    </div>
  );
}
