import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type {
  ThreadInfo,
  ThreadDetail,
  ThreadStepDetail,
  ThreadChildNode,
  ThreadDispatchInfo,
} from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { useExecutionLogDrawer } from '@/features/execution/ExecutionLogDrawerProvider';
import { dispatchesForStep } from '@/features/thread/thread-steps';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { nodeLevel } from '@/features/thread/nested-threads';
import {
  threadPill,
  stepDotKind,
  stepMeta,
  threadMetaLine,
  depthInfo,
  formatCost,
} from './right-panel-vm';

// One thread card — 1:1 from prototype.dc.html L1115–1185. A running (or user-opened) card fetches
// threads.get to render the real vertical step-tree (dot+tail grid, active-step child sub-cards) +
// footer (Pause / Cancel / Detail + Σcost). Collapsed cards render the header only (prototype simple
// threads). Cancel drives a real threads.cancel mutation → live threads.list refetch.

const NODE_ICON = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" strokeWidth="1.6">
    <circle cx="3.5" cy="3" r="1.9" />
    <circle cx="3.5" cy="11" r="1.9" />
    <circle cx="10.5" cy="7" r="1.9" />
    <path d="M3.5 5v4M5.4 3.7 8.7 6.1M5.4 10.3 8.7 7.9" />
  </svg>
);

function StepDot({ kind, hasTail }: { kind: 'done' | 'running' | 'pending'; hasTail: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {kind === 'done' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: '#E9F4EE',
            color: '#23854F',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 8,
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
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: '#4655D4',
            flex: 'none',
            boxShadow: '0 0 0 3px #EEF0FA',
            animation: 'cxpulse 1.6s ease-in-out infinite',
          }}
        />
      )}
      {kind === 'pending' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '1.5px solid #D9DCE3',
            boxSizing: 'border-box',
            flex: 'none',
          }}
        />
      )}
      {hasTail && <span style={{ flex: 1, width: 1.5, background: '#EFF1F5', margin: '3px 0' }} />}
    </div>
  );
}

// A sub-thread child row (prototype L1158–1166): the inner "▸ name Lx ● meta" rows under a sub-card.
function ChildRow({ node }: { node: ThreadChildNode }) {
  const L = useVocab();
  const navigate = useNavigate();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        border: '1px solid #EFF1F5',
        background: '#fff',
        borderRadius: 7,
        padding: '5.5px 9px',
        marginTop: 6,
      }}
    >
      <span style={{ color: '#B6BDC9', fontSize: 9 }}>▸</span>
      <span style={{ font: "600 10.5px 'IBM Plex Mono',monospace", color: '#22262E' }}>
        {node.templateName ?? node.id}
      </span>
      <span style={{ font: "400 9px 'IBM Plex Mono',monospace", color: '#B6BDC9' }}>
        L{nodeLevel(node)}
      </span>
      {node.status === 'running' && (
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
      <span style={{ fontSize: 9.5, color: '#98A1B0' }}>{formatCost(node.costUsd)}</span>
      <span
        onClick={() => navigate(`/threads/${node.id}`)}
        style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, color: '#4655D4', cursor: 'pointer' }}
      >
        {L.rpOpen} ›
      </span>
    </div>
  );
}

// A sub-card in the active step (prototype L1147–1170): a subthread, expandable to its child rows.
function SubthreadCard({ node }: { node: ThreadChildNode }) {
  const [expanded, setExpanded] = useState(false);
  const pill = threadPill(node.status);
  const running = node.status === 'running';
  const iconColor = running ? '#4655D4' : '#8A93A2';
  return (
    <div
      style={{
        border: '1px solid ' + (running ? '#E3E6F5' : '#EFF1F5'),
        background: running ? '#FBFBFE' : '#FBFBFC',
        borderRadius: 8,
      }}
    >
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', cursor: 'pointer' }}
      >
        <span style={{ color: '#8A93A2', fontSize: 9 }}>{expanded ? '▾' : '▸'}</span>
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={iconColor} strokeWidth="1.8">
          <path d="M7 1.5v5M7 6.5 3.5 10M7 6.5l3.5 3.5" />
          <circle cx="7" cy="1.5" r="1.4" fill={iconColor} stroke="none" />
          <circle cx="3.5" cy="11" r="1.4" fill={iconColor} stroke="none" />
          <circle cx="10.5" cy="11" r="1.4" fill={iconColor} stroke="none" />
        </svg>
        <span style={{ font: "600 11px 'IBM Plex Mono',monospace", color: '#191C22' }}>
          {node.templateName ?? node.id}
        </span>
        <span style={{ font: "400 9px 'IBM Plex Mono',monospace", color: '#B6BDC9' }}>L{nodeLevel(node)}</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 9.5,
            fontWeight: 600,
            padding: '1.5px 7px',
            borderRadius: 999,
            background: pill.bg,
            color: pill.fg,
          }}
        >
          {pill.text}
        </span>
      </div>
      {expanded && (
        <div style={{ padding: '0 10px 8px 27px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#5B6472' }}>
            <span>{node.id}</span>
            <span style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: '#98A1B0' }}>
              {formatCost(node.costUsd)}
            </span>
          </div>
          {node.children.map((ch) => (
            <ChildRow key={ch.id} node={ch} />
          ))}
        </div>
      )}
    </div>
  );
}

// A machine-dispatch sub-card in the active step (prototype's Execute-step children).
function DispatchCard({ dispatch }: { dispatch: ThreadDispatchInfo }) {
  const { open } = useExecutionLogDrawer();
  return (
    <div
      onClick={() => open(dispatch.executionId)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        border: '1px solid #EFF1F5',
        background: '#FBFBFC',
        borderRadius: 8,
        padding: '7px 10px',
        cursor: 'pointer',
      }}
    >
      <span style={{ font: "600 10.5px 'IBM Plex Mono',monospace", color: '#22262E' }}>
        {dispatch.executionId}
      </span>
      <span style={{ fontSize: 10.5, color: '#5B6472' }}>{dispatch.machine ?? 'local'}</span>
      <span style={{ marginLeft: 'auto', font: "400 9px 'IBM Plex Mono',monospace", color: '#98A1B0' }}>
        {dispatch.type}
      </span>
    </div>
  );
}

function StepRow({
  step,
  isLast,
  detail,
}: {
  step: ThreadStepDetail;
  isLast: boolean;
  detail: ThreadDetail;
}) {
  const L = useVocab();
  const kind = stepDotKind(step);
  const active = kind === 'running';
  const dispatches = active ? dispatchesForStep(detail, step) : [];
  const subthreads = active ? detail.children : [];
  const hasSubs = dispatches.length > 0 || subthreads.length > 0;
  const meta = stepMeta(step);
  return (
    <>
      <StepDot kind={kind} hasTail={!isLast} />
      <div style={{ paddingBottom: isLast ? 4 : 9 }}>
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: active ? 600 : 500,
              color: active ? '#191C22' : kind === 'done' ? '#5B6472' : '#B6BDC9',
            }}
          >
            {step.stage ?? `${L.rpStep} ${step.stepIndex + 1}`}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              font: "400 9.5px 'IBM Plex Mono',monospace",
              color: active ? '#4655D4' : '#B6BDC9',
            }}
          >
            {meta}
          </span>
        </div>
        {hasSubs && (
          <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {dispatches.map((d) => (
              <DispatchCard key={d.executionId} dispatch={d} />
            ))}
            {subthreads.map((n) => (
              <SubthreadCard key={n.id} node={n} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function CardBody({ detail, threadId }: { detail: ThreadDetail; threadId: string }) {
  const L = useVocab();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useThreadGetLiveSync(threadId);
  const cancel = useMutation(
    trpc.threads.cancel.mutationOptions({
      onSettled: () => {
        queryClient.invalidateQueries(trpc.threads.list.queryFilter());
        queryClient.invalidateQueries(trpc.threads.get.queryFilter({ threadId }));
      },
    }),
  );
  return (
    <>
      {detail.steps.length > 0 && (
        <div style={{ padding: '10px 14px 4px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '16px 1fr', columnGap: 9 }}>
            {detail.steps.map((step) => (
              <StepRow
                key={step.stepIndex}
                step={step}
                isLast={step.stepIndex === detail.steps.length - 1}
                detail={detail}
              />
            ))}
          </div>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 13,
          padding: '8px 14px',
          borderTop: '1px solid #EFF1F5',
        }}
      >
        {/* GAP-P: no threads pause mutate op in the contract — inert affordance (flagged, Stage later). */}
        <span
          title="Pause has no backend mutate op yet"
          style={{ fontSize: 11.5, fontWeight: 600, color: '#5B6472', cursor: 'not-allowed', opacity: 0.6 }}
        >
          {L.pause}
        </span>
        <span
          data-cancel-thread-id={threadId}
          onClick={() => cancel.mutate({ threadId })}
          style={{ fontSize: 11.5, fontWeight: 600, color: '#C03D33', cursor: 'pointer' }}
        >
          {L.cancel}
        </span>
        <span
          onClick={() => navigate(`/threads/${threadId}`)}
          style={{ fontSize: 11.5, fontWeight: 600, color: '#4655D4', cursor: 'pointer' }}
        >
          {L.detailPage}
        </span>
        <span style={{ marginLeft: 'auto', font: "500 10px 'IBM Plex Mono',monospace", color: '#98A1B0' }}>
          Σ {formatCost(detail.totalCostUsd)}
        </span>
      </div>
    </>
  );
}

export interface RightThreadCardProps {
  thread: ThreadInfo;
  now: number;
}

export function RightThreadCard({ thread, now }: RightThreadCardProps) {
  // Running threads default-open (matches the proto-shot's expanded experiment-pipeline); others
  // collapse to header-only and lazy-fetch threads.get on open.
  const L = useVocab();
  const [open, setOpen] = useState(thread.status === 'running');
  const trpc = useTRPC();
  const detailQuery = useQuery({
    ...trpc.threads.get.queryOptions({ threadId: thread.id }),
    enabled: open,
  });

  const pill = threadPill(thread.status);
  const iconColor = thread.status === 'running' ? '#4655D4' : '#8A93A2';
  const detail = open ? detailQuery.data : undefined;
  const dots = detail ? depthInfo(detail) : null;
  const hasDots = !!dots && dots.filled > 1;

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #E7E9EE',
        borderRadius: 10,
        boxShadow: '0 1px 2px rgba(16,24,40,.03)',
      }}
    >
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: '11px 14px 9px',
          cursor: 'pointer',
          borderBottom: '1px solid ' + (open ? '#F3F4F7' : 'transparent'),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-flex', color: iconColor, stroke: iconColor }}>{NODE_ICON}</span>
          <span style={{ font: "600 12.5px 'IBM Plex Mono',monospace", color: '#191C22' }}>
            {thread.templateName}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10.5,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 999,
              background: pill.bg,
              color: pill.fg,
            }}
          >
            {pill.text}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
          <span style={{ font: "400 10.5px 'IBM Plex Mono',monospace", color: '#98A1B0' }}>
            {threadMetaLine(thread, now)}
          </span>
          {hasDots && dots && (
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{ font: "500 9px 'IBM Plex Mono',monospace", color: '#98A1B0', marginRight: 2 }}>
                {L.rpDepth}
              </span>
              {Array.from({ length: dots.total }).map((_, i) => (
                <span
                  key={i}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: i < dots.filled ? '#4655D4' : '#E7E9EE',
                  }}
                />
              ))}
              <span style={{ font: "500 9px 'IBM Plex Mono',monospace", color: '#5B6472', marginLeft: 2 }}>
                {dots.text}
              </span>
            </span>
          )}
        </div>
      </div>
      {open && detailQuery.isPending && (
        <div style={{ padding: '10px 14px', fontSize: 11, color: '#98A1B0' }}>{L.rpLoadingThread}</div>
      )}
      {open && detailQuery.isError && (
        <div style={{ padding: '10px 14px', fontSize: 11, color: '#C03D33' }}>
          {L.rpFailedLoadThread}
        </div>
      )}
      {open && detail && <CardBody detail={detail} threadId={thread.id} />}
    </div>
  );
}
