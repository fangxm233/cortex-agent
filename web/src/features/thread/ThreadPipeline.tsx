import { useState } from 'react';
import { useVocab } from '@/i18n';
import type { DetailStep, DetailStepSub, ThreadDetailVm } from './thread-detail-vm';
import { ThreadStepChat } from './ThreadStepChat';

// PIPELINE column — vertical step list. Each step is a card; exactly one is expanded at a time. The
// expanded step shows its agent session as a CHAT (assistant markdown + collapsed tool-call rows,
// streaming live for the running step) via ThreadStepChat, plus the SUB-THREADS cards on the running
// step. Selection is click-driven: clicking any step expands it; by default the pipeline follows the
// active (running) step, falling back to the last step for a terminal thread.

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: '#98A1B0' }}>
      {children}
    </span>
  );
}

/** Leading status glyph (green check / pulsing blue dot / hollow circle) shared by both card states. */
function StepDot({ kind }: { kind: DetailStep['kind'] }) {
  if (kind === 'done') {
    return (
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
    );
  }
  if (kind === 'running') {
    return (
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
    );
  }
  return (
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
  );
}

function CompactStep({ step, onClick }: { step: DetailStep; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const pending = step.kind === 'pending';
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
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
        <StepDot kind={step.kind} />
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

function ExpandedStep({
  step,
  onCollapse,
  onOpenSub,
  renderChat,
}: {
  step: DetailStep;
  onCollapse: () => void;
  onOpenSub: (s: DetailStepSub) => void;
  renderChat: (sessionId: string | null, live: boolean) => React.ReactNode;
}) {
  const L = useVocab();
  const running = step.kind === 'running';
  const agent = step.agent;
  const agentLabel = step.profile ?? agent?.profile;
  const execInfo = agent?.execInfo || step.sessionName || '';
  return (
    <div
      data-active-step={running ? 'true' : undefined}
      data-expanded-step="true"
      style={{
        background: '#fff',
        border: running ? '1.5px solid #4655D4' : '1.5px solid #C9CFF2',
        borderRadius: 10,
        boxShadow: running ? '0 0 0 3px #EEF0FA' : '0 1px 2px rgba(16,24,40,.04)',
        overflow: 'hidden',
      }}
    >
      {/* header row — click to collapse */}
      <div
        onClick={onCollapse}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 13px', cursor: 'pointer' }}
      >
        <StepDot kind={step.kind} />
        <span style={{ fontSize: 12.5, fontWeight: 650, color: '#191C22' }}>{step.title}</span>
        {agentLabel && (
          <span
            style={{
              font: "500 9px 'IBM Plex Mono',monospace",
              border: '1px solid #E7E9EE',
              color: '#8A93A2',
              padding: '1px 6px',
              borderRadius: 5,
            }}
          >
            {L.thAgentLabel}: {agentLabel}
          </span>
        )}
        {execInfo && (
          <span style={{ font: "400 10px 'IBM Plex Mono',monospace", color: '#98A1B0' }}>{execInfo}</span>
        )}
        <span
          style={{
            marginLeft: 'auto',
            font: "400 10px 'IBM Plex Mono',monospace",
            color: running ? '#4655D4' : '#B6BDC9',
          }}
        >
          {step.meta}
        </span>
        <span style={{ color: '#B6BDC9', fontSize: 9, flex: 'none', transform: 'rotate(90deg)' }}>▸</span>
      </div>

      {/* agent chat */}
      <div style={{ borderTop: '1px solid #EFF1F5', padding: '10px 13px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <SectionLabel>{L.thAgentSection}</SectionLabel>
          {running && agent?.live && (
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
        {renderChat(step.sessionId, running)}
      </div>

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
  /** Injectable step-chat renderer (default = the live ThreadStepChat). Overridden in static-render
   *  tests so the presentational pipeline can be asserted without tRPC/query providers. */
  renderStepChat?: (sessionId: string | null, live: boolean) => React.ReactNode;
}

export function ThreadPipeline({ vm, onOpenSub, renderStepChat }: ThreadPipelineProps): JSX.Element {
  const L = useVocab();
  const renderChat =
    renderStepChat ?? ((sessionId, live) => <ThreadStepChat sessionId={sessionId} live={live} />);
  // Default expansion follows the active (running) step, else the last step for a terminal thread.
  // A user click sets a manual override that sticks until they pick another step.
  const runningIdx = vm.steps.findIndex((s) => s.kind === 'running');
  const defaultIdx = runningIdx >= 0 ? runningIdx : vm.steps.length - 1;
  const [manualIdx, setManualIdx] = useState<number | null>(null);
  const selectedIdx = manualIdx ?? defaultIdx;

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
          {i === selectedIdx ? (
            <ExpandedStep
              step={step}
              onCollapse={() => setManualIdx(-1)}
              onOpenSub={onOpenSub}
              renderChat={renderChat}
            />
          ) : (
            <CompactStep step={step} onClick={() => setManualIdx(i)} />
          )}
        </div>
      ))}
    </div>
  );
}
