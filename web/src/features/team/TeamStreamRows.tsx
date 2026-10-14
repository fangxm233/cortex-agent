import { createContext, useContext, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { MENU_FOCUS, MONO } from '@/design/MenuChrome';
import { fmt, useLangOptional, useVocabOptional, type Vocab } from '@/i18n';
import { useNowTick } from '@/lib/useNowTick';
import { TeamRowSlot, type TeamRowRenderer } from '@/features/session/transcript/team-row-slot';
import {
  headlineUpdate, messageTimeLabel, type TeamActionView, type TeamChatRow, type TeamUpdatesRow, type WorkerThread,
  type WorkerUpdate,
} from '@/features/session/transcript/transcript-vm';
import { workerDotStyle } from './TeamRoster';
import { workerState, workerStatusText } from './worker-roster';
import {
  findWorker, spawnedWorker, threadSummary, updateTimeRange, waitedWorkers, waitingRequest,
} from './team-stream';

// Team rows in a lead's chat (see the transcript's team-rows): the lead's actions on its workers as
// quiet one-line rows (a spawn as a small card), and its workers' traffic as one update card per run.
// A card's status comes from the live team, and only on each worker's latest card: an older card is
// history and shows when it happened instead. Routine updates read quieter than what the lead acts on,
// and a collapsed card leads with the latest report or request rather than the latest routine line.
// The desktop stream and the mobile stream draw the same rows; `touch` sizes them for a finger.

interface TeamStream {
  workers: SessionInfo[];
  /** The lead's own turn is live — the "waiting on workers" line stays away meanwhile. */
  leadRunning: boolean;
  onOpenWorker?: (sessionId: string) => void;
}

const TeamStreamContext = createContext<TeamStream>({ workers: [], leadRunning: false });

const NOW_TICK_MS = 30_000;
const ELLIPSIS: CSSProperties = { minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const CLAMP2: CSSProperties = {
  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minWidth: 0,
  overflowWrap: 'anywhere',
};
const TIME: CSSProperties = { font: `400 11px ${MONO}`, color: 'var(--proto-faint)', flex: 'none', whiteSpace: 'nowrap' };
const CARD: CSSProperties = {
  background: 'var(--material-card-bg)', boxShadow: 'var(--material-card-shadow)',
  border: '1px solid var(--proto-line-2)', borderRadius: 'var(--r-card)', overflow: 'hidden',
};
/** Ink of an update's line: routine reads quieter than a report or request. */
function lineInk(update: WorkerUpdate, strong = false): string {
  if (update.kind === 'progress') return 'var(--proto-muted)';
  return strong ? 'var(--proto-ink)' : 'var(--proto-ink-2)';
}
const BODY: CSSProperties = { fontSize: 12.5, lineHeight: 1.6, color: 'var(--proto-ink-2)', minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word' };

function useStream(): TeamStream {
  return useContext(TeamStreamContext);
}

function toggleKeys(toggle: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: toggle,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    },
  };
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flex: 'none', transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform 160ms ease' }}>
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

/** The roster's dot language. Without a worker (unknown to the live team, or an older card that is
 *  history rather than status) the dot reads idle. */
function Dot({ worker }: { worker: SessionInfo | null }): JSX.Element {
  if (!worker) {
    return <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: 'var(--proto-line-3)' }} />;
  }
  const running = workerState(worker) === 'running';
  return (
    <span aria-hidden="true" data-worker-dot={workerState(worker)}
      style={{ ...workerDotStyle(worker, 7), ...(running ? { animation: 'cxring 1.8s ease-out infinite' } : null) }} />
  );
}

/** A worker named inline: dot + name. Opens the worker's session when the team knows it. */
function WorkerPill({ name, worker }: { name: string; worker: SessionInfo | null }): JSX.Element {
  const L = useVocabOptional();
  const { onOpenWorker } = useStream();
  const open = worker && onOpenWorker ? () => onOpenWorker(worker.sessionId) : null;
  const style: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none', maxWidth: 220, padding: '1px 8px 1px 6px',
    borderRadius: 'var(--r-pill)', background: 'var(--material-control-bg)', border: '1px solid var(--proto-line-2)',
    font: `500 11.5px ${MONO}`, color: 'var(--proto-ink-2)', lineHeight: '18px',
  };
  const content = <><Dot worker={worker} /><span style={ELLIPSIS}>{name}</span></>;
  if (!open) return <span data-worker-pill={name} style={style}>{content}</span>;
  return (
    <button type="button" data-worker-pill={name} className={MENU_FOCUS} title={L.wbTeamOpenWorker}
      onClick={(event) => { event.stopPropagation(); open(); }}
      style={{ ...style, cursor: 'pointer', fontFamily: MONO }}>
      {content}
    </button>
  );
}

function OpenLink({ worker, label }: { worker: SessionInfo | null; label: string }): JSX.Element | null {
  const { onOpenWorker } = useStream();
  if (!worker || !onOpenWorker) return null;
  return (
    <button type="button" data-open-worker="" className={MENU_FOCUS}
      onClick={(event) => { event.stopPropagation(); onOpenWorker(worker.sessionId); }}
      style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', font: `500 11px ${MONO}`, color: 'var(--proto-accent)', flex: 'none' }}>
      {label} ↗
    </button>
  );
}

// ── lead actions ────────────────────────────────────────────────────────────────────────────────

function actionVerb(action: TeamActionView, L: Vocab): string {
  switch (action.op) {
    case 'spawn': return `＋ ${L.wbTeamActSpawn}`;
    case 'send': return `→ ${L.wbTeamActSend}`;
    case 'stop': return `■ ${L.wbTeamActStop}`;
    case 'answer':
      if (action.approved === true) return `✓ ${L.wbTeamActApproved}`;
      if (action.approved === false) return `✗ ${L.wbTeamActRejected}`;
      return `↩ ${L.wbTeamActAnswered}`;
  }
}

function fullText(text: string, partial: boolean): string {
  return partial ? `${text}…` : text;
}

/** A spawn: who was started, on what model, with the first two lines of the brief. */
function SpawnCard({ action, touch }: { action: TeamActionView; touch: boolean }): JSX.Element {
  const L = useVocabOptional();
  const { workers } = useStream();
  const [open, setOpen] = useState(false);
  const worker = findWorker(workers, action.worker) ?? (action.worker ? null : spawnedWorker(workers, action.text));
  const name = action.worker ?? worker?.workerName ?? null;
  return (
    <div data-team-action="spawn" style={{ ...CARD, padding: touch ? '9px 12px' : '8px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ font: `600 11px ${MONO}`, color: 'var(--proto-accent)', flex: 'none' }}>{actionVerb(action, L)}</span>
        {name && <WorkerPill name={name} worker={worker} />}
        {action.model && <span style={{ ...ELLIPSIS, font: `400 11px ${MONO}`, color: 'var(--proto-muted)' }}>{action.model}</span>}
        <span style={{ flex: 1 }} />
        <OpenLink worker={worker} label={L.wbTeamOpenShort} />
      </div>
      {action.text && (
        <div {...toggleKeys(() => setOpen((v) => !v))} aria-expanded={open}
          title={open ? L.wbTeamHideFull : L.wbTeamShowFull}
          style={{ ...BODY, fontSize: touch ? 13 : 12.5, lineHeight: 1.5, cursor: 'pointer', ...(open ? {} : CLAMP2) }}>
          {open ? <ChatMarkdown text={fullText(action.text, action.partial)} /> : action.text}
        </div>
      )}
    </div>
  );
}

/** send / answer / stop: one line, the message clipped; a tap shows it whole. */
function ActionLine({ action, touch }: { action: TeamActionView; touch: boolean }): JSX.Element {
  const L = useVocabOptional();
  const { workers } = useStream();
  const [open, setOpen] = useState(false);
  const worker = findWorker(workers, action.worker);
  const message = action.op === 'stop' ? (action.retire ? L.wbTeamActRetire : null) : action.text;
  const canOpen = action.op !== 'stop' && !!action.text;
  const time = messageTimeLabel(action.ts ?? undefined);
  const line = (
    <div data-team-action={action.op} {...(canOpen ? toggleKeys(() => setOpen((v) => !v)) : {})}
      aria-expanded={canOpen ? open : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, padding: touch ? '4px 0' : '2px 2px',
        minHeight: touch ? 30 : undefined, fontSize: touch ? 13 : 12.5, color: 'var(--proto-muted)',
        cursor: canOpen ? 'pointer' : undefined,
      }}>
      <span style={{ font: `600 11px ${MONO}`, letterSpacing: '.02em', color: 'var(--proto-muted)', flex: 'none' }}>{actionVerb(action, L)}</span>
      {action.worker && <WorkerPill name={action.worker} worker={worker} />}
      {message && (
        <span style={{ ...ELLIPSIS, color: action.op === 'stop' ? 'var(--proto-muted)' : 'var(--proto-ink-2)' }}>
          {open ? null : message}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {time && <span style={TIME}>{time}</span>}
    </div>
  );
  if (!open || !action.text) return line;
  return (
    <div>
      {line}
      <div data-team-action-body="" style={{ ...BODY, margin: '2px 0 4px 22px', padding: '6px 12px', borderLeft: '2px solid var(--proto-accent-border)' }}>
        <ChatMarkdown text={fullText(action.text, action.partial)} />
      </div>
    </div>
  );
}

export function TeamActionRow({ action, touch = false }: { action: TeamActionView; touch?: boolean }): JSX.Element {
  return action.op === 'spawn' ? <SpawnCard action={action} touch={touch} /> : <ActionLine action={action} touch={touch} />;
}

// ── worker updates ──────────────────────────────────────────────────────────────────────────────

const TAG_BASE: CSSProperties = {
  font: `600 10.5px ${MONO}`, padding: '0 6px', borderRadius: 5, marginRight: 6, whiteSpace: 'nowrap', display: 'inline-block', lineHeight: '16px',
};
const TAG_PLAN: CSSProperties = { ...TAG_BASE, background: 'var(--proto-amber-bg)', color: 'var(--proto-amber-fg)', boxShadow: 'inset 0 0 0 1px var(--proto-amber-border)' };
const TAG_QUESTION: CSSProperties = { ...TAG_BASE, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' };
const TAG_OK: CSSProperties = { ...TAG_BASE, background: 'var(--proto-success-bg)', color: 'var(--proto-success)' };
const TAG_BAD: CSSProperties = { ...TAG_BASE, background: 'var(--proto-danger-bg)', color: 'var(--proto-danger)' };

/** The kind tag before a request's line, and the outcome of a turn that went wrong. */
function KindTag({ update }: { update: WorkerUpdate }): JSX.Element | null {
  const L = useVocabOptional();
  if (update.kind === 'plan') return <span style={TAG_PLAN}>{L.wbTeamTagPlan}</span>;
  if (update.kind === 'question') return <span style={TAG_QUESTION}>{L.wbTeamTagQuestion}</span>;
  if (update.outcome) return <span style={TAG_BAD}>{update.outcome === 'failed' ? L.wbTeamOutcomeFailed : L.wbTeamOutcomeStopped}</span>;
  return null;
}

/** How the lead settled a request: "Lead approved 10:06" / "Answered 10:06". */
function AnswerTag({ update }: { update: WorkerUpdate }): JSX.Element | null {
  const L = useVocabOptional();
  const a = update.answer;
  if (!a) return null;
  const time = messageTimeLabel(a.ts ?? undefined) ?? '';
  const text = update.kind === 'plan'
    ? fmt(a.approved === false ? L.wbTeamLeadRejectedAt : L.wbTeamLeadApprovedAt, { time })
    : fmt(L.wbTeamAnsweredAt, { time });
  return <span style={{ ...(a.approved === false ? TAG_BAD : TAG_OK), marginLeft: 6, marginRight: 0 }}>{text.trim()}</span>;
}

/** One timeline entry: time + one line; a tap opens the full text (and the lead's reply). */
function TimelineItem({ update, last, showName, touch }: { update: WorkerUpdate; last: boolean; showName: boolean; touch: boolean }): JSX.Element {
  const L = useVocabOptional();
  const [open, setOpen] = useState(false);
  return (
    <div data-team-update={update.kind} {...toggleKeys(() => setOpen((v) => !v))} aria-expanded={open}
      className={touch ? undefined : 'hover:bg-[var(--proto-gray)]'}
      style={{ display: 'grid', gridTemplateColumns: 'minmax(42px, max-content) minmax(0, 1fr)', gap: 8, padding: touch ? '6px 4px' : '5px 4px', borderRadius: 6, cursor: 'pointer' }}>
      <span style={{ ...TIME, paddingTop: 2 }}>{messageTimeLabel(update.ts ?? undefined) ?? ''}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ ...(open ? { overflowWrap: 'anywhere' } : ELLIPSIS), fontSize: touch ? 13 : 12.5, lineHeight: 1.55, color: lineInk(update, last) }}>
          {showName && <span style={{ font: `500 11px ${MONO}`, color: 'var(--proto-ink-2)' }}>{update.worker} · </span>}
          <KindTag update={update} />
          {!open && update.line}
          <AnswerTag update={update} />
        </div>
        {open && (
          <div data-team-update-body="" style={{ ...BODY, fontSize: touch ? 13.5 : 12.5, marginTop: 2 }}>
            {update.body && <ChatMarkdown text={update.body} wideTables={!touch} dropTrailingHr={touch} />}
            {update.answer?.text && (
              <div style={{ marginTop: 6, paddingLeft: 10, borderLeft: '2px solid var(--proto-line-3)' }}>
                <div style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-muted)', letterSpacing: '.04em' }}>{L.wbTeamLeadReply}</div>
                <ChatMarkdown text={fullText(update.answer.text, update.answer.partial)} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Timeline({ updates, showName, touch }: { updates: WorkerUpdate[]; showName: boolean; touch: boolean }): JSX.Element {
  return (
    <div data-team-timeline="" onClick={(event) => event.stopPropagation()} style={{ padding: '2px 8px 6px 8px' }}>
      {updates.map((u, i) => <TimelineItem key={i} update={u} last={i === updates.length - 1} showName={showName} touch={touch} />)}
    </div>
  );
}

/** Live status on a worker's latest card; when it happened on an older one. */
function ThreadStatus({ thread, worker, waiting, now, range = true }: {
  thread: WorkerThread; worker: SessionInfo | null; waiting: WorkerUpdate | null; now: number;
  /** Show when an older card happened; off where the row already carries its time. */
  range?: boolean;
}): JSX.Element | null {
  const L = useVocabOptional();
  const lang = useLangOptional();
  const base: CSSProperties = { font: `400 11px ${MONO}`, whiteSpace: 'nowrap', flex: 'none' };
  if (waiting) {
    return <span data-thread-status="waiting" style={{ ...base, color: 'var(--proto-ink-2)', fontWeight: 600 }}>
      {waiting.kind === 'plan' ? L.wbTeamPlanWaiting : L.wbTeamQuestionWaiting}
    </span>;
  }
  if (thread.latest && worker && worker.workerRetiredAt == null) {
    const state = workerState(worker);
    const color = state === 'running' ? 'var(--proto-accent)' : 'var(--proto-muted)';
    return <span data-thread-status={state} style={{ ...base, color }}>{workerStatusText(worker, now, L, lang)}</span>;
  }
  const when = range ? updateTimeRange(thread.updates) : null;
  return when ? <span data-thread-status="history" style={{ ...base, color: 'var(--proto-muted)' }}>{when}</span> : null;
}

/** One worker's run: header (dot · name · status · summary), its headline update, the timeline open. */
function SingleCard({ row, touch, now }: { row: TeamUpdatesRow; touch: boolean; now: number }): JSX.Element {
  const L = useVocabOptional();
  const { workers } = useStream();
  const [open, setOpen] = useState(false);
  const thread = row.threads[0];
  const worker = findWorker(workers, thread.worker, thread.sessionId);
  const waiting = waitingRequest(thread, worker);
  const shown = headlineUpdate(thread.updates);
  return (
    <div data-team-card="" data-team-card-open={open ? 'true' : undefined}
      style={{ ...CARD, opacity: row.pending ? 0.55 : 1 }}>
      <div {...toggleKeys(() => setOpen((v) => !v))} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: open ? '8px 12px 6px' : '8px 12px 2px', cursor: 'pointer', minWidth: 0 }}>
        <Dot worker={thread.latest ? worker : null} />
        <span style={{ ...ELLIPSIS, flex: '0 1 auto', fontSize: touch ? 14 : 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{thread.worker}</span>
        <ThreadStatus thread={thread} worker={worker} waiting={waiting} now={now} range={!touch} />
        <span style={{ flex: 1 }} />
        <span style={{ ...ELLIPSIS, flex: '0 100 auto', font: `500 11px ${MONO}`, color: 'var(--proto-muted)' }}>{threadSummary(thread, L, worker)}</span>
        <span style={{ color: 'var(--proto-muted)', display: 'inline-flex' }}><Chevron open={open} /></span>
      </div>
      {!open && (
        <div {...toggleKeys(() => setOpen(true))}
          style={{ display: 'flex', alignItems: 'flex-end', gap: 10, padding: '3px 12px 9px 27px', cursor: 'pointer' }}>
          <span data-team-headline={shown.kind} style={{ ...CLAMP2, flex: 1, fontSize: touch ? 13.5 : 13, lineHeight: 1.55, color: lineInk(shown) }}>
            <KindTag update={shown} />{shown.line}
          </span>
          <span style={TIME}>{messageTimeLabel(shown.ts ?? undefined) ?? ''}</span>
        </div>
      )}
      {open && (
        <>
          <Timeline updates={thread.updates} showName={false} touch={touch} />
          {worker && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 12px 8px' }}>
              <OpenLink worker={worker} label={L.wbTeamOpenWorker} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Several workers in one run: one row per worker with its headline line; the timeline opens below. */
function MultiCard({ row, touch, now }: { row: TeamUpdatesRow; touch: boolean; now: number }): JSX.Element {
  const L = useVocabOptional();
  const { workers } = useStream();
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  const n = row.updates.length;
  return (
    <div data-team-card="" data-team-card-open={open ? 'true' : undefined} style={{ ...CARD, opacity: row.pending ? 0.55 : 1 }}>
      {row.threads.map((thread, i) => {
        const worker = findWorker(workers, thread.worker, thread.sessionId);
        const waiting = waitingRequest(thread, worker);
        const shown = waiting ?? headlineUpdate(thread.updates);
        return (
          // A phone puts the line under the name: beside it, it would be cut to a few characters.
          <div key={thread.worker} data-team-thread={thread.worker} {...toggleKeys(toggle)}
            style={{
              display: 'grid', alignItems: 'center', columnGap: 8, rowGap: 2,
              gridTemplateColumns: touch ? '10px auto minmax(0, 1fr) auto' : '10px auto auto minmax(0, 1fr) auto',
              padding: touch ? '8px 12px' : '6px 12px', cursor: 'pointer', fontSize: touch ? 13 : 12.5,
              borderTop: i > 0 ? '1px solid var(--proto-line-2)' : undefined,
            }}>
            <Dot worker={thread.latest ? worker : null} />
            <span style={{ ...ELLIPSIS, maxWidth: 180, fontWeight: 600, color: 'var(--proto-ink)' }}>{thread.worker}</span>
            {touch
              ? <span style={{ minWidth: 0, display: 'flex' }}><ThreadStatus thread={thread} worker={worker} waiting={waiting} now={now} range={false} /></span>
              : <ThreadStatus thread={thread} worker={worker} waiting={waiting} now={now} range={false} />}
            <span data-team-headline={shown.kind} style={{ ...ELLIPSIS, color: lineInk(shown), ...(touch ? { gridRow: 2, gridColumn: '2 / 5' } : {}) }}>
              {/* The status already names an open request. */}
              {!waiting && <KindTag update={shown} />}{shown.line}
            </span>
            <span style={{ ...TIME, ...(touch ? { gridRow: 1, gridColumn: 4 } : {}) }}>{messageTimeLabel(shown.ts ?? undefined) ?? ''}</span>
          </div>
        );
      })}
      {open && (
        <div style={{ borderTop: '1px solid var(--proto-line-2)', paddingTop: 4 }}>
          <Timeline updates={row.updates} showName touch={touch} />
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 12px 6px' }}>
        <button type="button" className={MENU_FOCUS} aria-expanded={open} onClick={toggle}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 0, background: 'transparent', cursor: 'pointer', padding: touch ? '6px 0' : 0, font: `500 11px ${MONO}`, color: 'var(--proto-muted)' }}>
          {n === 1 ? L.wbTeamItemsOne : fmt(L.wbTeamItemsMany, { n })} · {open ? L.wbTeamHideFull : L.wbTeamExpandTimeline}
          <Chevron open={open} />
        </button>
      </div>
    </div>
  );
}

export function TeamUpdateCard({ row, touch = false }: { row: TeamUpdatesRow; touch?: boolean }): JSX.Element | null {
  const now = useNowTick(true, NOW_TICK_MS);
  if (row.threads.length === 0) return null;
  return row.threads.length === 1
    ? <SingleCard row={row} touch={touch} now={now} />
    : <MultiCard row={row} touch={touch} now={now} />;
}

export function TeamRow({ row, touch = false }: { row: TeamChatRow; touch?: boolean }): JSX.Element | null {
  return row.kind === 'team-action'
    ? <TeamActionRow action={row.action} touch={touch} />
    : <TeamUpdateCard row={row} touch={touch} />;
}

/** The stream's last line while the lead is idle and its workers are still out: who it waits on. */
export function LeadWaitingLine({ touch = false, offset = 0 }: {
  touch?: boolean;
  /** Space above the line, for a stream that does not space its rows itself. */
  offset?: number;
}): JSX.Element | null {
  const L = useVocabOptional();
  const { workers, leadRunning } = useStream();
  const waited = useMemo(() => waitedWorkers(workers), [workers]);
  if (leadRunning || waited.length === 0) return null;
  let text: ReactNode;
  if (waited.length === 1) {
    const [before, after] = L.wbTeamLeadWaitingOne.split('{name}');
    text = <>{before}<span style={{ font: `500 11.5px ${MONO}`, color: 'var(--proto-ink-2)' }}>{waited[0].workerName ?? ''}</span>{after}</>;
  } else {
    text = fmt(L.wbTeamLeadWaitingMany, { n: waited.length });
  }
  return (
    <div data-lead-waiting="" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: offset, padding: '4px 2px', fontSize: touch ? 12.5 : 12, color: 'var(--proto-muted)' }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', boxSizing: 'border-box', border: '1.5px solid var(--proto-muted-3)', flex: 'none' }} />
      <span style={{ minWidth: 0 }}>{text}</span>
    </div>
  );
}

const SLOT: TeamRowRenderer = {
  row: (row) => <TeamRow row={row} />,
  // The desktop stream's rows sit 18px apart; the line follows them outside that column.
  tail: <LeadWaitingLine offset={14} />,
};

/** Gives the stream below it the live team its team rows draw from, and (desktop) the renderer the
 *  transcript asks for. Mount it around any chat whose transcript can hold team rows. */
export function TeamStreamProvider({ workers, leadRunning, onOpenWorker, children }: TeamStream & { children: ReactNode }): JSX.Element {
  const value = useMemo(() => ({ workers, leadRunning, onOpenWorker }), [workers, leadRunning, onOpenWorker]);
  return (
    <TeamStreamContext.Provider value={value}>
      <TeamRowSlot.Provider value={SLOT}>{children}</TeamRowSlot.Provider>
    </TeamStreamContext.Provider>
  );
}
