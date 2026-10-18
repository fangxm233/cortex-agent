import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import { fmt, useLangOptional, useVocabOptional, type Vocab } from '@/i18n';
import { formatSpanPrecise } from '@/i18n/time-format';
import type { WorkStats } from './turn-layout';
import type { WaitpointView } from './wait-rows';
import { EventIcon, EventRow, PulseDot } from './EventRow';
import { useWorkLogMode } from './work-log-pref';

// A turn's work as one line — "Worked for 3m 20s · 49 tool calls · 1 subagent" — that opens to the
// tool runs, thoughts and working notes it stands for (see turn-layout). It is open while the turn
// is being written, so the reader watches the work happen, and folds once the turn has answered;
// a reader's own toggle wins over both, and the Appearance setting can keep every log open.
//
// Also here: the session's state where the conversation ends — background work still running, or
// a waitpoint the agent is asleep on — because a reply that says "I'll report back" reads as
// finished unless the stream says something is still on its way.

/** What the stream knows about the session beyond its rows. */
export interface TranscriptStatus {
  /** The foreground turn ended but background work holds the session open. */
  backgroundRunning: boolean;
  /** Waitpoints still armed (the only kind the server lists). */
  waitpoints: readonly WaitpointInfo[];
}

const TranscriptStatusContext = createContext<TranscriptStatus>({ backgroundRunning: false, waitpoints: [] });

export function TranscriptStatusProvider({ backgroundRunning, waitpoints, children }: TranscriptStatus & { children: ReactNode }): JSX.Element {
  const value = useMemo(() => ({ backgroundRunning, waitpoints }), [backgroundRunning, waitpoints]);
  return <TranscriptStatusContext.Provider value={value}>{children}</TranscriptStatusContext.Provider>;
}

export function useTranscriptStatus(): TranscriptStatus {
  return useContext(TranscriptStatusContext);
}

/** The summary line's two halves: what state the work is in, and what it consisted of. */
export function workSummary(stats: WorkStats, live: boolean, L: Vocab, lang: 'en' | 'zh'): { label: string; detail: string } {
  let label = L.chatWorkLive;
  if (!live) {
    const ms = stats.startTs && stats.endTs ? Date.parse(stats.endTs) - Date.parse(stats.startTs) : NaN;
    label = Number.isFinite(ms) && ms >= 1000 ? fmt(L.chatWorkDone, { time: formatSpanPrecise(ms, lang) }) : L.chatWorkUntimed;
  }
  const parts: string[] = [];
  if (stats.toolCalls > 0) parts.push(fmt(stats.toolCalls === 1 ? L.msgToolCallOne : L.msgToolCallMany, { n: stats.toolCalls }));
  if (stats.subagents > 0) parts.push(stats.subagents === 1 ? L.chatWorkSubagentOne : fmt(L.chatWorkSubagentMany, { n: stats.subagents }));
  return { label, detail: parts.join(' · ') };
}

export function WorkLog({ stats, live, touch = false, children, footer }: {
  stats: WorkStats;
  /** This is where the running turn's next rows land. */
  live: boolean;
  touch?: boolean;
  /** The work's rows, already rendered by the stream that owns them. */
  children: ReactNode;
  /** Rendered under the summary line whether or not the log is open (the turn's copy action). */
  footer?: ReactNode;
}): JSX.Element {
  const L = useVocabOptional();
  const lang = useLangOptional();
  const mode = useWorkLogMode();
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? (live || mode === 'expanded');
  const { label, detail } = workSummary(stats, live, L, lang);
  return (
    <div data-work-log="" data-work-live={live ? 'true' : undefined} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <EventRow
        touch={touch}
        icon={live ? <PulseDot /> : <EventIcon name="chevron" open={open} />}
        label={label}
        labelInk={live ? 'var(--proto-ink)' : undefined}
        summary={detail}
        expanded={open}
        ariaLabel={`${open ? L.chatWorkHide : L.chatWorkShow}: ${label}${detail ? ` · ${detail}` : ''}`}
        onClick={() => setOverride(!open)}
        attrs={{ 'data-work-summary': '' }}
      />
      {open && (
        <div data-work-log-body="" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: touch ? '2px 0 6px 25px' : '2px 0 6px 26px', minWidth: 0 }}>
          {children}
        </div>
      )}
      {footer}
    </div>
  );
}

/** A waitpoint the turn armed. While it is still armed the line says so; once it is gone from the
 *  armed list its signal (or expiry) has come back as a turn of its own further down. */
export function WaitpointRow({ wait, touch = false }: { wait: WaitpointView; touch?: boolean }): JSX.Element {
  const L = useVocabOptional();
  const { waitpoints } = useTranscriptStatus();
  const armed = !!wait.label && waitpoints.some((w) => w.state === 'armed' && w.label === wait.label);
  return (
    <EventRow
      touch={touch}
      attrs={{ 'data-waitpoint': armed ? 'armed' : 'settled' }}
      icon={armed ? <PulseDot color="var(--proto-amber)" /> : <EventIcon name="hourglass" />}
      label={L.chatWaitLabel}
      summary={wait.label ?? L.chatWaitUnnamed}
      title={wait.intent ?? undefined}
      meta={armed ? L.chatWaitArmed : undefined}
    />
  );
}

/** The last line of the stream while the agent is idle but not done: background work holding the
 *  session, or armed waitpoints it will be woken by. Nothing while the turn itself is running. */
export function SessionStateLine({ running, touch = false, offset = 0 }: {
  running: boolean;
  touch?: boolean;
  /** Space above the line, for a stream that does not space its rows itself. */
  offset?: number;
}): JSX.Element | null {
  const L = useVocabOptional();
  const { backgroundRunning, waitpoints } = useTranscriptStatus();
  const armed = waitpoints.filter((w) => w.state === 'armed');
  let text: string | null = null;
  if (backgroundRunning) text = L.chatTailBackground;
  else if (!running && armed.length === 1) text = fmt(L.chatTailWaitOne, { label: armed[0].label });
  else if (!running && armed.length > 1) text = fmt(L.chatTailWaitMany, { n: armed.length });
  if (!text) return null;
  return (
    <div data-session-state={backgroundRunning ? 'background' : 'waiting'}
      style={{ display: 'flex', alignItems: 'center', gap: touch ? 9 : 10, marginTop: offset, minHeight: touch ? 36 : 28, fontSize: touch ? 13 : 12.5, color: 'var(--proto-muted)' }}>
      <span style={{ width: 16, display: 'flex', justifyContent: 'center', flex: 'none' }}>
        <PulseDot color={backgroundRunning ? 'var(--proto-accent)' : 'var(--proto-amber)'} />
      </span>
      <span style={{ minWidth: 0 }}>{text}</span>
    </div>
  );
}
