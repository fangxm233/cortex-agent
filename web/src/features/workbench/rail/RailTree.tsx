import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useLang, useVocab } from '@/i18n';
import { MENU_FOCUS, MENU_SURFACE } from '@/design/MenuChrome';
import { IconButton } from '@/design/IconButton';
import { RailSessionMenu } from './RailSessionMenu';
import { NewProjectIcon, OverviewIcon, SortIcon } from './RailHeaderIcons';
import type { RailProjectNode, RailSessionRow } from './rail-tree';
import type { RailSortMode } from './rail-order';
import { scheduleSubline, type ScheduleRow } from '@/features/session/list/schedule-rail';

// Header and folder-row icon controls fit inside the row's fixed height.
const ROW_ICON = 24;

// One row grammar for every line in the tree: a 16px status/icon column, the label, then a
// right-aligned meta slot, on a fixed 30px row. Nesting is only the left padding — a project's
// column sits at 8px, its sessions and groups at 22px, and every deeper level 18px further in — so
// a nested row keeps the same internal geometry one level deeper.
const ROW_HEIGHT = 30;
const PROJECT_PAD = 8;
const SUB_PAD = 22;
const NEST_STEP = 18;

const ELLIPSIS: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const META: CSSProperties = { fontSize: 12, color: 'var(--proto-faint)', fontVariantNumeric: 'tabular-nums', flex: 'none' };

function rowStyle(pad: number): CSSProperties {
  return {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: ROW_HEIGHT,
    boxSizing: 'border-box',
    padding: `0 8px 0 ${pad}px`,
    borderRadius: 'var(--r-chip)',
    cursor: 'pointer',
  };
}

// Selected is a gray tint with ink text; hover is a fainter tint. Neither uses the accent: in a list
// this dense a coloured row reads as status, and status belongs to the dot alone.
function rowBackground(selected: boolean, hovered: boolean): string {
  if (selected) return 'var(--proto-gray)';
  return hovered ? 'var(--proto-line-2)' : 'transparent';
}

function StatusColumn({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <span style={{ width: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--proto-faint)' }}>
      {children}
    </span>
  );
}

function activateRow(event: KeyboardEvent, activate: () => void): void {
  if (event.target !== event.currentTarget) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  activate();
}

type RowStatus = 'awaiting' | 'running' | 'waiting';

// Three states, in priority order. Amber is reserved everywhere in the UI for "blocked on YOU" — the
// only dot that asks the user to do something — so it wins over running. A hollow, still ring means
// "waiting on a machine": visible, but it must not compete with either live dot.
function rowStatus(row: RailSessionRow): RowStatus | null {
  if (row.awaitingInput) return 'awaiting';
  if (row.running) return 'running';
  if (row.waitingOn) return 'waiting';
  return null;
}

const DOT_STYLE: Record<RowStatus, CSSProperties> = {
  awaiting: {
    width: 7, height: 7, background: 'var(--proto-amber)',
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--proto-amber) 22%, transparent)',
  },
  running: {
    width: 7, height: 7, background: 'var(--proto-accent)',
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--proto-accent) 18%, transparent)',
  },
  waiting: { width: 8, height: 8, background: 'transparent', border: '1.5px solid var(--proto-faint)' },
};

// The section-header glyphs share one optical box: 14px rendered, one 16 viewBox, content bounded
// to y ∈ [3.4, 12.9], stroke 1.6. The sort glyph is a pair of opposed arrows rather than stepped
// lines because stepped lines put their mass in the top half and read as sitting high next to two
// vertically symmetric neighbours. Search is exported because the collapsed rail carries the same
// action and must draw it with the same glyph.
export function SearchIcon({ size = 14 }: { size?: number } = {}): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <circle cx="7.2" cy="7.2" r="3.9" />
      <path d="M10.1 10.1 12.9 12.9" />
    </svg>
  );
}

function AddIcon({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

function ClockIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="7" cy="7" r="5.6" />
      <path d="M7 4v3.2l2.2 1.3" />
    </svg>
  );
}

function StarIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.2l-3.53 1.85.7-3.93L2.3 6.35l3.95-.55z" />
    </svg>
  );
}

function CaretIcon({ open, size = 9 }: { open: boolean; size?: number }): JSX.Element {
  return (
    <svg
      width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
    >
      <path d="M4.5 2.5L8.5 6l-4 3.5" />
    </svg>
  );
}

// Two columns of dots: the conventional "this can be dragged" mark.
function GripIcon(): JSX.Element {
  return (
    <svg width={6} height={10} viewBox="0 0 6 10" fill="currentColor" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="1.2" cy="1.2" r="1" /><circle cx="4.8" cy="1.2" r="1" />
      <circle cx="1.2" cy="5" r="1" /><circle cx="4.8" cy="5" r="1" />
      <circle cx="1.2" cy="8.8" r="1" /><circle cx="4.8" cy="8.8" r="1" />
    </svg>
  );
}

/** Whether the selected session is drawn as a row inside this (open) folder. */
function showsSelection(node: RailProjectNode): boolean {
  if (!node.expanded) return false;
  const hit = (rows: RailSessionRow[]) =>
    rows.some((r) => r.selected || (!!r.workersExpanded && (r.workers ?? []).some((w) => w.selected)));
  return hit(node.sessions) || (node.starsExpanded && hit(node.starredSessions));
}

export interface RailTreeProps {
  nodes: RailProjectNode[];
  projectCount: number;
  sort: RailSortMode;
  onSort: (mode: RailSortMode) => void;
  filter: string;
  onFilter: (value: string) => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  onNewProject: () => void;
  onToggleProject: (id: string) => void;
  onToggleSchedules: (id: string) => void;
  onToggleStars: (id: string) => void;
  /** Opens/closes a lead session's worker list (team mode). */
  onToggleWorkers?: (row: RailSessionRow) => void;
  onShowAll: (id: string) => void;
  onShowFewer: (id: string) => void;
  onOpenSession: (row: RailSessionRow) => void;
  onNewSessionIn: (projectId: string) => void;
  onOverview: (projectId: string) => void;
  onScheduleRow: (row: ScheduleRow) => void;
  onReorder: (draggedId: string, targetId: string) => void;
  now: number;
}

export function RailTree(props: RailTreeProps): JSX.Element {
  const L = useVocab();
  const lang = useLang();
  const [menuOpen, setMenuOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const hp = (key: string) => ({
    onMouseEnter: () => setHover(key),
    onMouseLeave: () => setHover((h) => (h === key ? null : h)),
  });
  const isHover = (key: string) => hover === key;

  const statusText: Record<RowStatus, string> = {
    awaiting: L.slAwaiting,
    running: L.slRunning,
    waiting: L.wbRowWaitingOn,
  };

  // The filter field is a row BELOW the header, not a replacement for it: the section title and the
  // project count are what a filtered tree is being read against, so they have to stay on screen.
  const renderSearch = () => (
    <div style={{ padding: '0 12px 8px', flex: 'none' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          height: 30,
          padding: '0 10px',
          borderRadius: 9,
          background: 'var(--material-inset-bg)',
          boxShadow: '0 0 0 1.5px var(--proto-accent-border)',
        }}
      >
        <span style={{ color: 'var(--proto-muted-3)', display: 'flex' }}><SearchIcon size={13} /></span>
        <input
          ref={inputRef}
          autoFocus
          value={props.filter}
          onChange={(e) => props.onFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') props.onToggleSearch();
          }}
          placeholder={L.wbFilterSessions}
          aria-label={L.wbFilterSessions}
          style={{
            flex: 1,
            minWidth: 0,
            border: 0,
            outline: 0,
            background: 'transparent',
            color: 'var(--proto-ink)',
            fontSize: 12.5,
            fontFamily: 'inherit',
          }}
        />
        <span
          role="button"
          aria-label={L.cancel}
          onClick={props.onToggleSearch}
          style={{ color: 'var(--proto-muted-3)', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}
        >
          ✕
        </span>
      </div>
    </div>
  );

  // A small sentence-case heading with a plain count: hierarchy from weight and colour, not caps.
  const renderHeader = () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 28, padding: '0 10px 4px 16px', flex: 'none', boxSizing: 'content-box' }}>
      <span style={{ fontSize: 12, fontWeight: 550, color: 'var(--proto-muted)' }}>
        {L.wbProjects}
      </span>
      <span style={{ ...META, marginLeft: 6, marginRight: 'auto' }}>
        {props.projectCount}
      </span>
      <IconButton size={ROW_ICON} label={L.wbFilterSessions} onClick={props.onToggleSearch}><SearchIcon /></IconButton>
      <IconButton
        size={ROW_ICON}
        tone="accent"
        label={L.wbSortMode}
        active={menuOpen}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
      >
        <SortIcon />
        {menuOpen && (
          <span
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: ROW_ICON + 3,
              right: 0,
              zIndex: 20,
              minWidth: 118,
              padding: 4,
              borderRadius: 'var(--r-card)',
              ...MENU_SURFACE,
              border: '1px solid var(--proto-line-3)',
              display: 'block',
              textAlign: 'left',
            }}
          >
            {(['activity', 'manual'] as const).map((mode) => (
              <span
                key={mode}
                {...hp('sort:' + mode)}
                onClick={() => {
                  props.onSort(mode);
                  setMenuOpen(false);
                }}
                style={{
                  display: 'block',
                  padding: '6px 9px',
                  borderRadius: 6,
                  fontSize: 12.5,
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  fontWeight: props.sort === mode ? 600 : 400,
                  color: props.sort === mode ? 'var(--proto-ink)' : 'var(--proto-muted)',
                  background: isHover('sort:' + mode) ? 'var(--proto-gray)' : 'transparent',
                }}
              >
                {mode === 'activity' ? L.wbSortActivity : L.wbSortManual}
              </span>
            ))}
          </span>
        )}
      </IconButton>
      <IconButton size={ROW_ICON} label={L.newProject} onClick={props.onNewProject}><NewProjectIcon /></IconButton>
    </div>
  );

  // `pad` is the row's left padding — where its 16px status column starts.
  const renderSession = (row: RailSessionRow, pad = SUB_PAD): JSX.Element => {
    const key = 'sess:' + row.sessionId;
    const workers = row.workers ?? [];
    const status = rowStatus(row);
    // The dot is the only status mark on the row; its words live in the tooltip and in the dot's
    // accessible name, never in the trailing slot, which is the age's alone.
    const statusLabel = status ? statusText[status] : null;
    const strong = row.awaitingInput || row.unread;
    const body = (
      <div
        key={row.sessionId}
        {...hp(key)}
        data-session-id={row.sessionId}
        role="button"
        tabIndex={0}
        aria-current={row.selected || undefined}
        className={MENU_FOCUS}
        onKeyDown={(event) => activateRow(event, () => props.onOpenSession(row))}
        title={[row.title, statusLabel, row.stamp].filter(Boolean).join(' · ')}
        onClick={() => props.onOpenSession(row)}
        style={{
          ...rowStyle(pad),
          background: rowBackground(row.selected, isHover(key)),
          opacity: row.inactive && !row.selected ? 0.55 : undefined,
        }}
      >
        <StatusColumn>
          {status && (
            <span
              role="img"
              aria-label={statusLabel ?? undefined}
              data-rail-dot={status === 'waiting' ? 'waiting' : 'live'}
              style={{ display: 'block', borderRadius: '50%', boxSizing: 'border-box', flex: 'none', ...DOT_STYLE[status] }}
            />
          )}
        </StatusColumn>
        <span
          style={{
            ...ELLIPSIS,
            flex: 1,
            fontSize: 13,
            fontWeight: strong ? 600 : row.selected ? 550 : 400,
            color: strong || row.selected ? 'var(--proto-ink)' : 'var(--proto-ink-3)',
          }}
        >
          {row.title}
        </span>
        {workers.length > 0 && (
          // Lead row (team mode): this trailing caret unfolds the workers in place; the row body
          // still opens the lead itself, like any session.
          <span
            role="button"
            aria-label={row.workersExpanded ? L.wbTeamCollapse : L.wbTeamExpand}
            aria-expanded={!!row.workersExpanded}
            data-lead-caret={row.sessionId}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleWorkers?.(row);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              flex: 'none',
              padding: '2px 3px',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--proto-muted)',
            }}
          >
            {workers.length}
            <CaretIcon open={!!row.workersExpanded} size={8} />
          </span>
        )}
        <RailSessionMenu row={row} hovered={isHover(key)} />
      </div>
    );
    if (workers.length === 0) return body;
    return (
      <div key={row.sessionId} data-lead-group={row.sessionId}>
        {body}
        {row.workersExpanded && workers.map((w) => renderSession(w, pad + NEST_STEP))}
      </div>
    );
  };

  // A folder's Stars and Scheduled groups: the same row as a session, with the group's glyph in the
  // status column and its plain count after the label. The rows under it say it is open.
  const renderGroupRow = ({ hoverKey, icon, label, count, expanded, emphasis, title, onToggle }: {
    hoverKey: string;
    icon: ReactNode;
    label: string;
    count: number;
    expanded: boolean;
    emphasis?: boolean;
    title?: string;
    onToggle: () => void;
  }) => (
    <button
      type="button"
      {...hp(hoverKey)}
      aria-label={label}
      aria-expanded={expanded}
      title={title}
      className={MENU_FOCUS}
      onClick={() => onToggle()}
      style={{
        ...rowStyle(SUB_PAD),
        width: '100%',
        border: 0,
        textAlign: 'left',
        fontFamily: 'inherit',
        background: rowBackground(false, isHover(hoverKey)),
      }}
    >
      <StatusColumn>{icon}</StatusColumn>
      <span style={{ ...ELLIPSIS, flex: 1, fontSize: 13, display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ color: emphasis ? 'var(--proto-ink)' : 'var(--proto-muted)', fontWeight: emphasis ? 600 : 400 }}>{label}</span>
        <span style={{ ...META, fontSize: 12.5 }}>{count}</span>
      </span>
    </button>
  );

  const renderScheduleRow = (row: ScheduleRow) => {
    const key = 'sched:' + row.scheduleId;
    const sub = scheduleSubline(row, props.now, lang);
    const meta =
      sub.kind === 'run'
        ? sub.stamp + (sub.cost ? ' · ' + sub.cost : '')
        : sub.kind === 'paused'
          ? sub.cadence + ' · ' + L.wbSchedPausedPill
          : sub.cadence;
    return (
      <div
        key={key}
        {...hp(key)}
        data-schedule-row={row.scheduleId}
        role="button"
        tabIndex={0}
        className={MENU_FOCUS}
        title={meta}
        onKeyDown={(event) => activateRow(event, () => props.onScheduleRow(row))}
        onClick={() => props.onScheduleRow(row)}
        style={{ ...rowStyle(SUB_PAD + NEST_STEP), background: rowBackground(false, isHover(key)) }}
      >
        <StatusColumn><ClockIcon /></StatusColumn>
        <span
          style={{
            ...ELLIPSIS,
            flex: 1,
            fontSize: 13,
            color: row.unread ? 'var(--proto-ink)' : 'var(--proto-ink-3)',
            fontWeight: row.unread ? 600 : 400,
          }}
        >
          {row.title}
        </span>
        <span style={META}>
          {row.kind === 'repeat' ? row.runs.length : L.wbSchedOnce}
        </span>
      </div>
    );
  };

  const renderFolder = (node: RailProjectNode) => {
    const key = 'proj:' + node.id;
    const hovered = isHover(key);
    // The current folder takes the selected tint only while its selected session is not on screen
    // as a row — a draft, or a selection folded away — because that is where the next message will
    // land. Otherwise the session row carries the selection and the folder stays plain.
    const tinted = node.current && !showsSelection(node);
    return (
      <div
        key={node.id}
        draggable={!props.filter}
        onDragStart={(e) => {
          setDragId(node.id);
          e.dataTransfer.effectAllowed = 'move';
          try {
            e.dataTransfer.setData('text/plain', node.id);
          } catch {
            /* some browsers reject custom payloads; the id in state is the real channel */
          }
        }}
        onDragOver={(e) => {
          if (!dragId || dragId === node.id) return;
          e.preventDefault();
          setOverId(node.id);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId && dragId !== node.id) props.onReorder(dragId, node.id);
          setDragId(null);
          setOverId(null);
        }}
        onDragEnd={() => {
          setDragId(null);
          setOverId(null);
        }}
      >
        <div
          {...hp(key)}
          data-project-row={node.id}
          role="button"
          tabIndex={0}
          aria-expanded={node.expanded}
          className={MENU_FOCUS}
          onKeyDown={(event) => activateRow(event, () => props.onToggleProject(node.id))}
          onClick={() => props.onToggleProject(node.id)}
          style={{
            // Fixed height: hovering swaps the trailing age for two icon buttons, and a height that
            // followed its content would make every row jump under the cursor.
            ...rowStyle(PROJECT_PAD),
            opacity: dragId === node.id ? 0.45 : 1,
            // Only drag-over needs a marker.
            boxShadow: overId === node.id
              ? 'inset 0 2px 0 0 var(--proto-accent)'
              : undefined,
            background: rowBackground(tinted, hovered),
          }}
        >
          {/* The whole row drags; the grip in its left padding is the affordance, shown on hover so
              a resting tree carries no extra column. */}
          {!props.filter && (
            <span
              aria-hidden="true"
              title={L.wbReorderProject}
              data-project-grip={node.id}
              style={{
                position: 'absolute', left: 0, top: 0, bottom: 0, width: PROJECT_PAD,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--proto-faint)', cursor: 'grab', opacity: hovered ? 1 : 0,
              }}
            >
              <GripIcon />
            </span>
          )}
          <StatusColumn><CaretIcon open={node.expanded} size={10} /></StatusColumn>
          <span
            title={node.id}
            style={{
              ...ELLIPSIS,
              flex: 1,
              fontSize: 13,
              fontWeight: 550,
              color: node.empty ? 'var(--proto-muted-3)' : 'var(--proto-ink)',
            }}
          >
            {node.id}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
            {node.matchCount !== null && (
              <span style={{ ...META, color: 'var(--proto-muted)' }}>{node.matchCount}</span>
            )}
            {node.attention > 0 && (
              // A plain count, not a badge. Its colour only ever means one thing: amber = something
              // is waiting on you; unread replies are news, so they stay muted.
              <span
                data-project-attention-badge={node.id}
                style={{
                  ...META,
                  fontWeight: 600,
                  color: node.attentionTone === 'action' ? 'var(--proto-amber-text)' : 'var(--proto-muted)',
                }}
              >
                {node.attention}
              </span>
            )}
            {hovered ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <IconButton
                  size={ROW_ICON}
                  label={L.wbProjectOverview.replace('{p}', node.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onOverview(node.id);
                  }}
                >
                  <OverviewIcon />
                </IconButton>
                <IconButton
                  size={ROW_ICON}
                  label={L.wbNewSessionIn.replace('{p}', node.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onNewSessionIn(node.id);
                  }}
                >
                  <AddIcon />
                </IconButton>
              </span>
            ) : node.idleAge !== null ? (
              <span style={META}>{node.idleAge}</span>
            ) : (
              node.hotkey && <span style={META}>{node.hotkey}</span>
            )}
          </span>
        </div>

        {node.expanded && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '1px 0 6px' }}>
            {node.starredSessions.length > 0 && (
              // Empty (including filtered-out) groups have no chrome.
              <section data-starred-project={node.id}>
                {renderGroupRow({
                  hoverKey: 'stars:' + node.id,
                  icon: <StarIcon />,
                  label: L.chatStars,
                  count: node.starredSessions.length,
                  expanded: node.starsExpanded,
                  onToggle: () => props.onToggleStars(node.id),
                })}
                {node.starsExpanded && node.starredSessions.map((s) => renderSession(s, SUB_PAD + NEST_STEP))}
              </section>
            )}
            {node.sessions.map((s) => renderSession(s))}
            {/* The cap has two directions and only ever one link: open the rest, or take it back.
                Without the second the folder would stay uncapped for the rest of the visit. */}
            {(node.hiddenSessions > 0 || node.showingAll) && (
              <div
                {...hp('more:' + node.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (node.showingAll) props.onShowFewer(node.id);
                  else props.onShowAll(node.id);
                }}
                style={{
                  ...rowStyle(SUB_PAD),
                  height: 28,
                  color: isHover('more:' + node.id) ? 'var(--proto-ink)' : 'var(--proto-muted)',
                  background: rowBackground(false, isHover('more:' + node.id)),
                }}
              >
                <StatusColumn />
                <span style={{ flex: 1, fontSize: 12.5 }}>
                  {node.showingAll
                    ? L.wbShowFewerSessions
                    : L.wbShowAllSessions.replace('{n}', String(node.totalSessions))}
                </span>
                <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--proto-faint)' }}>›</span>
              </div>
            )}
            {node.schedules.length > 0 && (
              <>
                {renderGroupRow({
                  hoverKey: 'schedhead:' + node.id,
                  icon: <ClockIcon />,
                  label: L.wbSchedGroup,
                  count: node.schedules.length,
                  expanded: node.schedulesExpanded,
                  // Unread runs behind a folded group bold its label, like an unread session's title.
                  emphasis: node.scheduleUnread > 0 && !node.schedulesExpanded,
                  title: node.scheduleUnread > 0
                    ? L.wbSchedUnread.replace('{n}', String(node.scheduleUnread))
                    : undefined,
                  onToggle: () => props.onToggleSchedules(node.id),
                })}
                {node.schedulesExpanded && node.schedules.map(renderScheduleRow)}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {renderHeader()}
      {props.searchOpen && renderSearch()}
      <div data-zone="tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable', padding: '0 4px 0 8px' }}>
        {props.nodes.length === 0 ? (
          <div style={{ padding: '26px 16px', textAlign: 'center', color: 'var(--proto-muted)', fontSize: 12.5 }}>
            {L.wbFilterNoMatch}
          </div>
        ) : (
          props.nodes.map(renderFolder)
        )}
        <div style={{ height: 10 }} />
      </div>
    </>
  );
}
