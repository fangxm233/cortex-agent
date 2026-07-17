import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { groupSessions, sessionMeta, groupLabel } from './session-groups';
import { runningCountByProject, unreadCountByProject } from './project-menu';
import { formatCost } from './right-panel-vm';
import {
  buildProjectRailRows,
  clampProjectsZoneHeight,
  lastActivityByProject,
  projectIndexFromKey,
  projectShortLabel,
  sortProjectsByActivity,
  PROJECTS_ZONE_DEFAULT_H,
} from './left-rail-projects';
import { NewProjectModal } from './NewProjectModal';
import { useApprovals } from '@/features/approvals/ApprovalsProvider';
import { useCurrentProject } from './CurrentProjectProvider';
import { useSelectedSession } from './SelectedSessionProvider';
import { useLang, useSetLang, useVocab } from '@/i18n';
import { DaemonStatusModal } from './DaemonStatusModal';
import { useSessionsLiveSync } from './useSessionsLiveSync';

// LEFT RAIL — 22a dual-zone rebuild (scheme.dc.html §22a, L37–150). Top zone: PROJECTS always
// expanded — one row per project ordered by MOST RECENT ACTIVITY (persistent, from the session
// registry's lastUsedAt; ⌘1–9 follow this order, ⌘1 = most recently active), single click
// switches, the active row expands one sub-entry line (Overview + today-cost readout); per-row badges =
// real running-thread count (threads.list) + unread-session count (honest addition, kept from the
// retired switcher popover). Draggable divider. Bottom zone: current project's SESSIONS with the
// project-name echo + "+ New" moved into the zone header. Data gaps rendered honestly (flagged in
// CORTEX.md): no per-row amber approval dot (ApprovalInfo has no projectId — the bottom pill stays
// the all-projects aggregate); idle rows show a real last-activity age derived from the unscoped
// sessions.list. Active-row sub-entry line = the Overview route + a direct today-cost readout
// (real cost.summary.today for the active project); the former Tasks/Cost link entries were removed.
const mono = "'IBM Plex Mono',monospace";
const ZONE_H_KEY = 'cortex.railProjectsH';

function initialZoneH(): number {
  try {
    const raw = window.localStorage.getItem(ZONE_H_KEY);
    if (raw === null) return PROJECTS_ZONE_DEFAULT_H;
    return clampProjectsZoneHeight(Number(raw));
  } catch {
    return PROJECTS_ZONE_DEFAULT_H;
  }
}

export function LeftRail(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const trpc = useTRPC();
  const lang = useLang();
  const setLang = useSetLang();
  const L = useVocab();
  const projectsQuery = useQuery(trpc.projects.list.queryOptions({}));

  // Active project = the shared cross-pane current project (task 569c): the explicit selection,
  // else the derived default (most-recent session's project, else first listed project).
  const { currentProjectId: activeProjectId, setCurrentProject } = useCurrentProject();

  // Only user-initiated conversations belong in the left rail, scoped to the current project so
  // switching project switches the session list (backend filters by projectId).
  const sessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'direct', projectId: activeProjectId ?? undefined }),
  );
  // Keep every row's running dot live: one unscoped session.status subscription → refetch the list.
  useSessionsLiveSync();

  // Active project's REAL today cost (mirrors RightPanel's cost bar, task 569c) — replaces the
  // active row's former Tasks/Cost sub-entries with a direct today-cost readout.
  const costQuery = useQuery({
    ...trpc.cost.summary.queryOptions({ projectId: activeProjectId ?? undefined }),
    enabled: !!activeProjectId,
  });
  const todayCost = costQuery.data?.today;
  const todayCostLabel = typeof todayCost === 'number' ? formatCost(todayCost) : '—';

  const projects = projectsQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];

  // Real per-project running counts for the PROJECTS-zone badges (ThreadInfo has projectId+status).
  const threadsQuery = useQuery(trpc.threads.list.queryOptions({}));
  const threads = threadsQuery.data ?? [];
  const runningCounts = useMemo(() => runningCountByProject(threads), [threads]);

  // UNSCOPED direct-session list (all projects) → per-project unread badges + idle-age labels.
  // Kept fresh by the same useSessionsLiveSync invalidation.
  const allSessionsQuery = useQuery(trpc.sessions.list.queryOptions({ origin: 'direct' }));
  const unreadCounts = useMemo(
    () => unreadCountByProject(allSessionsQuery.data ?? []),
    [allSessionsQuery.data],
  );
  const lastActivity = useMemo(
    () => lastActivityByProject(allSessionsQuery.data ?? []),
    [allSessionsQuery.data],
  );

  // Order rows by most-recent activity (persistent — derived from the session registry's
  // lastUsedAt, so it survives server/app restarts). ⌘1–9 follow this order (⌘1 = most recent).
  const sortedProjects = useMemo(
    () => sortProjectsByActivity(projects, lastActivity),
    [projects, lastActivity],
  );
  const projectRows = useMemo(
    () =>
      buildProjectRailRows(sortedProjects, activeProjectId, runningCounts, unreadCounts, lastActivity, Date.now()),
    [sortedProjects, activeProjectId, runningCounts, unreadCounts, lastActivity],
  );

  // New-project modal (kept from the retired switcher popover, task c551).
  const [newProjOpen, setNewProjOpen] = useState(false);

  // Single click switches the project: the SESSIONS zone re-scopes and the selected-session
  // provider re-derives the project's most-recent session; returning to /workbench opens it
  // (22a: "单击即切换 … 自动打开其最新 session").
  const onSwitchProject = (id: string) => {
    if (id !== activeProjectId) setCurrentProject(id);
    navigate('/workbench');
  };

  // ⌘1–9 switches by the visible PROJECTS order (most-recent-activity first; ⌘1 = latest active).
  const projectRowsRef = useRef(projectRows);
  projectRowsRef.current = projectRows;
  const onSwitchProjectRef = useRef(onSwitchProject);
  onSwitchProjectRef.current = onSwitchProject;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const idx = projectIndexFromKey(e.key);
      if (idx === null) return;
      const row = projectRowsRef.current[idx];
      if (!row) return;
      e.preventDefault();
      onSwitchProjectRef.current(row.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the active row visible inside the zone's internal scroller (20 real projects vs the
  // design's 4 — without this a switch via ⌘k or derivation can leave the active row folded).
  const projectsScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!activeProjectId) return;
    const el = projectsScrollRef.current?.querySelector(
      `[data-project-row="${CSS.escape(activeProjectId)}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeProjectId, projectRows.length]);

  // Draggable divider: adjusts the PROJECTS zone height (rows scroll internally, header pinned).
  const [zoneH, setZoneH] = useState(initialZoneH);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onDividerDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: zoneH };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setZoneH(clampProjectsZoneHeight(d.startH + (ev.clientY - d.startY)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setZoneH((h) => {
        try {
          window.localStorage.setItem(ZONE_H_KEY, String(h));
        } catch {
          /* persistence is best-effort */
        }
        return h;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const groups = useMemo(() => groupSessions(sessions, Date.now()), [sessions]);

  // Selection is the shared cross-pane state: clicking a row re-points the center chat.
  const { selectedSessionId: effectiveSelected, setSelectedSession } = useSelectedSession();

  // Approval center (Stage-R3): real `approvals.list` pending count — the ALL-projects aggregate
  // (22a keeps the bottom pill global; the queue has no per-project scope).
  const approvals = useApprovals();
  const approvalsQuery = useQuery(trpc.approvals.list.queryOptions({ status: 'pending' }));
  const pendingCount = approvalsQuery.data?.length ?? 0;
  const hasPendingApprovals = pendingCount > 0;
  const pendingLabel =
    pendingCount + ' ' + (pendingCount > 1 ? L.approvalsPending : L.approvalPending);

  // "+ New" (⌘N) enters draft mode (no server call) — the session is created lazily on first send.
  const onNewSession = () => {
    setSelectedSession('__draft__');
    navigate('/workbench');
  };
  const onSelectSession = (id: string) => {
    setSelectedSession(id);
    navigate('/workbench');
  };
  const onNewSessionRef = useRef(onNewSession);
  onNewSessionRef.current = onNewSession;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        onNewSessionRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Active-row sub-entry: only the real Overview route now — the former Tasks/Cost entries were
  // dropped in favour of a direct today-cost readout rendered alongside (real cost.summary.today).
  const subEntries: { key: string; label: string; to: string }[] = [
    { key: 'overview', label: L.overview, to: '/overview' },
  ];

  const [hover, setHover] = useState<string | null>(null);
  const [daemonOpen, setDaemonOpen] = useState(false);
  const hp = (key: string) => ({
    onMouseEnter: () => setHover(key),
    onMouseLeave: () => setHover((h) => (h === key ? null : h)),
  });
  const isHover = (key: string) => hover === key;

  return (
    <div
      data-pane="left"
      style={{
        width: 340,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        background: '#FBFBFC',
        borderRight: '1px solid #E7E9EE',
        minHeight: 0,
      }}
    >
      {/* header: cx logo + Cortex + daemon status (22a L43–47) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '16px 16px 10px', flex: 'none' }}>
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: '#191C22',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: `600 12px ${mono}`,
          }}
        >
          cx
        </div>
        <div style={{ fontWeight: 650, fontSize: 14, color: '#191C22', letterSpacing: '-.01em' }}>Cortex</div>
        <div
          onClick={() => setDaemonOpen(true)}
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 10,
            color: '#23854F',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#23854F' }} />
          {L.wbDaemon}
        </div>
      </div>

      {/* PROJECTS zone (22a L49–84): header pinned, rows scroll internally up to the drag height */}
      <div data-zone="projects" style={{ flex: 'none', padding: '2px 12px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 4px 5px' }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: '#B6BDC9' }}>
            {L.wbProjects}
          </span>
          <span style={{ font: `500 9.5px ${mono}`, color: '#D9DCE3', marginLeft: 5 }}>{projects.length}</span>
          <span
            {...hp('newproj')}
            onClick={() => setNewProjOpen(true)}
            title={L.newProject}
            style={{
              marginLeft: 'auto',
              fontSize: 13,
              color: isHover('newproj') ? '#191C22' : '#8A93A2',
              lineHeight: 1,
              cursor: 'pointer',
              padding: '0 2px',
            }}
          >
            +
          </span>
        </div>
        <div ref={projectsScrollRef} style={{ maxHeight: zoneH, overflowY: 'auto' }}>
          {projectRows.map((row) => {
            const rowKey = 'proj:' + row.id;
            if (row.active) {
              return (
                <div key={row.id} data-project-row={row.id} style={{ background: '#EFF1F5', borderRadius: 8, padding: '7px 9px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 6,
                        background: '#4655D4',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        font: `600 9px ${mono}`,
                        flex: 'none',
                      }}
                    >
                      {row.initials}
                    </div>
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 650,
                        color: '#191C22',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {row.id}
                    </span>
                    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, flex: 'none' }}>
                      {row.running > 0 && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3, font: `600 9.5px ${mono}`, color: '#4655D4' }}>
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: '#4655D4',
                              animation: 'cxpulse 1.6s ease-in-out infinite',
                            }}
                          />
                          {row.running}
                        </span>
                      )}
                      {row.unread > 0 && (
                        <span
                          data-unread-badge={row.id}
                          style={{
                            minWidth: 14,
                            height: 14,
                            padding: '0 4px',
                            borderRadius: 7,
                            background: '#4655D4',
                            color: '#fff',
                            font: `600 9px ${mono}`,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {row.unread}
                        </span>
                      )}
                    </span>
                  </div>
                  {/* sub-entry line: Overview + direct today-cost readout + hotkey echo (22a L64–67) */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      padding: '5px 0 1px 28px',
                      fontSize: 10.5,
                      fontWeight: 600,
                      color: '#5B6472',
                    }}
                  >
                    {subEntries.map((entry) => {
                      const current = location.pathname.startsWith(entry.to);
                      const k = 'sub:' + entry.key;
                      return (
                        <span
                          key={entry.key}
                          {...hp(k)}
                          onClick={() => navigate(entry.to)}
                          style={{
                            color: current ? '#4655D4' : isHover(k) ? '#191C22' : '#5B6472',
                            cursor: 'pointer',
                          }}
                        >
                          {entry.label}
                        </span>
                      );
                    })}
                    {/* Today cost — real cost.summary.today for the active project (replaces Tasks/Cost). */}
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: '#8A93A2', fontWeight: 600 }}>{L.today}</span>
                      <span style={{ font: `600 10px ${mono}`, color: '#4655D4' }}>{todayCostLabel}</span>
                    </span>
                    {row.hotkey && (
                      <span style={{ marginLeft: 'auto', font: `500 9px ${mono}`, color: '#B6BDC9', fontWeight: 400 }}>
                        {row.hotkey}
                      </span>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div
                key={row.id}
                {...hp(rowKey)}
                data-project-row={row.id}
                onClick={() => onSwitchProject(row.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 9px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: isHover(rowKey) ? '#F1F2F5' : 'transparent',
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 6,
                    background: '#EEF0FA',
                    color: '#4655D4',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    font: `600 9px ${mono}`,
                    flex: 'none',
                  }}
                >
                  {row.initials}
                </div>
                <span
                  style={{
                    fontSize: 12.5,
                    color: row.unread > 0 ? '#191C22' : '#22262E',
                    fontWeight: row.unread > 0 ? 600 : 400,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {row.id}
                </span>
                <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, flex: 'none' }}>
                  {row.running > 0 && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3, font: `600 9.5px ${mono}`, color: '#4655D4' }}>
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: '#4655D4',
                          animation: 'cxpulse 1.6s ease-in-out infinite',
                        }}
                      />
                      {row.running}
                    </span>
                  )}
                  {row.unread > 0 && (
                    <span
                      data-unread-badge={row.id}
                      style={{
                        minWidth: 14,
                        height: 14,
                        padding: '0 4px',
                        borderRadius: 7,
                        background: '#4655D4',
                        color: '#fff',
                        font: `600 9px ${mono}`,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {row.unread}
                    </span>
                  )}
                  {row.idleAge !== null ? (
                    <span style={{ font: `400 9.5px ${mono}`, color: '#B6BDC9' }}>{row.idleAge}</span>
                  ) : (
                    row.hotkey && <span style={{ font: `400 9px ${mono}`, color: '#D9DCE3' }}>{row.hotkey}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* draggable divider (22a L86–90) */}
      <div
        data-divider="rail"
        onMouseDown={onDividerDown}
        title="drag to resize"
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 12px 5px',
          cursor: 'row-resize',
          userSelect: 'none',
        }}
      >
        <div style={{ flex: 1, height: 1, background: '#E7E9EE' }} />
        <div style={{ display: 'flex', gap: 3 }}>
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#D9DCE3' }} />
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#D9DCE3' }} />
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#D9DCE3' }} />
        </div>
        <div style={{ flex: 1, height: 1, background: '#E7E9EE' }} />
      </div>

      {/* SESSIONS zone (22a L92–122): header with project echo + "+ New" ⌘N, grouped rows below */}
      <div
        data-zone="sessions"
        style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '0 12px' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '2px 4px 6px', flex: 'none' }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: '#B6BDC9' }}>
            {L.wbSessions}
          </span>
          {activeProjectId && (
            <span style={{ font: `500 9.5px ${mono}`, color: '#C9CFF2', marginLeft: 5 }}>
              {projectShortLabel(activeProjectId)}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              {...hp('newsess')}
              onClick={onNewSession}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: isHover('newsess') ? '#3543B8' : '#4655D4',
                cursor: 'pointer',
              }}
            >
              + {L.wbNewShort}
            </span>
            <span style={{ font: `500 9.5px ${mono}`, color: '#B6BDC9' }}>⌘N</span>
          </span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {groups.map((g, gi) => (
            <div key={g.label}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '.07em',
                  color: '#B6BDC9',
                  padding: gi === 0 ? '2px 4px 5px' : '10px 4px 6px',
                }}
              >
                {groupLabel(L, g.label)}
              </div>
              {g.items.map((s: SessionInfo) => {
                const active = s.sessionId === effectiveSelected;
                // Real running snapshot (SessionInfo.running), kept fresh by useSessionsLiveSync.
                const running = s.running;
                const rowKey = 'sess:' + s.sessionId;
                const bg = active ? '#EFF1F5' : isHover(rowKey) ? '#F1F2F5' : 'transparent';
                return (
                  <div
                    key={s.sessionId}
                    {...hp(rowKey)}
                    className="sess-row"
                    data-session-id={s.sessionId}
                    onClick={() => onSelectSession(s.sessionId)}
                    style={{ borderRadius: 8, padding: '8px 10px', cursor: 'pointer', background: bg, position: 'relative' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      {running && (
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: '#4655D4',
                            flex: 'none',
                            animation: 'cxpulse 1.6s ease-in-out infinite',
                          }}
                        />
                      )}
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 12.5,
                          // Unread emphasis (honest addition): unread rows keep the full ink +
                          // semibold; read rows soften so unread reads darker at a glance.
                          fontWeight: active || s.unread ? 600 : 400,
                          color: s.unread || active ? '#191C22' : '#454C59',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {s.label ?? s.name}
                      </span>
                      <span
                        className="sess-more"
                        style={{
                          flex: 'none',
                          color: '#98A1B0',
                          fontSize: 13,
                          letterSpacing: 1,
                          padding: '0 4px',
                          borderRadius: 5,
                          lineHeight: 1.2,
                        }}
                      >
                        ⋯
                      </span>
                    </div>
                    <div
                      style={{
                        font: `400 10px ${mono}`,
                        color: active ? '#8A93A2' : '#B6BDC9',
                        marginTop: 3,
                        paddingLeft: running ? 14 : 0,
                      }}
                    >
                      {sessionMeta(L, s)}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* approval-pending banner — ALL-projects aggregate (real approvals.list; opens the center) */}
      {hasPendingApprovals && (
        <div
          {...hp('approval')}
          onClick={() => approvals.open()}
          style={{
            margin: '0 12px 10px',
            padding: '9px 12px',
            background: '#FDF9F0',
            border: '1px solid ' + (isHover('approval') ? '#E3C88A' : '#EFDDB0'),
            borderRadius: 9,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            flex: 'none',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: '#C99A2E',
              flex: 'none',
              animation: 'cxpulse 2s ease-in-out infinite',
            }}
          />
          <div style={{ fontSize: 11.5, color: '#8A5B06', fontWeight: 600 }}>{pendingLabel}</div>
          <div style={{ marginLeft: 'auto', color: '#C0A96E', fontSize: 11 }}>→</div>
        </div>
      )}

      {/* footer: EN/中 toggle + Settings */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 16px 14px',
          borderTop: '1px solid #EFF1F5',
          flex: 'none',
        }}
      >
        <div style={{ display: 'flex', border: '1px solid #E7E9EE', borderRadius: 6, overflow: 'hidden' }}>
          <span
            onClick={() => setLang('en')}
            style={{ fontSize: 10, fontWeight: 600, padding: '2.5px 7px', cursor: 'pointer', background: lang === 'en' ? '#191C22' : 'transparent', color: lang === 'en' ? '#fff' : '#8A93A2' }}
          >
            EN
          </span>
          <span
            onClick={() => setLang('zh')}
            style={{ fontSize: 10, fontWeight: 600, padding: '2.5px 7px', cursor: 'pointer', background: lang === 'zh' ? '#191C22' : 'transparent', color: lang === 'zh' ? '#fff' : '#8A93A2' }}
          >
            中
          </span>
        </div>
        <span
          {...hp('settings')}
          onClick={() => navigate('/settings')}
          style={{ marginLeft: 'auto', fontSize: 11.5, color: isHover('settings') ? '#191C22' : '#8A93A2', cursor: 'pointer' }}
        >
          {L.settings}
        </span>
      </div>

      {newProjOpen && <NewProjectModal onClose={() => setNewProjOpen(false)} />}

      <DaemonStatusModal open={daemonOpen} onClose={() => setDaemonOpen(false)} />
    </div>
  );
}
