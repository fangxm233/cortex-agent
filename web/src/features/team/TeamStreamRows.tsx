import { createContext, useContext, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { fmt, useLangOptional, useVocabOptional, type Vocab } from '@/i18n';
import { useNowTick } from '@/lib/useNowTick';
import type { TimeLang } from '@/i18n/time-format';
import { TeamRowSlot, type TeamRowRenderer } from '@/features/session/transcript/team-row-slot';
import { EventIcon, eventRowStyle, type EventIconName } from '@/features/session/transcript/EventRow';
import {
  headlineUpdate, messageTimeLabel, type TeamActionView, type TeamChatRow, type TeamUpdatesRow, type WorkerThread,
  type WorkerUpdate,
} from '@/features/session/transcript/transcript-vm';
import { workerDotStyle } from './TeamRoster';
import { workerState, workerStatusText } from './worker-roster';
import { isInactiveWorker } from './worker-groups';
import {
  findWorker, requestState, spawnedWorker, updateTimeRange, waitedWorkers, waitingRequest,
} from './team-stream';

// Team rows in a lead's chat (see the transcript's team-rows): the lead's actions on its workers as
// quiet one-line rows (a spawn with its brief under it), and its workers' traffic as one update line
// per worker per run — the transcript's quiet line (see EventRow), opening to the run's timeline.
// A card's status comes from the live team, and only on each worker's latest card: an older card is
// history. The status is the dot's to show (its words ride the line's tooltip and accessible name);
// the trailing slot always says when. Routine updates read quieter than what the lead acts on,
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
const TIME: CSSProperties = { fontSize: 12, color: 'var(--proto-faint)', flex: 'none', whiteSpace: 'nowrap' };
/** One worker's line: the transcript's quiet line, so a run of worker traffic reads like the rest of
 *  the turn's record instead of a card in the middle of it. */
function lineStyle(touch: boolean): CSSProperties {
  return { ...eventRowStyle(touch, true), color: 'var(--proto-muted)' };
}
const ICON_BOX: CSSProperties = { width: 16, height: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' };
// The name keeps its width (up to a cap) and the headline gives way first: on a phone a clipped name
// tells the reader nothing, a clipped headline still says what it was about.
const NAME: CSSProperties = { ...ELLIPSIS, flex: 'none', maxWidth: '45%', fontWeight: 550, color: 'var(--proto-ink-3)' };
const META: CSSProperties = { marginLeft: 'auto', paddingLeft: 12, flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--proto-faint)' };
const VERB: CSSProperties = { fontSize: 13, fontWeight: 550, color: 'var(--proto-ink-3)', flex: 'none' };
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
  // A name in the line, not a capsule: the dot carries the worker's state, the name opens it.
  const style: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 1 auto', minWidth: 0, maxWidth: 220, padding: 0,
    border: 0, background: 'transparent', borderRadius: 4,
    fontSize: 'inherit', fontWeight: 550, color: 'var(--proto-ink-2)', lineHeight: 'inherit',
  };
  const content = <><Dot worker={worker} /><span style={ELLIPSIS}>{name}</span></>;
  if (!open) return <span data-worker-pill={name} style={style}>{content}</span>;
  return (
    <button type="button" data-worker-pill={name} className={MENU_FOCUS} title={L.wbTeamOpenWorker}
      onClick={(event) => { event.stopPropagation(); open(); }}
      style={{ ...style, cursor: 'pointer', fontFamily: 'inherit' }}>
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
      style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 550, color: 'var(--proto-accent)', flex: 'none' }}>
      {label} ↗
    </button>
  );
}

// ── lead actions ────────────────────────────────────────────────────────────────────────────────

function actionVerb(action: TeamActionView, L: Vocab): string {
  switch (action.op) {
    case 'spawn': return L.wbTeamActSpawn;
    case 'send': return L.wbTeamActSend;
    case 'stop': return L.wbTeamActStop;
    case 'answer':
      if (action.approved === true) return L.wbTeamActApproved;
      if (action.approved === false) return L.wbTeamActRejected;
      return L.wbTeamActAnswered;
  }
}

/** The action's mark in the line's icon column. */
function actionIcon(action: TeamActionView): { name: EventIconName; color?: string } {
  switch (action.op) {
    case 'spawn': return { name: 'plus', color: 'var(--proto-accent)' };
    case 'send': return { name: 'arrow' };
    case 'stop': return { name: 'stop' };
    case 'answer':
      if (action.approved === true) return { name: 'check', color: 'var(--proto-success)' };
      if (action.approved === false) return { name: 'cross', color: 'var(--proto-danger)' };
      return { name: 'reply' };
  }
}

function ActionIcon({ action }: { action: TeamActionView }): JSX.Element {
  const { name, color } = actionIcon(action);
  return <span style={{ ...ICON_BOX, color: color ?? 'var(--proto-faint)' }}><EventIcon name={name} /></span>;
}

function fullText(text: string, partial: boolean): string {
  return partial ? `${text}…` : text;
}

/** A spawn: who was started, with the first two lines of the brief. The model is a detail: on desktop
 *  it trails the name and gives way before the name; on a phone there is
 *  no width for it beside the name and the open link, so it moves to the line's tooltip and the
 *  opened brief. */
function SpawnCard({ action, touch }: { action: TeamActionView; touch: boolean }): JSX.Element {
  const L = useVocabOptional();
  const { workers } = useStream();
  const [open, setOpen] = useState(false);
  const worker = findWorker(workers, action.worker) ?? (action.worker ? null : spawnedWorker(workers, action.text));
  const name = action.worker ?? worker?.workerName ?? null;
  const title = [actionVerb(action, L), name, action.model].filter(Boolean).join(' · ');
  return (
    <div data-team-action="spawn" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div title={title} style={{ display: 'flex', alignItems: 'center', gap: touch ? 9 : 10, minWidth: 0, minHeight: touch ? 40 : 30, fontSize: touch ? 13.5 : 13 }}>
        <ActionIcon action={action} />
        <span style={VERB}>{actionVerb(action, L)}</span>
        {name && <WorkerPill name={name} worker={worker} />}
        {action.model && !touch && (
          <span data-spawn-model="" style={{ ...ELLIPSIS, flex: '0 1000 auto', fontSize: 12, color: 'var(--proto-faint)' }}>{action.model}</span>
        )}
        <span style={{ flex: 1 }} />
        <OpenLink worker={worker} label={L.wbTeamOpenShort} />
      </div>
      {action.text && (
        <div {...toggleKeys(() => setOpen((v) => !v))} aria-expanded={open}
          title={open ? L.wbTeamHideFull : L.wbTeamShowFull}
          style={{ ...BODY, fontSize: touch ? 13 : 12.5, lineHeight: 1.55, color: 'var(--proto-muted)', cursor: 'pointer', paddingLeft: 26, ...(open ? { color: 'var(--proto-ink-2)' } : CLAMP2) }}>
          {open && touch && action.model && (
            <div data-spawn-model="" style={{ fontSize: 12, color: 'var(--proto-faint)', marginBottom: 2 }}>{action.model}</div>
          )}
          {open ? <ChatMarkdown text={fullText(action.text, action.partial)} /> : action.text}
        </div>
      )}
    </div>
  );
}

function ActionLineContent({ action, open }: { action: TeamActionView; open: boolean }): JSX.Element {
  const L = useVocabOptional();
  const { workers } = useStream();
  const worker = findWorker(workers, action.worker);
  const message = action.op === 'stop' ? null : action.text;
  const time = messageTimeLabel(action.ts ?? undefined);
  return (
    <>
      <ActionIcon action={action} />
      <span style={VERB}>{actionVerb(action, L)}</span>
      {action.worker && <WorkerPill name={action.worker} worker={worker} />}
      {message && (
        <span data-team-action-preview="" style={{ ...ELLIPSIS, flex: '0 1000 auto', color: 'var(--proto-muted)' }}>
          {open ? null : message}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {time && <span style={TIME}>{time}</span>}
    </>
  );
}

/** send / answer / stop: one line, the message clipped; a tap shows it whole. */
function ActionLine({ action, touch }: { action: TeamActionView; touch: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const canOpen = action.op !== 'stop' && !!action.text;
  const line = (
    <div data-team-action={action.op} {...(canOpen ? toggleKeys(() => setOpen((v) => !v)) : {})}
      aria-expanded={canOpen ? open : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: touch ? 9 : 10, minWidth: 0, padding: 0,
        minHeight: touch ? 40 : 30, fontSize: touch ? 13.5 : 13, color: 'var(--proto-muted)',
        cursor: canOpen ? 'pointer' : undefined,
      }}>
      <ActionLineContent action={action} open={open} />
    </div>
  );
  if (!open || !action.text) return line;
  return (
    <div>
      {line}
      <div data-team-action-body="" style={{ ...BODY, margin: '0 0 4px 26px', padding: '2px 0 6px' }}>
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
  fontSize: 11, fontWeight: 600, padding: '0 6px', borderRadius: 5, marginRight: 6, whiteSpace: 'nowrap', display: 'inline-block', lineHeight: '17px',
};
const TAG_PLAN: CSSProperties = { ...TAG_BASE, background: 'var(--proto-amber-bg)', color: 'var(--proto-amber-fg)', boxShadow: 'inset 0 0 0 1px var(--proto-amber-border)' };
const TAG_QUESTION: CSSProperties = { ...TAG_BASE, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' };
const TAG_OK: CSSProperties = { ...TAG_BASE, background: 'var(--proto-success-bg)', color: 'var(--proto-success)' };
const TAG_BAD: CSSProperties = { ...TAG_BASE, background: 'var(--proto-danger-bg)', color: 'var(--proto-danger)' };

/** The word a request or a failed turn is tagged with; null for an ordinary report or routine line. */
function kindLabel(update: WorkerUpdate, L: Vocab): string | null {
  if (update.kind === 'plan') return L.wbTeamTagPlan;
  if (update.kind === 'question') return L.wbTeamTagQuestion;
  if (update.outcome) return update.outcome === 'failed' ? L.wbTeamOutcomeFailed : L.wbTeamOutcomeStopped;
  return null;
}

/** The kind tag before a request's line, and the outcome of a turn that went wrong. `plain` drops the
 *  pill for the one-line form, where a coloured word is enough. */
function KindTag({ update, plain = false }: { update: WorkerUpdate; plain?: boolean }): JSX.Element | null {
  const L = useVocabOptional();
  const text = kindLabel(update, L);
  if (!text) return null;
  const style = update.kind === 'plan' ? TAG_PLAN : update.kind === 'question' ? TAG_QUESTION : TAG_BAD;
  return plain
    ? <span style={{ color: style.color, fontWeight: 550, marginRight: 6 }}>{text}</span>
    : <span style={style}>{text}</span>;
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
          {showName && <span style={{ fontWeight: 550, color: 'var(--proto-ink-2)' }}>{update.worker} · </span>}
          <KindTag update={update} />
          {!open && update.line}
          <AnswerTag update={update} />
        </div>
        {open && (
          <div data-team-update-body="" style={{ ...BODY, fontSize: touch ? 13.5 : 12.5, marginTop: 2 }}>
            {update.body && <ChatMarkdown text={update.body} wideTables={!touch} dropTrailingHr={touch} />}
            {update.answer?.text && (
              <div style={{ marginTop: 6, paddingLeft: 10, borderLeft: '2px solid var(--proto-line-3)' }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-muted)' }}>{L.wbTeamLeadReply}</div>
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

type ThreadStatusKind = 'waiting' | ReturnType<typeof workerState> | 'history';

/** Where a worker's run stands, in words: an open request, the live status on the worker's latest
 *  card, or nothing on an older card (that one is history). The words go into the line's tooltip and
 *  accessible name — the dot already shows the state, and the trailing slot is for the time. */
function threadStatus(thread: WorkerThread, worker: SessionInfo | null, waiting: WorkerUpdate | null, now: number, L: Vocab, lang: TimeLang): { kind: ThreadStatusKind; text: string | null } {
  if (waiting) return { kind: 'waiting', text: waiting.kind === 'plan' ? L.wbTeamPlanWaiting : L.wbTeamQuestionWaiting };
  if (thread.latest && worker && !isInactiveWorker(worker, now)) {
    return { kind: workerState(worker), text: workerStatusText(worker, now, L, lang) };
  }
  return { kind: 'history', text: null };
}

/** The line's trailing slot: when it happened — the headline's time, or an older card's span where
 *  there is room for it. Never a status word. */
function ThreadTime({ thread, shown, range }: { thread: WorkerThread; shown: WorkerUpdate; range: boolean }): JSX.Element | null {
  const when = (range && !thread.latest ? updateTimeRange(thread.updates) : null) ?? messageTimeLabel(shown.ts ?? undefined);
  return when ? <span data-thread-time="" style={TIME}>{when}</span> : null;
}

/** The line's tooltip and accessible name: who, the kind tag, what it said, and where it stands. */
function threadLabel(name: string, shown: WorkerUpdate, parts: (string | null)[], L: Vocab): string {
  const said = [kindLabel(shown, L), shown.line].filter(Boolean).join(' ');
  return [name, said, ...parts].filter(Boolean).join(' · ');
}

/** One worker's run as one line — dot · name · what it said · when — that opens to the run's
 *  timeline. Where the run stands (an open request, the worker's live status) is the dot's and the
 *  tooltip's to say. */
function SingleCard({ row, touch, now }: { row: TeamUpdatesRow; touch: boolean; now: number }): JSX.Element {
  const L = useVocabOptional();
  const lang = useLangOptional();
  const { workers } = useStream();
  const [open, setOpen] = useState(false);
  const thread = row.threads[0];
  const worker = findWorker(workers, thread.worker, thread.sessionId);
  const waiting = waitingRequest(thread, worker);
  const shown = headlineUpdate(thread.updates);
  const state = requestState(thread, L, worker);
  const status = threadStatus(thread, worker, waiting, now, L, lang);
  const label = threadLabel(thread.worker, shown, [status.text, waiting ? null : state], L);
  return (
    <div data-team-card="" data-team-card-open={open ? 'true' : undefined} style={{ opacity: row.pending ? 0.55 : 1, minWidth: 0 }}>
      <div {...toggleKeys(() => setOpen((v) => !v))} aria-expanded={open} aria-label={label} title={label}
        data-thread-status={status.kind}
        className={`${MENU_FOCUS}${touch ? '' : ' hover:bg-[var(--proto-gray)]'}`} style={lineStyle(touch)}>
        <span style={ICON_BOX}><Dot worker={thread.latest ? worker : null} /></span>
        <span style={NAME}>{thread.worker}</span>
        <span data-team-headline={shown.kind} style={{ ...ELLIPSIS, color: lineInk(shown) }}>
          <KindTag update={shown} plain />{shown.line}
        </span>
        <span style={META}><ThreadTime thread={thread} shown={shown} range={!touch} /></span>
      </div>
      {open && (
        <div style={{ padding: touch ? '0 0 4px 17px' : '0 0 4px 18px' }}>
          <Timeline updates={thread.updates} showName={false} touch={touch} />
          {worker && (
            <div style={{ display: 'flex', padding: '0 0 4px 8px' }}>
              <OpenLink worker={worker} label={L.wbTeamOpenWorker} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Several workers in one run: one line per worker with its headline; the timeline opens below. */
function MultiCard({ row, touch, now }: { row: TeamUpdatesRow; touch: boolean; now: number }): JSX.Element {
  const L = useVocabOptional();
  const lang = useLangOptional();
  const { workers } = useStream();
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  const n = row.updates.length;
  return (
    <div data-team-card="" data-team-card-open={open ? 'true' : undefined} style={{ opacity: row.pending ? 0.55 : 1, minWidth: 0 }}>
      {row.threads.map((thread) => {
        const worker = findWorker(workers, thread.worker, thread.sessionId);
        const waiting = waitingRequest(thread, worker);
        const shown = waiting ?? headlineUpdate(thread.updates);
        const status = threadStatus(thread, worker, waiting, now, L, lang);
        const label = threadLabel(thread.worker, shown, [status.text], L);
        return (
          <div key={thread.worker} data-team-thread={thread.worker} {...toggleKeys(toggle)} aria-label={label} title={label}
            data-thread-status={status.kind}
            className={`${MENU_FOCUS}${touch ? '' : ' hover:bg-[var(--proto-gray)]'}`} style={lineStyle(touch)}>
            <span style={ICON_BOX}><Dot worker={thread.latest ? worker : null} /></span>
            <span style={NAME}>{thread.worker}</span>
            <span data-team-headline={shown.kind} style={{ ...ELLIPSIS, color: lineInk(shown) }}>
              <KindTag update={shown} plain />{shown.line}
            </span>
            <span style={META}><ThreadTime thread={thread} shown={shown} range={false} /></span>
          </div>
        );
      })}
      {open && (
        <div style={{ padding: touch ? '0 0 4px 17px' : '0 0 4px 18px' }}>
          <Timeline updates={row.updates} showName touch={touch} />
        </div>
      )}
      <button type="button" className={MENU_FOCUS} aria-expanded={open} onClick={toggle}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 0, background: 'transparent', cursor: 'pointer', padding: touch ? '6px 0 6px 26px' : '2px 0 2px 26px', fontFamily: 'inherit', fontSize: 12, color: 'var(--proto-faint)' }}>
        {n === 1 ? L.wbTeamItemsOne : fmt(L.wbTeamItemsMany, { n })} · {open ? L.wbTeamHideFull : L.wbTeamExpandTimeline}
        <Chevron open={open} />
      </button>
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
    text = <>{before}<span style={{ fontWeight: 550, color: 'var(--proto-ink-2)' }}>{waited[0].workerName ?? ''}</span>{after}</>;
  } else {
    text = fmt(L.wbTeamLeadWaitingMany, { n: waited.length });
  }
  return (
    <div data-lead-waiting="" style={{ display: 'flex', alignItems: 'center', gap: touch ? 9 : 10, marginTop: offset, minHeight: touch ? 36 : 28, fontSize: touch ? 13 : 12.5, color: 'var(--proto-muted)' }}>
      <span style={{ width: 16, display: 'flex', justifyContent: 'center', flex: 'none' }}>
        <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', boxSizing: 'border-box', border: '1.5px solid var(--proto-muted-3)', flex: 'none' }} />
      </span>
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
