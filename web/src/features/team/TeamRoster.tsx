import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { MENU_FOCUS, MENU_SURFACE, MONO, useDismissMenu } from '@/design/MenuChrome';
import { fmt, useLangOptional, useVocabOptional } from '@/i18n';
import { useNowTick } from '@/lib/useNowTick';
import { useWorkerQuestions } from './useWorkerQuestions';
import {
  teamRoster, teamSummary, workerDoing, workerState, workerStatusText, workerTitle, type TeamRoster,
} from './worker-roster';

// The lead's view of its team: a summary (dot stack + counts) that opens a list with one row per
// worker — its status and for how long, and what it is doing. The desktop header hangs the list off
// a capsule; the mobile chat puts the same list in a sheet.

const STACK_MAX = 6;
const NOW_TICK_MS = 30_000;

/** The rail's dot language: amber = blocked on you, accent = running, hollow ring = waiting on a
 *  machine, faint = idle. */
export function workerDotStyle(s: SessionInfo, size = 6): CSSProperties {
  const base: CSSProperties = { width: size, height: size, borderRadius: '50%', boxSizing: 'border-box', flex: 'none' };
  switch (workerState(s)) {
    case 'you': return { ...base, background: 'var(--proto-amber)' };
    case 'running': return { ...base, background: 'var(--proto-accent)' };
    case 'waiting': return { ...base, border: '1.5px solid var(--proto-muted-3)' };
    case 'idle': return { ...base, background: 'var(--proto-line-3)' };
  }
}

/** A running worker's dot breathes; the app's reduced-motion setting stills it. */
function WorkerDot({ worker }: { worker: SessionInfo }): JSX.Element {
  const running = workerState(worker) === 'running';
  return (
    <span aria-hidden="true" data-worker-dot={workerState(worker)}
      style={{ ...workerDotStyle(worker, 7), ...(running ? { animation: 'cxring 1.8s ease-out infinite' } : null) }} />
  );
}

/** Up to six dots, attention first. */
export function WorkerDotStack({ workers }: { workers: SessionInfo[] }): JSX.Element {
  return (
    <span aria-hidden="true" data-worker-stack="" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flex: 'none' }}>
      {workers.slice(0, STACK_MAX).map((w) => <span key={w.sessionId} style={workerDotStyle(w, 7)} />)}
    </span>
  );
}

/** "8 workers · 5 running" — the running count in mono. A worker never waits on the user (its
 *  questions go to the lead), so the summary carries no amber. */
export function TeamSummaryLabel({ active }: { active: SessionInfo[] }): JSX.Element {
  const s = teamSummary(active, useVocabOptional());
  return (
    <span style={{ minWidth: 0, fontSize: 12.5, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      <span style={{ color: 'var(--proto-ink-2)' }}>{s.workers}</span>
      {s.running && <span style={{ font: `500 11.5px/1.2 ${MONO}`, color: 'var(--proto-muted)' }}>{' · '}{s.running}</span>}
    </span>
  );
}

function Chevron({ open, direction = 'down' }: { open: boolean; direction?: 'down' | 'right' }): JSX.Element {
  const turn = direction === 'down' ? (open ? 180 : 0) : (open ? 90 : 0);
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flex: 'none', transform: `rotate(${turn}deg)`, transition: 'transform 160ms ease' }}>
      <path d={direction === 'down' ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} />
    </svg>
  );
}

const ELLIPSIS: CSSProperties = { minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

function statusColor(s: SessionInfo): CSSProperties {
  switch (workerState(s)) {
    case 'you': return { color: 'var(--proto-amber-fg)', fontWeight: 600 };
    case 'running': return { color: 'var(--proto-accent)' };
    default: return { color: 'var(--proto-muted)' };
  }
}

function WorkerRow({ worker, question, now, touch, hover, setHover, onOpen }: {
  worker: SessionInfo;
  question: string | null;
  now: number;
  touch: boolean;
  hover: string | null;
  setHover: (id: string | null) => void;
  onOpen: (sessionId: string) => void;
}): JSX.Element {
  const L = useVocabOptional();
  const lang = useLangOptional();
  const id = worker.sessionId;
  const idle = workerState(worker) === 'idle';
  const doing = workerDoing(worker, question);
  return (
    <button
      type="button"
      data-worker-row={id}
      className={MENU_FOCUS}
      onClick={() => onOpen(id)}
      onMouseEnter={() => setHover(id)}
      onMouseLeave={() => setHover(hover === id ? null : hover)}
      style={{
        display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr) auto', columnGap: 8, rowGap: 3,
        alignItems: 'center', width: '100%', minHeight: touch ? 48 : undefined,
        padding: touch ? '9px 10px' : '7px 10px', border: 0, borderRadius: 'var(--r-chip)', textAlign: 'left',
        cursor: 'pointer', fontFamily: 'inherit', background: hover === id ? 'var(--proto-gray)' : 'transparent',
      }}
    >
      <span style={{ display: 'grid', placeItems: 'center' }}><WorkerDot worker={worker} /></span>
      <span style={{
        ...ELLIPSIS, fontSize: touch ? 14 : 13, fontWeight: worker.unread ? 600 : 400,
        color: worker.unread ? 'var(--proto-ink)' : idle ? 'var(--proto-muted)' : 'var(--proto-ink-2)',
      }}>
        {workerTitle(worker)}
      </span>
      <span data-worker-status="" style={{ font: `400 11px ${MONO}`, whiteSpace: 'nowrap', ...statusColor(worker) }}>
        {workerStatusText(worker, now, L, lang)}
      </span>
      {doing && (
        <span data-worker-doing="" style={{ ...ELLIPSIS, gridColumn: '2 / 4', fontSize: touch ? 12.5 : 11.5, color: 'var(--proto-muted)' }}>
          {doing}
        </span>
      )}
    </button>
  );
}

/** One row per worker, attention first; inactive workers fold away at the bottom, dimmed. */
export function TeamRosterList({ roster, questions, touch = false, onOpen }: {
  roster: TeamRoster;
  /** Pending questions of the sessions waiting on the user, by sessionId. */
  questions: Record<string, string>;
  /** Mobile: taller rows for touch. */
  touch?: boolean;
  onOpen: (sessionId: string) => void;
}): JSX.Element {
  const L = useVocabOptional();
  const now = useNowTick(true, NOW_TICK_MS);
  const [hover, setHover] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const row = (w: SessionInfo) => (
    <WorkerRow key={w.sessionId} worker={w} question={questions[w.sessionId] ?? null} now={now} touch={touch}
      hover={hover} setHover={setHover} onOpen={onOpen} />
  );
  const meta: CSSProperties = { font: `500 11px ${MONO}`, color: 'var(--proto-muted)' };
  return (
    <div data-team-list="" role="group" aria-label={L.wbTeamWorkers}>
      <div style={{ ...meta, display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 10px 8px' }}>
        <span>{fmt(L.wbTeamPanelTitle, { n: roster.active.length })}</span>
        <span style={ELLIPSIS}>{L.wbTeamPanelHint}</span>
      </div>
      {roster.active.map(row)}
      {roster.inactive.length > 0 && (
        <>
          <div style={{ height: 1, background: 'var(--proto-line)', margin: '4px 10px' }} />
          <button type="button" data-team-inactive="" className={MENU_FOCUS} aria-expanded={showInactive}
            onClick={() => setShowInactive((v) => !v)}
            style={{
              ...meta, fontWeight: 400, display: 'inline-flex', alignItems: 'center', gap: 4, border: 0,
              background: 'transparent', cursor: 'pointer', borderRadius: 'var(--r-chip)',
              padding: touch ? '12px 10px' : '6px 10px 4px',
            }}>
            {fmt(L.wbTeamInactive, { n: roster.inactive.length })}
            <Chevron open={showInactive} direction="right" />
          </button>
          {showInactive && <div data-team-inactive-rows="" style={{ opacity: 0.55 }}>{roster.inactive.map(row)}</div>}
        </>
      )}
    </div>
  );
}

/** The list with the questions of whatever waits on the user; mounted only while it is shown. */
export function TeamRosterPanel({ roster, touch, onOpen }: {
  roster: TeamRoster;
  touch?: boolean;
  onOpen: (sessionId: string) => void;
}): JSX.Element {
  const questions = useWorkerQuestions(roster.active);
  return <TeamRosterList roster={roster} questions={questions} touch={touch} onOpen={onOpen} />;
}

/** Desktop: the lead's chat header carries its team as one capsule; it opens the list as a popover.
 *  Nothing while the lead has no active worker. */
export function TeamCapsule({ workers, onOpen }: {
  workers: SessionInfo[];
  onOpen: (sessionId: string) => void;
}): JSX.Element | null {
  const L = useVocabOptional();
  const roster = useMemo(() => teamRoster(workers), [workers]);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useDismissMenu(open, close, close);
  if (roster.active.length === 0) return null;
  const lit = open || hover;
  return (
    <span style={{ position: 'relative', display: 'inline-flex', marginRight: 4 }}>
      <button
        type="button"
        data-team-capsule=""
        className={MENU_FOCUS}
        aria-expanded={open}
        aria-label={L.wbTeamWorkers}
        onClick={(event) => { event.stopPropagation(); setOpen((v) => !v); }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, height: 28, maxWidth: 420, padding: '0 9px',
          border: 0, borderRadius: 'var(--r-chip)', cursor: 'pointer', fontFamily: 'inherit',
          background: lit ? 'var(--proto-card)' : 'color-mix(in srgb, var(--proto-card) 60%, transparent)',
          boxShadow: `0 0 0 1px ${open ? 'var(--proto-line-3)' : 'var(--proto-line)'}`,
          color: 'var(--proto-muted)',
        }}
      >
        <WorkerDotStack workers={roster.active} />
        <TeamSummaryLabel active={roster.active} />
        <Chevron open={open} />
      </button>
      {open && (
        <div
          data-team-panel=""
          onClick={(event) => event.stopPropagation()}
          style={{
            position: 'absolute', right: 0, top: 34, width: 380, maxHeight: '70vh', overflowY: 'auto',
            boxSizing: 'border-box', padding: 6, ...MENU_SURFACE,
            border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)', zIndex: 40,
          }}
        >
          <TeamRosterPanel roster={roster} onOpen={(id) => { close(); onOpen(id); }} />
        </div>
      )}
    </span>
  );
}
