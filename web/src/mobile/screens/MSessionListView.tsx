import { type CSSProperties } from 'react';
import { PlusGlyph } from '@/design';
import { StarredSessionGroup } from '@/features/session/list/StarredSessionGroup';
import type { ConnectionStatus } from '@/features/connection/connection-status';
import { MScreen, MTabHeader, type MTabTitleMenu, MScrollBody, MGroup, MEmpty, MC, M_FLOAT_BOTTOM, M_GUTTER, M_NUM, M_TAB_BODY_PADDING } from '@/mobile/ui/kit';
import { fmt, useVocabOptional } from '@/i18n';
import type { MSessionRow, MSessionStatus } from './m-session-list-vm';

function isLive(status: MSessionStatus): boolean {
  // A turn or a background task is actually advancing. `awaiting` is blocked ON the user, so it
  // keeps its amber semantics and stays out of this.
  return status.kind === 'running' || status.kind === 'background';
}

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
// approvals ride on it as the amber「需要你」count, so they stay in sight on the home screen.
function ProjectsButton({ presence, projects }: { presence: ConnectionStatus; projects: MSessionListProjects }) {
  const L = useVocabOptional();
  const count = projects.needsYou;
  const label = count > 0 ? fmt(L.slProjectsNeedYou, { n: count }) : L.projTitle;
  return (
    <button type="button" aria-label={label} data-projects-button="" onClick={projects.onOpen} style={PROJECTS_BUTTON}>
      <BrandTile presence={presence} />
      {count > 0 && <span aria-hidden="true" style={NEEDS_YOU_BADGE}>{count}</span>}
    </button>
  );
}

const PROJECTS_BUTTON: CSSProperties = {
  position: 'relative', width: 44, height: 44, margin: '0 -9px', padding: 0, flex: 'none',
  border: 0, background: 'transparent', display: 'grid', placeItems: 'center', cursor: 'pointer',
};

const NEEDS_YOU_BADGE: CSSProperties = {
  // Over the mark's top-right corner, clear of the title.
  position: 'absolute', top: 3, left: 22, minWidth: 16, height: 16, padding: '0 4px', boxSizing: 'border-box',
  borderRadius: 'var(--r-pill)', background: 'var(--proto-amber)', color: 'var(--amber-fill-fg)',
  fontSize: 11, fontWeight: 600, ...M_NUM, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  boxShadow: '0 0 0 2px var(--m-canvas)',
};

// The Scheduled entry (scheme-mobile 8a): a bare clock key in the header pill (the pill is already
// the frame); unread schedules ride as a badge (blue — failed runs have no data source, so the badge
// never turns red here).
function ScheduledButton({ unread, onClick }: { unread: number; onClick: () => void }) {
  const L = useVocabOptional();
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        aria-label={L.schedSheetTitle}
        onClick={onClick}
        style={{
          width: 44,
          height: 44,
          borderRadius: 'var(--r-control)',
          background: 'transparent',
          border: 0,
          color: 'var(--proto-muted)',
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <svg width={18} height={18} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4}>
          <circle cx="7" cy="7" r="5.6" />
          <path d="M7 4v3.2l2.2 1.3" />
        </svg>
      </button>
      {unread > 0 && (
        <span
          aria-label={fmt(L.slUnreadScheduled, { n: unread })}
          style={{
            position: 'absolute',
            top: 4,
            right: 2,
            background: MC.run,
            color: 'var(--ink-solid-fg)',
            fontSize: 11,
            fontWeight: 600,
            ...M_NUM,
            padding: '1px 4.5px',
            borderRadius: 'var(--r-pill)',
          }}
        >
          {unread}
        </span>
      )}
    </div>
  );
}

// A session row's status glyph: live and background share the run-blue dot, awaiting is the amber
// 「需要你」dot, an external wait is a hollow ring.
const STATUS_GLYPH: Record<Exclude<MSessionStatus['kind'], 'idle'>, CSSProperties> = {
  running: { background: 'var(--proto-accent)' },
  background: { background: 'var(--proto-accent)' },
  awaiting: { background: 'var(--proto-amber)' },
  'waiting-external': { border: `1.5px solid ${MC.muted}` },
};

const STATUS_COLOR: Record<MSessionStatus['kind'], string> = {
  running: 'var(--proto-accent)',
  background: 'var(--proto-accent)',
  awaiting: 'var(--proto-amber-fg)',
  'waiting-external': MC.muted,
  idle: MC.muted,
};

const TRUNCATE: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

function StatusLine({ status }: { status: MSessionStatus }) {
  if (status.kind === 'idle') return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 12, color: STATUS_COLOR[status.kind], ...M_NUM }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', boxSizing: 'border-box', flex: 'none', ...STATUS_GLYPH[status.kind] }} />
      <span style={{ minWidth: 0, ...TRUNCATE }}>{status.text}</span>
    </div>
  );
}

// Time on the title line; an unread session adds the accent dot after it (mirrors the desktop rail's
// unread marker, cleared by useMarkSessionRead once the chat opens).
function RowMeta({ row, twoLine }: { row: MSessionRow; twoLine: boolean }) {
  const L = useVocabOptional();
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, alignSelf: twoLine ? 'flex-start' : 'center', paddingTop: twoLine ? 2 : 0 }}>
      <span style={{ fontSize: 12, color: row.unread ? 'var(--proto-accent)' : MC.muted, ...M_NUM }}>{row.time}</span>
      {row.unread && <span aria-label={L.slUnread} style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--proto-accent)', flex: 'none' }} />}
    </div>
  );
}

// A live row takes a faint accent wash so a running session stands out while scanning the list.
const LIVE_WASH = 'color-mix(in srgb, var(--proto-accent) 7%, transparent)';

function Row({ row, onOpen }: { row: MSessionRow; onOpen: (id: string) => void }) {
  const twoLine = row.status.kind !== 'idle';
  const strong = row.unread || twoLine;
  return (
    <div
      className="m-press"
      data-session-id={row.id}
      onClick={() => onOpen(row.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: 48,
        padding: twoLine ? '9px 14px' : '0 14px',
        boxSizing: 'border-box',
        borderRadius: 10,
        cursor: 'pointer',
        background: isLive(row.status) ? LIVE_WASH : undefined,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: strong ? 600 : 400, color: strong ? MC.ink : MC.body, ...TRUNCATE }}>
          {row.title}
        </div>
        <StatusLine status={row.status} />
      </div>
      <RowMeta row={row} twoLine={twoLine} />
    </div>
  );
}

// New session: a round accent FAB in thumb reach, on the list's right edge.
const FAB_STYLE: CSSProperties = {
  position: 'absolute',
  right: M_GUTTER,
  bottom: M_FLOAT_BOTTOM,
  width: 52,
  height: 52,
  border: 0,
  borderRadius: '50%',
  background: 'var(--proto-accent)',
  color: 'var(--ink-solid-fg)',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  boxShadow: '0 8px 20px -8px color-mix(in srgb, var(--proto-accent) 75%, transparent), 0 1px 3px rgba(16, 24, 40, 0.12)',
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

function SessionListBody({ rows, stars, empty, onOpen }: {
  rows: MSessionRow[];
  stars?: MSessionListStars;
  empty: string;
  onOpen: (id: string) => void;
}) {
  return (
    <MScrollBody gap={0} padding={M_TAB_BODY_PADDING}>
      {stars && <StarredSessionGroup projectId={stars.projectId} count={stars.rows.length}
        expanded={stars.expanded} onToggle={stars.onToggle} mobile>
        <MGroup>{stars.rows.map((row) => <Row key={row.id} row={row} onOpen={onOpen} />)}</MGroup>
      </StarredSessionGroup>}
      {rows.length === 0 && !stars?.rows.length && <MEmpty>{empty}</MEmpty>}
      {rows.length > 0 && (
        <MGroup>{rows.map((row) => <Row key={row.id} row={row} onOpen={onOpen} />)}</MGroup>
      )}
      {/* Room for the FAB, so the last row can scroll clear of it. */}
      <div style={{ height: 64, flex: 'none' }} />
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
  /** Accessible label for the new-session FAB (vocab `wbNewSession`). */
  newLabel: string;
  /** Scheduled entry (8a): hidden while the project has no schedules and no runs. */
  scheduled?: MSessionListScheduled;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const L = useVocabOptional();
  const fab = (
    <button type="button" aria-label={newLabel} title={newLabel} onClick={onNew} style={FAB_STYLE}>
      <PlusGlyph size={20} strokeWidth={2} />
    </button>
  );
  return (
    <MScreen label="1a sessions" floatingHeader overlay={fab}
      header={<SessionListHeader title={L.sessions} presence={presence} project={project} projects={projects} scheduled={scheduled} />}>
      <SessionListBody rows={rows} stars={stars} empty={L.slEmpty} onOpen={onOpen} />
    </MScreen>
  );
}
