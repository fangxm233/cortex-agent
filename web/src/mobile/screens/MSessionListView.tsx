import { type CSSProperties } from 'react';
import { PlusGlyph } from '@/design';
import { StarredSessionGroup } from '@/features/session/list/StarredSessionGroup';
import type { ConnectionStatus } from '@/features/connection/connection-status';
import { MScreen, MTabHeader, type MTabTitleMenu, MScrollBody, MGroupLabel, MEmpty, MC, M_FLOAT_BOTTOM, M_GUTTER, M_NUM, M_TAB_BODY_PADDING } from '@/mobile/ui/kit';
import { fmt, useVocabOptional } from '@/i18n';
import { sessionSections, type MSessionRow, type MSessionSectionKey, type MSessionStatus } from './m-session-list-vm';

const PRESENCE: Record<ConnectionStatus, string> = {
  connected: 'var(--proto-success)',
  connecting: 'var(--proto-amber)',
  reconnecting: 'var(--proto-amber)',
  disconnected: MC.muted,
};

// The brand mark carrying the live link state as a presence dot. Bare on the header bar — no tile
// of its own, so the header holds one frame at most.
function BrandTile({ presence }: { presence: ConnectionStatus }) {
  return (
    <div aria-hidden="true" style={{ position: 'relative', width: 26, height: 26, flex: 'none', display: 'grid', placeItems: 'center' }}>
      <svg width={26} height={26} viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <circle cx="33" cy="32" r="6" fill="var(--proto-ink)" />
        <path
          d="M42.29 23.64A12.5 12.5 0 1 0 42.29 40.36"
          stroke="var(--proto-accent)"
          strokeWidth={6}
          strokeLinecap="round"
        />
        <path
          d="M48.6 17.95A21 21 0 1 0 48.6 46.05"
          stroke="var(--proto-accent)"
          strokeWidth={6}
          strokeLinecap="round"
        />
      </svg>
      <span
        style={{
          position: 'absolute',
          right: -1,
          bottom: 0,
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: PRESENCE[presence],
          boxShadow: '0 0 0 2px var(--m-canvas)',
        }}
      />
    </div>
  );
}

// The brand mark opens the Projects panel, which also slides in on a rightward swipe. Pending
// approvals ride beside it as a plain amber「需要你」count, so they stay in sight on the home screen.
function ProjectsButton({ presence, projects }: { presence: ConnectionStatus; projects: MSessionListProjects }) {
  const L = useVocabOptional();
  const count = projects.needsYou;
  const label = count > 0 ? fmt(L.slProjectsNeedYou, { n: count }) : L.projTitle;
  return (
    <button type="button" aria-label={label} data-projects-button="" onClick={projects.onOpen} style={PROJECTS_BUTTON}>
      <BrandTile presence={presence} />
      {count > 0 && <span aria-hidden="true" data-needs-you-count="" style={NEEDS_YOU_COUNT}>{count}</span>}
    </button>
  );
}

const PROJECTS_BUTTON: CSSProperties = {
  position: 'relative', minWidth: 44, height: 44, margin: '0 -4px 0 -9px', padding: '0 9px', flex: 'none',
  border: 0, background: 'transparent', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
  boxSizing: 'border-box',
};

const NEEDS_YOU_COUNT: CSSProperties = {
  fontSize: 13, fontWeight: 650, color: 'var(--proto-amber-fg)', ...M_NUM,
};

// The Scheduled entry (scheme-mobile 8a): a bare clock key in the header (the header is already the
// frame); unread schedules ride as a plain accent count — failed runs have no data source, so it
// never turns red here.
function ScheduledButton({ unread, onClick }: { unread: number; onClick: () => void }) {
  const L = useVocabOptional();
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button type="button" aria-label={L.schedSheetTitle} onClick={onClick} style={HEADER_KEY}>
        <svg width={19} height={19} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3l2 1.5" />
        </svg>
      </button>
      {unread > 0 && (
        <span aria-label={fmt(L.slUnreadScheduled, { n: unread })} style={UNREAD_SCHEDULED}>
          {unread}
        </span>
      )}
    </div>
  );
}

const HEADER_KEY: CSSProperties = {
  width: 44, height: 44, borderRadius: 'var(--r-control)', background: 'transparent', border: 0,
  color: 'var(--proto-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer', padding: 0,
};

const UNREAD_SCHEDULED: CSSProperties = {
  position: 'absolute', top: 5, right: 4, color: 'var(--proto-accent)', fontSize: 11, fontWeight: 650, ...M_NUM,
};

// A session row's status column: live and background share the accent dot with its soft halo,
// awaiting is the amber「需要你」dot, an external wait is a hollow ring, idle has no mark.
const STATUS_DOT: Record<Exclude<MSessionStatus['kind'], 'idle'>, CSSProperties> = {
  running: { background: 'var(--proto-accent)', boxShadow: '0 0 0 3px var(--proto-accent-bg)' },
  background: { background: 'var(--proto-accent)', boxShadow: '0 0 0 3px var(--proto-accent-bg)' },
  awaiting: { background: 'var(--proto-amber)' },
  'waiting-external': { border: `1.5px solid ${MC.muted}` },
};

const TRUNCATE: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

function StatusMark({ status }: { status: MSessionStatus }) {
  return (
    <span aria-hidden="true" style={{ width: 12, flex: 'none', display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
      {status.kind !== 'idle' && (
        <span data-status-dot={status.kind}
          style={{ width: 7, height: 7, borderRadius: '50%', boxSizing: 'border-box', flex: 'none', ...STATUS_DOT[status.kind] }} />
      )}
    </span>
  );
}

// The second line: what the session is doing, muted — except a row blocked on the user, whose reason
// reads in amber. Idle rows have nothing to add (the list has no last-message preview to show).
function StatusLine({ status }: { status: MSessionStatus }) {
  if (status.kind === 'idle') return null;
  const color = status.kind === 'awaiting' ? 'var(--proto-amber-fg)' : MC.muted;
  return <div style={{ marginTop: 2, fontSize: 14, color, ...M_NUM, ...TRUNCATE }}>{status.text}</div>;
}

// Time on the title line; an unread session adds the accent dot after it (mirrors the desktop rail's
// unread marker, cleared by useMarkSessionRead once the chat opens).
function RowMeta({ row }: { row: MSessionRow }) {
  const L = useVocabOptional();
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, paddingTop: 3 }}>
      <span style={{ fontSize: 13, color: MC.faint, ...M_NUM }}>{row.time}</span>
      {row.unread && <span aria-label={L.slUnread} style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--proto-accent)', flex: 'none' }} />}
    </div>
  );
}

// One row grammar: 12px status column · title over its status line · time. A live row is told by
// its dot alone — no wash; unread and needs-you rows bold their title.
function Row({ row, onOpen }: { row: MSessionRow; onOpen: (id: string) => void }) {
  const strong = row.unread || row.status.kind === 'awaiting';
  return (
    <div
      className="m-press"
      data-session-id={row.id}
      onClick={() => onOpen(row.id)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12, minHeight: 48, padding: '11px 14px',
        boxSizing: 'border-box', borderRadius: 'var(--r-control)', cursor: 'pointer',
      }}
    >
      <StatusMark status={row.status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, lineHeight: '22px', fontWeight: strong ? 650 : 550, color: MC.ink, ...TRUNCATE }}>
          {row.title}
        </div>
        <StatusLine status={row.status} />
      </div>
      <RowMeta row={row} />
    </div>
  );
}

// New session: an ink pill in thumb reach, on the list's right edge.
const FAB_STYLE: CSSProperties = {
  position: 'absolute',
  right: M_GUTTER + 10,
  bottom: M_FLOAT_BOTTOM,
  height: 50,
  padding: '0 20px 0 16px',
  border: 0,
  borderRadius: 'var(--r-pill)',
  background: MC.inkSolid,
  color: MC.inkSolidFg,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontFamily: 'var(--font-ui)',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  boxShadow: 'var(--shadow-key-lift)',
};

function SessionListHeader({ title, presence, project, projects, scheduled }: {
  title: string;
  presence: ConnectionStatus;
  project?: MSessionListProject;
  projects?: MSessionListProjects;
  scheduled?: MSessionListScheduled;
}) {
  const menu: MTabTitleMenu | undefined = project && { label: project.switchLabel, onOpen: project.onSwitch };
  return (
    <MTabHeader
      title={project?.name ?? title}
      titleMenu={menu}
      leading={projects ? <ProjectsButton presence={presence} projects={projects} /> : <BrandTile presence={presence} />}
      trailing={scheduled && <ScheduledButton unread={scheduled.unread} onClick={scheduled.onOpen} />}
    />
  );
}

const SECTION_LABEL: Record<MSessionSectionKey, 'mSectionNeedsYou' | 'mSectionActive' | 'mSectionRecent'> = {
  needsYou: 'mSectionNeedsYou',
  active: 'mSectionActive',
  recent: 'mSectionRecent',
};

/** Stars stay on top as their own fold; the rest is sectioned by status (需要你 · 进行中 · 最近). */
function SessionListBody({ rows, stars, empty, onOpen }: {
  rows: MSessionRow[];
  stars?: MSessionListStars;
  empty: string;
  onOpen: (id: string) => void;
}) {
  const L = useVocabOptional();
  return (
    <MScrollBody gap={0} padding={M_TAB_BODY_PADDING}>
      {stars && <StarredSessionGroup projectId={stars.projectId} count={stars.rows.length}
        expanded={stars.expanded} onToggle={stars.onToggle} mobile>
        {stars.rows.map((row) => <Row key={row.id} row={row} onOpen={onOpen} />)}
      </StarredSessionGroup>}
      {rows.length === 0 && !stars?.rows.length && <MEmpty>{empty}</MEmpty>}
      {sessionSections(rows).map((section) => (
        <section key={section.key} data-session-section={section.key}>
          <MGroupLabel style={{ fontSize: 13, padding: '14px 14px 2px' }}>{L[SECTION_LABEL[section.key]]}</MGroupLabel>
          {section.rows.map((row) => <Row key={row.id} row={row} onOpen={onOpen} />)}
        </section>
      ))}
      {/* Room for the FAB, so the last row can scroll clear of it. */}
      <div style={{ height: 72, flex: 'none' }} />
    </MScrollBody>
  );
}

type MSessionListStars = { projectId: string; rows: MSessionRow[]; expanded: boolean; onToggle: () => void };
type MSessionListScheduled = { unread: number; onOpen: () => void };

/** The Projects panel entry: the brand mark opens it and carries the pending-approval count. */
export interface MSessionListProjects {
  needsYou: number;
  onOpen: () => void;
}

/** The current project as the list title; tapping it opens the project switcher. */
export interface MSessionListProject {
  /** null while the current project is still resolving → the plain list title. */
  name: string | null;
  switchLabel: string;
  onSwitch: () => void;
}

export function MSessionListView({ rows, stars, presence, project, projects, newLabel, scheduled, onOpen, onNew }: {
  rows: MSessionRow[];
  stars?: MSessionListStars;
  /** Live link state → the brand tile's presence dot. */
  presence: ConnectionStatus;
  project?: MSessionListProject;
  projects?: MSessionListProjects;
  /** The new-session pill's label (vocab `wbNewSession`). */
  newLabel: string;
  /** Scheduled entry (8a): hidden while the project has no schedules and no runs. */
  scheduled?: MSessionListScheduled;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const L = useVocabOptional();
  const fab = (
    <button type="button" aria-label={newLabel} title={newLabel} onClick={onNew} style={FAB_STYLE}>
      <PlusGlyph size={16} strokeWidth={2} />
      <span aria-hidden="true">{newLabel}</span>
    </button>
  );
  return (
    <MScreen label="1a sessions" floatingHeader overlay={fab}
      header={<SessionListHeader title={L.sessions} presence={presence} project={project} projects={projects} scheduled={scheduled} />}>
      <SessionListBody rows={rows} stars={stars} empty={L.slEmpty} onOpen={onOpen} />
    </MScreen>
  );
}
