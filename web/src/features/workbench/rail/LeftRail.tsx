import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { scheduleRowAction, type ScheduleRow } from '@/features/session/list/schedule-rail';
import { RunListModal } from './RunListModal';
import { useScheduleModal } from '@/features/schedule/useScheduleModal';
import { projectIndexFromKey } from '@/features/session/list/left-rail-projects';
import {
  buildRailTree,
  projectOfSession,
  type RailCommissionRow,
  type RailSessionRow,
} from './rail-tree';
import type { RailSortMode } from './rail-order';
import { RailTree, SearchIcon } from './RailTree';
import { useApprovals } from '@/features/approvals/useApprovals';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useCommissionBoard } from '@/features/commission/useCommissionBoard';
import { useCommissionLiveSync } from '@/features/commission/useCommissionLiveSync';
import { useCommissionEnabled } from '@/features/commission/CommissionOptIn';
import { useTeamEnabled } from '@/features/team/useTeamEnabled';
import { useSelectedSession } from '@/features/session/state/SelectedSessionProvider';
import { useLang, useVocab } from '@/i18n';
import { useSessionsLiveSync } from '@/features/session/live/useSessionsLiveSync';
import { useMarkManyRead } from '@/features/session/live/useMarkSessionRead';
import type { ConnectionDot } from '@/features/connection/connection-status';
import { RailRateLimitStatus, useRateLimitStatus } from '@/features/rate-limit';
import { IconButton, PlusGlyph } from '@/design';
import { glassPanelStyle } from '@/design/GlassPanel';
import { useAllSessions } from '@/features/projects/useProjectSessions';
import { useNewProjectModal } from '@/features/projects/useNewProjectModal';
import { setRailCollapsed, useRailCollapsed } from './rail-collapsed';
import { RailResizeHandle } from './RailResizeHandle';
import { loadRailWidth, saveRailWidth } from './rail-width';
import { useNowTick } from '@/lib/useNowTick';
import { useRailTreeState } from './useRailTreeState';

const mono = "'IBM Plex Mono',monospace";
// A 30px square of content inside 8px gutters — the buttons are the widest thing the collapsed
// column ever holds.
const RAIL_COLLAPSED_WIDTH = 46;

// 25c 皮层弧 C — 两弧一核成 C / 由核向外的信号 (scheme.dc.html §25c)
function BrandMark({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle cx={33} cy={32} r={6} fill="var(--brand-badge-core)" />
      <path d="M42.29 23.64A12.5 12.5 0 1 0 42.29 40.36" stroke="var(--brand-badge-arc)" strokeWidth={6} strokeLinecap="round" />
      <path d="M48.6 17.95A21 21 0 1 0 48.6 46.05" stroke="var(--brand-badge-arc)" strokeWidth={6} strokeLinecap="round" />
    </svg>
  );
}

// Brand badge carrying the live UI↔server link as a presence dot on its corner. Binding
// connectivity to the app's own mark says the status in no width, and the word survives in the
// tooltip and in the daemon modal this opens. Exported because the top strip, not this rail, is
// where the brand block now lives — the strip stays visible when the rail is collapsed.
export function BrandBadge({ dot, label, onClick }: { dot: ConnectionDot; label: string; onClick: () => void }): JSX.Element {
  return (
    <div
      role="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        position: 'relative',
        width: 26,
        height: 26,
        borderRadius: 'var(--r-chip)',
        background: 'var(--brand-badge-bg)',
        border: '1px solid var(--brand-badge-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flex: 'none',
      }}
    >
      <BrandMark size={19} />
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: -3,
          bottom: -3,
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: dot.color,
          border: '2px solid var(--glass-2)',
        }}
      />
    </div>
  );
}

export function GearIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function LeftRail(): JSX.Element {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const L = useVocab();
  const lang = useLang();
  const collapsed = useRailCollapsed();
  const newProject = useNewProjectModal();
  const rateLimitStatus = useRateLimitStatus();

  const projectsQuery = useQuery(trpc.projects.list.queryOptions({}));
  // Every query below is UNSCOPED: the tree shows all projects at once, so scoping any of them to a
  // single project would be the exact restriction this rail exists to remove.
  const directSessionsQuery = useAllSessions('direct');
  const scheduledSessionsQuery = useAllSessions('scheduled');
  const schedulesQuery = useQuery(trpc.schedules.list.queryOptions({}));
  const commissionsQuery = useQuery(trpc.commissions.list.queryOptions({}));
  const scheduleModal = useScheduleModal();
  const commissionBoard = useCommissionBoard();
  // With the feature switched off a create silently drops the binding, so the row offers no ＋.
  const commissionEnabled = useCommissionEnabled();
  const teamEnabled = useTeamEnabled();
  // Keep every row's running dot live: one unscoped session.status subscription → refetch the list.
  useSessionsLiveSync();
  // Keep commission rows current: approval landings, decision projections and closes.
  useCommissionLiveSync();

  const { currentProjectId, setCurrentProject, setProjectOrder } = useCurrentProject();
  const { selectedSessionId, setSelectedSession, startCommissionDraft } = useSelectedSession();

  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const directSessions = useMemo(() => directSessionsQuery.data ?? [], [directSessionsQuery.data]);
  const scheduledSessions = useMemo(
    () => scheduledSessionsQuery.data ?? [],
    [scheduledSessionsQuery.data],
  );

  const rail = useRailTreeState();
  const { openProject, revealStars, retireDrag } = rail;
  const [runModalId, setRunModalId] = useState<string | null>(null);
  const markMany = useMarkManyRead();
  const [hover, setHover] = useState<string | null>(null);
  // Expanded width is the user's to set (drag the gutter); the collapse animation is switched off
  // while a drag is live, or every move would ease in 220ms behind the pointer.
  const [railWidth, setRailWidth] = useState(loadRailWidth);
  const [resizing, setResizing] = useState(false);
  const onRailResize = (width: number, done: boolean): void => {
    setRailWidth(width);
    setResizing(!done);
    if (done) saveRailWidth(width);
  };

  // One minute-tick `now` feeds both the row ages and the schedule sublines, so a row can never show
  // an age computed against a different clock than its neighbours, and ages advance while idle.
  const now = useNowTick(true, 60_000);
  const tree = useMemo(
    () =>
      buildRailTree({
        projects,
        directSessions,
        scheduledSessions,
        schedules: schedulesQuery.data ?? [],
        commissions: commissionsQuery.data ?? [],
        selectedSessionId,
        fallbackProjectId: currentProjectId,
        teamEnabled,
        ...rail.view,
        now,
        lang,
      }),
    [
      projects, directSessions, scheduledSessions, schedulesQuery.data, commissionsQuery.data,
      selectedSessionId, currentProjectId, teamEnabled, rail.view, now, lang,
    ],
  );

  // Reveal a newly selected/starred row once; an explicit collapse can still hide it afterwards.
  const selectedStarProject = [...directSessions, ...scheduledSessions]
    .find((session) => session.sessionId === selectedSessionId && session.starred)?.projectId;
  useEffect(() => {
    if (selectedStarProject) revealStars(selectedStarProject);
  }, [selectedSessionId, selectedStarProject, revealStars]);

  // Publish the exact visible project order for project pickers. A search temporarily filters the
  // tree, so it must not replace the full order shared with the new-session selector.
  const filter = rail.view.filter;
  useEffect(() => {
    if (!filter.trim()) setProjectOrder(tree.projects.map((project) => project.id));
  }, [filter, tree.projects, setProjectOrder]);

  // The tree's notion of "current" is the project owning the selected session. Push it into the
  // shared context so notes and issues follow the chat without the user ever switching project
  // explicitly.
  useEffect(() => {
    if (tree.currentProjectId && tree.currentProjectId !== currentProjectId) {
      setCurrentProject(tree.currentProjectId);
    }
  }, [tree.currentProjectId, currentProjectId, setCurrentProject]);

  // First visit: open the project the workbench already resolved to, so the rail does not greet a
  // new user with 20 closed folders.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !currentProjectId) return;
    seededRef.current = true;
    if (rail.view.expanded.size === 0) openProject(currentProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  // Any activity change retires an activity-mode drag (the manual order it wrote is kept).
  const activityStamp = directSessions.length + ':' + scheduledSessions.length + ':' +
    directSessions.reduce((max, s) => Math.max(max, Date.parse(s.lastUsedAt || s.createdAt) || 0), 0);
  useEffect(() => {
    retireDrag();
  }, [activityStamp, retireDrag]);

  const openSession = (projectId: string, sessionId: string) => {
    // Both writes leave in the same event: React batches them into one commit, so the selection's
    // project-membership check sees the NEW project and the chat never flashes the old one.
    setCurrentProject(projectId);
    setSelectedSession(sessionId);
    openProject(projectId);
    navigate('/workbench');
  };
  const onOpenSession = (row: RailSessionRow) => openSession(row.projectId, row.sessionId);
  // A selected worker holds its lead open (rail-tree), so collapsing it also moves the selection
  // to the lead.
  const onToggleWorkers = (row: RailSessionRow) => {
    if (!row.workersExpanded || !row.workers?.some((w) => w.selected)) {
      rail.toggleWorkers(row.sessionId);
      return;
    }
    rail.closeWorkers(row.sessionId);
    onOpenSession(row);
  };

  // "+ New" (⌘N) enters draft mode (no server call) — the session is created lazily on first send.
  const newSessionIn = (projectId: string | null) => {
    if (projectId) {
      setCurrentProject(projectId);
      openProject(projectId);
    }
    setSelectedSession('__draft__');
    navigate('/workbench');
  };
  // ⌘N itself is bound by the menu registry (shell/menu/useMenuShortcuts) — File → New session —
  // so the rail no longer keeps its own listener for it.
  const onNewSession = () => newSessionIn(null);

  // Another session on the same contract, from the row that already names it. The composer's ＋ menu
  // can do this too, but only by re-picking a commission the user is already standing on.
  const onNewCommissionSession = (row: RailCommissionRow) => {
    setCurrentProject(row.projectId);
    openProject(row.projectId);
    startCommissionDraft(row.commissionId);
    navigate('/workbench');
  };

  const onOverview = (projectId: string) => {
    setCurrentProject(projectId);
    navigate('/overview');
  };

  // ⌘1–9 follows the tree's visible order and is an explicit switch: expand the folder and open its
  // most recent session (plain folder clicks only expand).
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const openSessionRef = useRef(openSession);
  openSessionRef.current = openSession;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const idx = projectIndexFromKey(e.key);
      if (idx === null) return;
      const node = treeRef.current.projects.filter((p) => !p.empty)[idx];
      if (!node) return;
      e.preventDefault();
      const first = node.sessions[0] ?? node.starredSessions[0];
      if (first) openSessionRef.current(first.projectId, first.sessionId);
      else openProject(node.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openProject]);

  const visibleProjectIds = (): string[] => tree.projects.map((p) => p.id);
  const onSort = (mode: RailSortMode) => rail.sortBy(mode, visibleProjectIds());
  const onReorder = (draggedId: string, targetId: string) => rail.reorder(draggedId, targetId, visibleProjectIds());

  // From the collapsed rail: expand first, then open the field — the caller is one icon wide and
  // has nowhere to show what the search finds.
  const openSearchExpanded = () => {
    setRailCollapsed(false);
    rail.openSearch();
  };

  // Click routing: repeat → run-list modal; once with a run → open the session; a live schedule with
  // no runs yet → edit modal.
  const scheduleRows = useMemo(
    () => tree.projects.flatMap((p) => p.schedules),
    [tree.projects],
  );
  const runModalRow = runModalId ? scheduleRows.find((r) => r.scheduleId === runModalId) ?? null : null;
  const onScheduleRow = (row: ScheduleRow) => {
    const action = scheduleRowAction(row);
    if (action.type === 'modal') setRunModalId(row.scheduleId);
    else if (action.type === 'open') {
      const project = projectOfSession(action.sessionId, directSessions, scheduledSessions);
      if (project) openSession(project, action.sessionId);
    } else scheduleModal.openEdit(action.schedule);
  };

  // Approval center: real `approvals.list` pending count — the ALL-projects aggregate (the queue
  // has no per-project scope).
  const approvals = useApprovals();
  const approvalsQuery = useQuery(trpc.approvals.list.queryOptions({ status: 'pending' }));
  const pendingCount = approvalsQuery.data?.length ?? 0;
  const hasPendingApprovals = pendingCount > 0;
  const pendingLabel =
    pendingCount + ' ' + (pendingCount > 1 ? L.approvalsPending : L.approvalPending);

  const hp = (key: string) => ({
    onMouseEnter: () => setHover(key),
    onMouseLeave: () => setHover((h) => (h === key ? null : h)),
  });
  const isHover = (key: string) => hover === key;

  // Keep the current folder visible inside the tree's scroller. The tree stays mounted while the
  // rail is collapsed (display:none), so re-expanding runs this again and lands on the right folder.
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (collapsed || !tree.currentProjectId) return;
    const selector = `[data-project-row="${CSS.escape(tree.currentProjectId)}"]`;
    treeScrollRef.current?.querySelector(selector)?.scrollIntoView({ block: 'nearest' });
  }, [tree.currentProjectId, tree.projects.length, collapsed]);

  // COLLAPSED RAIL — this width cannot hold a tree, and the icon-per-project column it used to hold
  // was a second, worse navigator: no session titles, no ages, everything past the ninth project
  // scrolled out of reach. So the fold keeps only what stays true here — starting a session,
  // searching (which expands first), and the approvals queue. The brand badge and Settings moved to
  // the top strip, which never folds; new project stays in File → New project and in the expanded
  // tree's own header.
  const railDivider = <div aria-hidden="true" style={{ width: 20, height: 1, background: 'var(--proto-line)', margin: '3px 0', flex: 'none' }} />;
  const renderCollapsedRail = () => (
    <nav
      aria-label={L.lrRailNavigation}
      style={{ width: RAIL_COLLAPSED_WIDTH - 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '12px 0' }}
    >
      {/* The one filled square in the column, echoing the expanded rail's accent button: at this
          width the only way to say "primary" is with the fill. */}
      <button
        type="button"
        aria-label={L.wbNewSession}
        title={`${L.wbNewSession} · ⌘N`}
        onClick={onNewSession}
        {...hp('crail:new')}
        style={{
          width: 30,
          height: 30,
          border: 0,
          borderRadius: 9,
          padding: 0,
          cursor: 'pointer',
          flex: 'none',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ink-solid-fg)',
          background: isHover('crail:new') ? 'var(--proto-accent-strong)' : 'var(--proto-accent)',
          boxShadow: 'var(--accent-glow)',
        }}
      >
        <PlusGlyph size={14} />
      </button>
      {railDivider}
      {/* Searching means reading results, and results need the full width — so this opens the rail
          with the field already focused rather than searching inside the fold. */}
      <IconButton label={L.wbFilterSessions} onClick={openSearchExpanded}>
        <SearchIcon />
      </IconButton>
      <div style={{ flex: 1, minHeight: 8 }} />
      {hasPendingApprovals && (
        <IconButton label={pendingLabel} tone="amber" onClick={() => approvals.open()}>
          <span style={{ minWidth: 16, height: 16, padding: '0 4px', borderRadius: 'var(--r-chip)', background: 'var(--proto-amber)', color: 'var(--amber-fill-fg)', font: `600 11px ${mono}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            {pendingCount}
          </span>
        </IconButton>
      )}
    </nav>
  );

  // The wrapper exists for the resize handle: the pane clips (overflow:hidden), and the handle has
  // to reach past its rim into the gutter.
  return (
    <div style={{ position: 'relative', flex: 'none', display: 'flex', minHeight: 0 }}>
      <div
        data-pane="left"
        data-collapsed={collapsed || undefined}
        style={{
          width: collapsed ? RAIL_COLLAPSED_WIDTH : railWidth,
          transition: resizing ? 'none' : 'width 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          ...glassPanelStyle,
        }}
      >
        {collapsed && renderCollapsedRail()}
        {/* The expanded tree stays mounted at its full width while collapsed, so it keeps its scroll
            position and the pane slides out of view instead of reflowing into the fold's width. */}
        <div
          ref={treeScrollRef}
          style={{ display: collapsed ? 'none' : 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: railWidth }}
        >
          {/* The rail has exactly one primary action, so it gets a full row rather than a text link
              competing with a section heading. The wrapper carries the column's top inset: the brand
              block moved to the top strip, which is where the rail's first row used to get its air. */}
          <div style={{ padding: '14px 12px 10px', flex: 'none' }}>
            <div
              {...hp('newsess')}
              role="button"
              onClick={onNewSession}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                height: 36,
                borderRadius: 'var(--r-control)',
                cursor: 'pointer',
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--ink-solid-fg)',
                background: isHover('newsess') ? 'var(--proto-accent-strong)' : 'var(--proto-accent)',
                // The rail's one primary action: the glow is what separates it from the list it sits on.
                boxShadow: 'var(--accent-glow)',
              }}
            >
              <PlusGlyph size={13} />
              {L.wbNewSession}
              <span style={{ position: 'absolute', right: 11, font: `500 11px ${mono}`, color: 'var(--ink-solid-fg)' }}>⌘N</span>
            </div>
          </div>

          <RailTree
            nodes={tree.projects}
            projectCount={projects.length}
            sort={rail.view.sort}
            onSort={onSort}
            filter={filter}
            onFilter={rail.setFilter}
            searchOpen={rail.searchOpen}
            onToggleSearch={rail.toggleSearch}
            onNewProject={() => newProject.open()}
            onToggleProject={rail.toggleProject}
            onToggleSchedules={rail.toggleSchedules}
            onToggleStars={rail.toggleStars}
            onToggleCommissions={rail.toggleCommissions}
            onToggleCommission={rail.toggleCommission}
            onToggleWorkers={onToggleWorkers}
            onOpenCommission={commissionBoard.openCommission}
            onNewCommissionSession={commissionEnabled ? onNewCommissionSession : undefined}
            onShowAll={rail.showAllIn}
            onShowFewer={rail.showFewer}
            onOpenSession={onOpenSession}
            onNewSessionIn={newSessionIn}
            onOverview={onOverview}
            onScheduleRow={onScheduleRow}
            onReorder={onReorder}
            now={now}
          />

          {/* attention zone — everything that appears intermittently and asks for attention stacks
              here, at the foot of the column, so the rows above keep a fixed layout no matter what
              the system is doing. */}
          {(rateLimitStatus || hasPendingApprovals) && (
            <div style={{ margin: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 8, flex: 'none' }}>
              <RailRateLimitStatus status={rateLimitStatus} />
              {hasPendingApprovals && (
                <div
                  {...hp('approval')}
                  onClick={() => approvals.open()}
                  style={{
                    // Matches the rate-limit banner above it (RailRateLimitStatus): one flat row height.
                    height: 34,
                    padding: '0 12px',
                    background: 'var(--proto-amber-bg)',
                    border: '1px solid ' + (isHover('approval') ? 'var(--proto-amber)' : 'var(--proto-amber-border)'),
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                    flex: 'none',
                    // Urgent, not merely coloured: the tinted lift is what pulls the card off the rail.
                    boxShadow: 'var(--shadow-amber-lift)',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: 'var(--proto-amber)',
                      flex: 'none',
                    }}
                  />
                  <div style={{ fontSize: 12, color: 'var(--proto-amber-fg)', fontWeight: 600 }}>{pendingLabel}</div>
                  <div style={{ marginLeft: 'auto', color: 'var(--proto-amber-accent)', fontSize: 11 }}>→</div>
                </div>
              )}
            </div>
          )}
        </div>


        {runModalRow && (
          <RunListModal
            row={runModalRow}
            selectedSessionId={selectedSessionId ?? null}
            onOpenRun={(sessionId) => {
              setRunModalId(null);
              const project = projectOfSession(sessionId, directSessions, scheduledSessions);
              if (project) openSession(project, sessionId);
            }}
            onManage={
              runModalRow.schedule
                ? () => {
                    setRunModalId(null);
                    scheduleModal.openEdit(runModalRow.schedule!);
                  }
                : undefined
            }
            onMarkAllRead={markMany.markManyRead}
            markAllPending={markMany.pending}
            onClose={() => setRunModalId(null)}
          />
        )}

      </div>
      {!collapsed && <RailResizeHandle width={railWidth} onResize={onRailResize} />}
    </div>
  );
}
