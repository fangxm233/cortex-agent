import { useState, type CSSProperties, type ReactNode } from 'react';
import type { SystemTurnOrigin } from '@cortex-agent/ui-contract';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { useVocab } from '@/i18n';
import { messageTimeLabel } from './transcript-rows';
import { systemOriginBody, systemOriginLabel, systemOriginSummary } from './system-origin';
import { DebugDetailsModal, DebugInspectButton, type DebugDetail } from './DebugDetailsModal';
import { EventIcon, type EventIconName } from './EventRow';

// Thoughts and system-authored turns share the transcript's quiet line (see EventRow): an icon, a
// label, one clipped line of what it said, and — when there is more — a body that opens under it.

const labelStyle: CSSProperties = { fontSize: 13, fontWeight: 550, color: 'var(--proto-ink-3)', flex: 'none' };
const summaryStyle: CSSProperties = { fontSize: 13, color: 'var(--proto-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const bodyStyle: CSSProperties = {
  margin: '0 0 4px 26px', padding: '2px 0 6px',
  fontSize: 13, lineHeight: 1.65, color: 'var(--proto-ink-2)', minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word',
};
const touchBodyStyle: CSSProperties = { margin: '0 0 2px 25px', fontSize: 13.5 };
const mutedBodyStyle = {
  color: 'var(--proto-muted)', '--proto-ink': 'var(--proto-muted)',
  '--proto-ink-2': 'var(--proto-muted)', '--proto-accent': 'var(--proto-muted)',
} as CSSProperties;

interface HintProps {
  label: string;
  summary: string;
  body?: string;
  origin?: SystemTurnOrigin;
  thinking?: boolean;
  pending?: boolean;
  touch?: boolean;
  extra?: ReactNode;
  icon?: EventIconName;
}

function HintSummary({ label, summary, open, canOpen, extra, touch, icon }: HintProps & { open: boolean; canOpen: boolean }): JSX.Element {
  return <>
    <span aria-hidden="true" style={{ width: 16, height: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--proto-faint)' }}>
      <EventIcon name={open ? 'chevron' : icon ?? 'reply'} open={open} />
    </span>
    <span style={{ ...labelStyle, fontSize: touch ? 13.5 : 13 }}>{label}</span>
    {summary && !open && <span title={canOpen ? undefined : summary} style={{ ...summaryStyle, fontSize: touch ? 13.5 : 13 }}>{summary}</span>}
    <span style={{ flex: 1 }} />
    {extra}
  </>;
}

/** Shared quiet transcript chrome: system hints and thoughts differ only in copy and body ink. */
export function HintRow(props: HintProps): JSX.Element {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const canOpen = !!props.body;
  const toggle = (): void => setOpen((value) => !value);
  const title = canOpen && props.origin ? (open ? L.wbTeamHideFull : L.wbTeamShowFull) : undefined;
  return <div style={{ minWidth: 0 }}>
    <div className={`group${canOpen && !props.touch ? ' hover:bg-[var(--proto-gray)]' : ''}`} data-system-origin={props.origin} data-thinking={props.thinking || undefined}
      role={canOpen ? 'button' : undefined} tabIndex={canOpen ? 0 : undefined}
      aria-expanded={canOpen ? open : undefined} title={title} aria-label={props.touch ? title : undefined}
      onClick={canOpen ? toggle : undefined}
      onKeyDown={canOpen ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } } : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: props.touch ? 9 : 10, width: 'calc(100% + 16px)', boxSizing: 'border-box',
        margin: '0 -8px', padding: '0 8px', minHeight: props.touch ? 40 : 30, borderRadius: 8,
        opacity: props.pending ? 0.55 : 1,
        animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both', cursor: canOpen ? 'pointer' : undefined }}>
      <HintSummary {...props} open={open} canOpen={canOpen} />
    </div>
    {open && canOpen && <div data-system-origin-body={props.origin ? '' : undefined} data-thinking-body={props.thinking || undefined}
      style={{ ...bodyStyle, ...(props.touch ? touchBodyStyle : {}), ...(props.thinking ? mutedBodyStyle : {}) }}>
      <ChatMarkdown text={props.body!} wideTables={!props.touch} dropTrailingHr={props.touch} />
    </div>}
  </div>;
}

export function ThinkingRow({ text, preview, touch }: { text: string; preview?: boolean; touch?: boolean }): JSX.Element {
  const L = useVocab();
  const lines = text.trim().split(/\r?\n/);
  return <HintRow thinking touch={touch} icon="spark" label={preview ? L.chatThinkingLive : L.chatThinking}
    summary={preview ? lines.at(-1) ?? '' : lines[0]} body={preview ? undefined : text} />;
}

function HintTime({ ts }: { ts?: string }): JSX.Element | null {
  const label = messageTimeLabel(ts);
  if (!label) return null;
  return <span className="opacity-0 transition-opacity group-hover:opacity-100"
    style={{ fontSize: 12, color: 'var(--proto-faint)', whiteSpace: 'nowrap', flex: 'none' }}>{label}</span>;
}

/** What produced the turn, at a glance: a waitpoint's signal, a background agent, the rest. */
function originIcon(origin: SystemTurnOrigin): EventIconName {
  if (origin === 'external-signal') return 'hourglass';
  if (origin === 'agent-result') return 'layers';
  return 'reply';
}

export function SystemHintRow({ origin, text, ts, pending, debug, expandable = false, touch }: {
  origin: SystemTurnOrigin; text: string; ts?: string; pending?: boolean;
  debug?: { agentMessage: string }; expandable?: boolean; touch?: boolean;
}): JSX.Element {
  const L = useVocab();
  const [detail, setDetail] = useState<DebugDetail | null>(null);
  return <>
    <HintRow origin={origin} icon={originIcon(origin)} label={systemOriginLabel(origin, L)} summary={systemOriginSummary(text)}
      body={expandable ? systemOriginBody(text) : undefined} pending={pending} touch={touch}
      extra={<><HintTime ts={ts} />{debug && <DebugInspectButton compact
        onClick={(event) => { event.stopPropagation(); setDetail({ kind: 'user', agentMessage: debug.agentMessage }); }} />}</>} />
    <DebugDetailsModal detail={detail} onClose={() => setDetail(null)} />
  </>;
}
