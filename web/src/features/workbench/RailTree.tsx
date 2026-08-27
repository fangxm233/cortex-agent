// input:  rail tree nodes, sort state and selection callbacks
// output: the scrollable project folder tree with its section header
// pos:    Presentational body of the left rail
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useRef, useState, type ReactNode } from 'react';
import { useVocab } from '@/i18n';
import { ProjectFolderIcon } from './ProjectFolderIcon';
import type { RailProjectNode, RailSessionRow } from './rail-tree';
import type { RailSortMode } from './rail-order';
import { scheduleSubline, type ScheduleRow } from './schedule-rail';

const mono = "'IBM Plex Mono',monospace";

// The three section-header glyphs share one optical box: 14px rendered, one 16 viewBox, content
// bounded to y ∈ [3.4, 12.9], stroke 1.6. The sort glyph is a pair of opposed arrows rather than
// stepped lines because stepped lines put their mass in the top half and read as sitting high next
// to two vertically symmetric neighbours. Search and new-project are exported because the collapsed
// rail carries the same two actions and must draw them with the same glyph.
export function SearchIcon(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <circle cx="7.2" cy="7.2" r="3.9" />
      <path d="M10.1 10.1 12.9 12.9" />
    </svg>
  );
}

function SortIcon(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.6 12.4V3.6M5.6 3.6 3.4 5.9M5.6 3.6 7.8 5.9" />
      <path d="M10.4 3.6v8.8M10.4 12.4l2.2-2.3M10.4 12.4l-2.2-2.3" />
    </svg>
  );
}

export function NewProjectIcon(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M2.2 4.6A1.25 1.25 0 0 1 3.45 3.35h2.4l1.25 1.45h5.45A1.25 1.25 0 0 1 13.8 6.05v5.6a1.25 1.25 0 0 1-1.25 1.25H3.45A1.25 1.25 0 0 1 2.2 11.65z" />
      <path d="M8 7.5v3.1M6.45 9.05h3.1" />
    </svg>
  );
}

function OverviewIcon(): JSX.Element {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="1.8" y="1.8" width="5.4" height="5.4" rx="1.3" />
      <rect x="8.8" y="1.8" width="5.4" height="5.4" rx="1.3" />
      <rect x="1.8" y="8.8" width="5.4" height="5.4" rx="1.3" />
      <rect x="8.8" y="8.8" width="5.4" height="5.4" rx="1.3" />
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

function ClockIcon({ size = 11 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="7" cy="7" r="5.6" />
      <path d="M7 4v3.2l2.2 1.3" />
    </svg>
  );
}

function IconButton({ label, active, onClick, children }: {
  label: string;
  active?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 22,
        height: 22,
        border: 0,
        borderRadius: 6,
        padding: 0,
        display: 'grid',
        placeItems: 'center',
        cursor: 'pointer',
        flex: 'none',
        position: 'relative',
        background: active ? 'var(--proto-accent-bg)' : hover ? 'var(--proto-gray)' : 'transparent',
        color: active ? 'var(--proto-accent)' : hover ? 'var(--proto-ink-2)' : 'var(--proto-muted-2)',
      }}
    >
      {children}
    </button>
  );
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

  // Section header and the search field occupy the SAME 28px box, so opening search swaps the row's
  // content in place instead of nudging the tree down by a few pixels.
  const renderHeader = () => {
    if (props.searchOpen) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', height: 28, padding: '0 12px 6px', flex: 'none', boxSizing: 'content-box' }}>
          <div
            style={{
              flex: 1,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 8px',
              borderRadius: 7,
              border: '1px solid var(--proto-accent-border)',
              background: 'var(--proto-card)',
            }}
          >
            <span style={{ color: 'var(--proto-muted-3)', display: 'flex' }}><SearchIcon /></span>
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
                fontSize: 12,
                fontFamily: 'inherit',
              }}
            />
            <span
              role="button"
              aria-label={L.cancel}
              onClick={props.onToggleSearch}
              style={{ color: 'var(--proto-muted-3)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}
            >
              ✕
            </span>
          </div>
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 28, padding: '0 12px 6px', flex: 'none', boxSizing: 'content-box' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: 'var(--proto-faint)' }}>
          {L.wbProjects}
        </span>
        <span style={{ font: `500 9.5px ${mono}`, color: 'var(--proto-line-3)', marginLeft: 5, marginRight: 'auto' }}>
          {props.projectCount}
        </span>
        <IconButton label={L.wbFilterSessions} onClick={props.onToggleSearch}><SearchIcon /></IconButton>
        <IconButton
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
                top: 25,
                right: 0,
                zIndex: 20,
                minWidth: 118,
                padding: 4,
                borderRadius: 9,
                background: 'var(--proto-card)',
                border: '1px solid var(--proto-line-3)',
                boxShadow: 'var(--shadow-menu)',
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
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    fontWeight: props.sort === mode ? 600 : 400,
                    color: props.sort === mode ? 'var(--proto-accent)' : 'var(--proto-muted)',
                    background: isHover('sort:' + mode) ? 'var(--proto-gray)' : 'transparent',
                  }}
                >
                  {mode === 'activity' ? L.wbSortActivity : L.wbSortManual}
                </span>
              ))}
            </span>
          )}
        </IconButton>
        <IconButton label={L.newProject} onClick={props.onNewProject}><NewProjectIcon /></IconButton>
      </div>
    );
  };

  const renderSession = (row: RailSessionRow) => {
    const key = 'sess:' + row.sessionId;
    return (
      <div
        key={row.sessionId}
        {...hp(key)}
        data-session-id={row.sessionId}
        title={row.stamp ? `${row.title} · ${row.stamp}` : row.title}
        onClick={() => props.onOpenSession(row)}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 28,
          // 28 = the folder glyph's 4 + its 17 + the row gap: every session title starts exactly
          // under its project's name.
          padding: '5px 8px 5px 28px',
          borderRadius: 7,
          cursor: 'pointer',
          background: row.selected
            ? 'var(--proto-accent-bg)'
            : isHover(key)
              ? 'var(--proto-gray)'
              : 'transparent',
        }}
      >
        {row.selected && (
          <span
            aria-hidden="true"
            style={{ position: 'absolute', left: 12, top: 5, bottom: 5, width: 2, borderRadius: 1, background: 'var(--proto-accent)' }}
          />
        )}
        {(row.running || row.awaitingInput) && (
          // Absolute, in the gutter between the spine and the text: in flow it pushed the title of
          // exactly the rows you are watching out of line with every other one.
          <span
            style={{
              position: 'absolute',
              left: 17,
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: row.awaitingInput ? 'var(--proto-amber)' : 'var(--proto-accent)',
              animation: 'cxpulse 1.6s ease-in-out infinite',
            }}
          />
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontWeight: row.selected || row.unread ? 600 : 400,
            color: row.selected || row.unread ? 'var(--proto-ink)' : 'var(--proto-muted)',
          }}
        >
          {row.title}
        </span>
        <span style={{ font: `400 9.5px ${mono}`, color: 'var(--proto-faint)', flex: 'none' }}>
          {row.age}
        </span>
      </div>
    );
  };

  const renderScheduleRow = (row: ScheduleRow) => {
    const key = 'sched:' + row.scheduleId;
    const sub = scheduleSubline(row, props.now);
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
        title={meta}
        onClick={() => props.onScheduleRow(row)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 26,
          padding: '4px 8px 4px 40px',
          borderRadius: 7,
          cursor: 'pointer',
          fontSize: 12.5,
          color: row.unread ? 'var(--proto-ink)' : 'var(--proto-muted)',
          fontWeight: row.unread ? 600 : 400,
          background: isHover(key) ? 'var(--proto-gray)' : 'transparent',
        }}
      >
        <span style={{ color: row.unread ? 'var(--proto-accent)' : 'var(--proto-muted-3)', display: 'flex', flex: 'none' }}>
          <ClockIcon />
        </span>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.title}
        </span>
        <span style={{ font: `500 9px ${mono}`, color: 'var(--proto-muted-3)', flex: 'none' }}>
          {row.kind === 'repeat' ? `×${row.runs.length}` : L.wbSchedOnce}
        </span>
      </div>
    );
  };

  const renderFolder = (node: RailProjectNode) => {
    const key = 'proj:' + node.id;
    const hovered = isHover(key);
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
          onClick={() => props.onToggleProject(node.id)}
          style={{
            // Sticky keeps the owning project visible while scrolling a long folder; it is lifted
            // during a drag so the pinned row cannot overlap the drag image.
            position: dragId ? 'relative' : 'sticky',
            top: 0,
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            // Fixed, not padding-derived: hovering swaps the trailing age/hotkey for two 22px icon
            // buttons, and a height that follows its content would make every row jump under the
            // cursor. 30px clears the tallest thing the slot can hold.
            height: 30,
            boxSizing: 'border-box',
            // 4 + the scroller's 8 puts the folder glyph on x=12, the same left margin the section
            // header and the new-session button already use.
            padding: '0 8px 0 4px',
            borderRadius: 8,
            cursor: 'pointer',
            opacity: dragId === node.id ? 0.45 : 1,
            boxShadow: overId === node.id ? 'inset 0 2px 0 0 var(--proto-accent)' : undefined,
            background: node.current
              ? 'var(--proto-line-2)'
              : hovered
                ? 'var(--proto-gray)'
                : 'var(--proto-rail)',
          }}
        >
          {/* The folder glyph IS the drag handle. A separate grip column cost 17px of permanent
              indent — on every row, forever — to advertise a gesture the whole row already accepts,
              and it pushed the tree off the rail's 12px text margin. */}
          <span
            title={props.filter ? undefined : L.wbReorderProject}
            style={{ display: 'flex', flex: 'none', cursor: props.filter ? 'pointer' : 'grab' }}
          >
            <ProjectFolderIcon open={node.expanded} current={node.current} dim={node.empty} />
          </span>
          <span
            title={node.id}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              fontWeight: node.current || node.attention > 0 ? 600 : 400,
              color: node.current || node.attention > 0
                ? 'var(--proto-ink)'
                : node.empty
                  ? 'var(--proto-muted-2)'
                  : 'var(--proto-ink-2)',
            }}
          >
            {node.id}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 'none' }}>
            {node.matchCount !== null && (
              <span
                style={{
                  font: `600 9px ${mono}`,
                  color: 'var(--proto-accent)',
                  background: 'var(--proto-accent-bg)',
                  borderRadius: 4,
                  padding: '1px 4px',
                }}
              >
                {node.matchCount}
              </span>
            )}
            {node.running > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 3, font: `600 9.5px ${mono}`, color: 'var(--proto-accent)' }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--proto-accent)',
                    animation: 'cxpulse 1.6s ease-in-out infinite',
                  }}
                />
                {node.running}
              </span>
            )}
            {node.attention > 0 && (
              <span
                data-project-attention-badge={node.id}
                style={{
                  minWidth: 15,
                  height: 15,
                  padding: '0 4px',
                  borderRadius: '50%',
                  background:
                    node.attentionTone === 'action' ? 'var(--proto-amber)' : 'var(--proto-accent)',
                  // Not a hardcoded white: --ink-solid-fg flips with the theme, so the digit stays
                  // legible on both fills in light and dark.
                  color: 'var(--ink-solid-fg)',
                  font: `600 9.5px ${mono}`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {node.attention}
              </span>
            )}
            {hovered ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <IconButton
                  label={L.wbProjectOverview.replace('{p}', node.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onOverview(node.id);
                  }}
                >
                  <OverviewIcon />
                </IconButton>
                <IconButton
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
              <span style={{ font: `400 9.5px ${mono}`, color: 'var(--proto-faint)' }}>{node.idleAge}</span>
            ) : (
              node.hotkey && <span style={{ font: `400 9px ${mono}`, color: 'var(--proto-line-3)' }}>{node.hotkey}</span>
            )}
          </span>
        </div>

        {node.expanded && (
          <div style={{ position: 'relative' }}>
            {/* the guide line, not a chevron, is what says "these belong to that folder" */}
            <span
              aria-hidden="true"
              style={{ position: 'absolute', left: 12, top: -2, bottom: 5, width: 1, background: 'var(--proto-line)' }}
            />
            {node.sessions.map(renderSession)}
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
                  padding: '3px 8px 6px 28px',
                  fontSize: 11.5,
                  cursor: 'pointer',
                  color: isHover('more:' + node.id) ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
                }}
              >
                {node.showingAll
                  ? L.wbShowFewerSessions
                  : L.wbShowAllSessions.replace('{n}', String(node.totalSessions))}
              </div>
            )}
            {node.schedules.length > 0 && (
              <>
                <div
                  {...hp('schedhead:' + node.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onToggleSchedules(node.id);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px 5px 28px',
                    fontSize: 11.5,
                    cursor: 'pointer',
                    color: isHover('schedhead:' + node.id) ? 'var(--proto-ink-2)' : 'var(--proto-muted-2)',
                  }}
                >
                  <ClockIcon />
                  {L.wbSchedGroup}
                  <span style={{ font: `500 9.5px ${mono}`, color: 'var(--proto-muted-3)' }}>
                    · {node.schedules.length}
                  </span>
                  {node.scheduleUnread > 0 && !node.schedulesExpanded && (
                    <span style={{ marginLeft: 'auto', font: `500 9.5px ${mono}`, color: 'var(--proto-accent)' }}>
                      {L.wbSchedUnread.replace('{n}', String(node.scheduleUnread))}
                    </span>
                  )}
                </div>
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
      <div data-zone="tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px' }}>
        {props.nodes.length === 0 ? (
          <div style={{ padding: '26px 16px', textAlign: 'center', color: 'var(--proto-faint)', fontSize: 12 }}>
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
