// input:  rail-tree, rail-order, vocab, ProjectFolderIcon
// output: RailTree
// pos:    Flat project rows and readable session hierarchy
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useRef, useState, type ReactNode } from 'react';
import { useVocab } from '@/i18n';
import { MENU_SURFACE } from './MenuChrome';
import { ProjectFolderIcon } from './ProjectFolderIcon';
import type { RailCommissionRow, RailProjectNode, RailSessionRow } from './rail-tree';
import type { RailSortMode } from './rail-order';
import { scheduleSubline, type ScheduleRow } from './schedule-rail';

const mono = "'IBM Plex Mono',monospace";

// The three section-header glyphs share one optical box: 14px rendered, one 16 viewBox, content
// bounded to y ∈ [3.4, 12.9], stroke 1.6. The sort glyph is a pair of opposed arrows rather than
// stepped lines because stepped lines put their mass in the top half and read as sitting high next
// to two vertically symmetric neighbours. Search is exported because the collapsed rail carries the
// same action and must draw it with the same glyph.
export function SearchIcon({ size = 14 }: { size?: number } = {}): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
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

function NewProjectIcon(): JSX.Element {
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

/** A commission is a standing contract, not a clock — the pennant keeps it visually apart from the
 *  schedule rows it shares an indent with. */
function CommissionIcon({ size = 11 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M3.7 1.9v10.2" />
      <path d="M3.7 2.7h6.8L9.1 5l1.4 2.3H3.7z" />
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

function IconButton({ label, active, size = 22, onClick, children }: {
  label: string;
  active?: boolean;
  /** Box side. A denser row than the project folder's gives it a smaller one, so the button still
   *  fits inside the row's fixed height instead of stretching it under the cursor. */
  size?: number;
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
        width: size,
        height: size,
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
  /** Opens/closes a project's COMMISSION section. */
  onToggleCommissions: (id: string) => void;
  /** Opens/closes one commission folder's session list. */
  onToggleCommission: (commissionId: string) => void;
  /** Opens the commission board — the row is a board entry point, not a route. */
  onOpenCommission: (commissionId: string) => void;
  /** Starts another session on this commission, from the row that already names it. Absent when the
   *  commission feature is switched off — the create would then drop the binding silently. */
  onNewCommissionSession?: (row: RailCommissionRow) => void;
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
            fontSize: 12,
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

  const renderHeader = () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 28, padding: '0 14px 4px', flex: 'none', boxSizing: 'content-box' }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--proto-muted)' }}>
        {L.wbProjects}
      </span>
      <span style={{ font: `500 11px ${mono}`, color: 'var(--proto-muted)', marginLeft: 5, marginRight: 'auto' }}>
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

  // `indent` is the title's left edge; the selection spine and the status dot ride 19px and 11px
  // to its left, so a session nested under a commission keeps the same internal geometry one level
  // deeper rather than re-deriving three magic numbers.
  const renderSession = (row: RailSessionRow, indent = 32) => {
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
          gap: 8,
          height: 30,
          boxSizing: 'border-box',
          // The folder row puts its project name at 6 + the glyph's 17 + the row's gap = 30; a
          // session title sits a hair inside that, so the nesting reads without a second indent.
          padding: `0 10px 0 ${indent}px`,
          borderRadius: 'var(--r-chip)',
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
            style={{ position: 'absolute', left: indent - 19, top: 6, bottom: 6, width: 3, borderRadius: 2, background: 'var(--proto-accent)' }}
          />
        )}
        {(row.running || row.awaitingInput || row.waitingOn) && (
          // Absolute, in the gutter between the spine and the text: in flow it pushed the title of
          // exactly the rows you are watching out of line with every other one.
          // Three states, in priority order. A hollow, still ring means "waiting on a machine":
          // visible, but it must not compete with amber, which is reserved everywhere in the UI for
          // "blocked on YOU" — the only dot that asks the user to do something.
          <span
            data-rail-dot={row.running || row.awaitingInput ? 'live' : 'waiting'}
            style={{
              position: 'absolute',
              left: indent - 11,
              width: 6,
              height: 6,
              borderRadius: '50%',
              boxSizing: 'border-box',
              ...(row.running || row.awaitingInput
                ? {
                  background: row.awaitingInput ? 'var(--proto-amber)' : 'var(--proto-accent)',
                  animation: 'cxpulse 1.6s ease-in-out infinite',
                }
                : { background: 'transparent', border: '1.5px solid var(--proto-muted-3)' }),
            }}
          />
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontWeight: row.selected || row.unread ? 600 : 400,
            color: row.selected || row.unread ? 'var(--proto-ink)' : 'var(--proto-muted)',
          }}
        >
          {row.title}
        </span>
        <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted-2)', flex: 'none' }}>
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
          borderRadius: 'var(--r-chip)',
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
        <span style={{ font: `500 11px ${mono}`, color: 'var(--proto-muted)', flex: 'none' }}>
          {row.kind === 'repeat' ? `×${row.runs.length}` : L.wbSchedOnce}
        </span>
      </div>
    );
  };

  // The caret and the row body do different things on purpose: the caret unfolds the sessions in
  // place, the body opens the board. A commission's own state lives on the board, so making the
  // whole row a disclosure would leave the board with no entry point from the tree.
  const renderCommissionRow = (row: RailCommissionRow) => {
    const key = 'comm:' + row.commissionId;
    const closed = row.status !== 'active';
    // Only an ACTIVE commission takes new sessions (the server refuses the rest), so a closed row
    // keeps its status word where the ＋ would sit.
    const canAdd = !closed && !!props.onNewCommissionSession;
    return (
      <div key={key}>
        <div
          {...hp(key)}
          data-commission-row={row.commissionId}
          title={row.title}
          onClick={() => props.onOpenCommission(row.commissionId)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            // Fixed, not content-derived, for the reason the project row is: hovering swaps the
            // trailing count for an icon button, and a row that follows its content would jump
            // under the cursor. 26 = the 18px button plus the row's own 4+4 padding.
            height: 26,
            boxSizing: 'border-box',
            padding: '4px 8px 4px 28px',
            borderRadius: 'var(--r-chip)',
            cursor: 'pointer',
            fontSize: 12.5,
            color: row.unread ? 'var(--proto-ink)' : 'var(--proto-muted)',
            fontWeight: row.unread ? 600 : 400,
            background: isHover(key) ? 'var(--proto-gray)' : 'transparent',
          }}
        >
          <span
            role="button"
            aria-label={row.expanded ? L.wbCommissionCollapse : L.wbCommissionExpand}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleCommission(row.commissionId);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              flex: 'none',
              width: 12,
              color: 'var(--proto-muted-3)',
              visibility: row.totalSessions > 0 ? 'visible' : 'hidden',
            }}
          >
            <CaretIcon open={row.expanded} />
          </span>
          <span
            style={{
              color: row.awaitingInput
                ? 'var(--proto-amber)'
                : row.running
                  ? 'var(--proto-accent)'
                  : 'var(--proto-muted-3)',
              display: 'flex',
              flex: 'none',
            }}
          >
            <CommissionIcon />
          </span>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {row.title}
          </span>
          {canAdd && isHover(key) ? (
            <IconButton
              label={L.wbCommissionNewSession}
              size={18}
              onClick={(e) => {
                e.stopPropagation();
                props.onNewCommissionSession!(row);
              }}
            >
              <AddIcon />
            </IconButton>
          ) : closed ? (
            <span style={{ font: `500 11px ${mono}`, color: 'var(--proto-muted)', flex: 'none' }}>
              {row.status === 'done' ? L.wbCommissionDone : L.wbCommissionAbandoned}
            </span>
          ) : (
            row.totalSessions > 0 && (
              <span style={{ font: `500 11px ${mono}`, color: 'var(--proto-muted)', flex: 'none' }}>
                ×{row.totalSessions}
              </span>
            )
          )}
        </div>
        {row.expanded && row.sessions.map((s) => renderSession(s, 56))}
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
            // Transparent rows scroll with their sessions so text cannot overlap underneath.
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            // Fixed, not padding-derived: hovering swaps the trailing age/hotkey for two 22px icon
            // buttons, and a height that follows its content would make every row jump under the
            // cursor. 32px clears the tallest thing the slot can hold.
            height: 32,
            boxSizing: 'border-box',
            // 6 + the scroller's 8 puts the folder glyph on x=14, the same left margin the section
            // header above it uses.
            padding: '0 8px 0 6px',
            borderRadius: 'var(--r-chip)',
            cursor: 'pointer',
            opacity: dragId === node.id ? 0.45 : 1,
            // Only drag-over needs a marker; the current project uses a light accent tint.
            boxShadow: overId === node.id
              ? 'inset 0 2px 0 0 var(--proto-accent)'
              : undefined,
            background: node.current
              ? 'var(--proto-accent-bg)'
              : hovered
                ? 'var(--proto-gray)'
                : 'transparent',
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
              fontWeight: node.current || node.attention > 0 ? 600 : 500,
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
                  font: `600 11px ${mono}`,
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
              <span style={{ display: 'flex', alignItems: 'center', gap: 3, font: `600 11px ${mono}`, color: 'var(--proto-accent)' }}>
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
                  minWidth: 16,
                  height: 16,
                  padding: '0 5px',
                  boxSizing: 'border-box',
                  borderRadius: 'var(--r-pill)',
                  background:
                    node.attentionTone === 'action' ? 'var(--proto-amber)' : 'var(--proto-accent)',
                  // Amber stays a light fill in both themes and needs a dark foreground.
                  color: node.attentionTone === 'action' ? 'var(--amber-fill-fg)' : 'var(--ink-solid-fg)',
                  font: `600 11px ${mono}`,
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
              <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>{node.idleAge}</span>
            ) : (
              node.hotkey && <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>{node.hotkey}</span>
            )}
          </span>
        </div>

        {node.expanded && (
          <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 1, padding: '3px 0 8px' }}>
            {/* the guide line, not a chevron, is what says "these belong to that folder" */}
            <span
              aria-hidden="true"
              style={{ position: 'absolute', left: 14, top: 0, bottom: 8, width: 1, background: 'var(--proto-line)', opacity: 0.55 }}
            />
            {/* Commissions sit ABOVE the loose sessions: they are the standing work of the project,
                and a long task that scrolls under eight ad-hoc chats stops being an anchor. */}
            {node.commissions.length > 0 && (
              <>
                <div
                  {...hp('commhead:' + node.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onToggleCommissions(node.id);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px 5px 28px',
                    fontSize: 11.5,
                    cursor: 'pointer',
                    color: isHover('commhead:' + node.id) ? 'var(--proto-ink-2)' : 'var(--proto-muted-2)',
                  }}
                >
                  <CommissionIcon />
                  {L.wbCommissionGroup}
                  <span style={{ font: `500 11px ${mono}`, color: 'var(--proto-muted)' }}>
                    · {node.commissions.length}
                  </span>
                  {node.commissionUnread > 0 && !node.commissionsExpanded && (
                    <span style={{ marginLeft: 'auto', font: `500 11px ${mono}`, color: 'var(--proto-accent)' }}>
                      {L.wbSchedUnread.replace('{n}', String(node.commissionUnread))}
                    </span>
                  )}
                </div>
                {node.commissionsExpanded && node.commissions.map(renderCommissionRow)}
              </>
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
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 26,
                  boxSizing: 'border-box',
                  padding: '0 10px 0 32px',
                  borderRadius: 'var(--r-chip)',
                  cursor: 'pointer',
                  color: isHover('more:' + node.id) ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
                  background: isHover('more:' + node.id) ? 'var(--proto-line-2)' : 'transparent',
                }}
              >
                <span style={{ flex: 1, fontSize: 11.5 }}>
                  {node.showingAll
                    ? L.wbShowFewerSessions
                    : L.wbShowAllSessions.replace('{n}', String(node.totalSessions))}
                </span>
                <span aria-hidden="true" style={{ font: `400 9.5px ${mono}`, color: 'var(--proto-faint)' }}>›</span>
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
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    height: 28,
                    boxSizing: 'border-box',
                    padding: '0 10px 0 32px',
                    borderRadius: 'var(--r-chip)',
                    cursor: 'pointer',
                    background: isHover('schedhead:' + node.id) ? 'var(--proto-line-2)' : 'transparent',
                  }}
                >
                  {/* Out of flow, so the label starts at the same x as the session rows around it. */}
                  <span style={{ position: 'absolute', left: 18, display: 'flex', color: 'var(--proto-muted-3)' }}>
                    <ClockIcon />
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--proto-muted)' }}>
                    {L.wbSchedGroup}
                  </span>
                  {node.scheduleUnread > 0 && !node.schedulesExpanded && (
                    <span
                      title={L.wbSchedUnread.replace('{n}', String(node.scheduleUnread))}
                      aria-label={L.wbSchedUnread.replace('{n}', String(node.scheduleUnread))}
                      style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-accent)', flex: 'none' }}
                    />
                  )}
                  <span style={{ font: `500 11px ${mono}`, color: 'var(--proto-muted)', flex: 'none' }}>
                    ×{node.schedules.length}
                  </span>
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
      {props.searchOpen && renderSearch()}
      <div data-zone="tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px' }}>
        {props.nodes.length === 0 ? (
          <div style={{ padding: '26px 16px', textAlign: 'center', color: 'var(--proto-muted)', fontSize: 12 }}>
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
