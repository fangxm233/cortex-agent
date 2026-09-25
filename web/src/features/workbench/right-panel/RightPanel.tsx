// input:  pane state, thread/task/machine resources, vocab
// output: RightPanel
// pos:    Context drawer with steady readable count badges
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { TasksPanel } from '@/features/tasks/TasksPanel';
import { actionableOpenCount } from '@/features/tasks/group-tasks';
import { PaneToggle } from './PaneToggle';
import { RightThreadCard } from './RightThreadCard';
import { RightMachinesTab } from './RightMachinesTab';
import { onlineMachineCount, rightPanelBudget } from './right-panel-vm';
import { groupThreads, type ThreadGroup } from '@/features/session/composer/scope';
import { useRecentNow } from '@/lib/useRecentNow';
import { useThreadsLiveSync } from '@/features/session/live/useThreadsLiveSync';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useVocab } from '@/i18n';
import { NotesPane } from '@/features/notes/NotesPane';
import { useNotes } from '@/features/notes/NotesProvider';
import { useMachinesResource } from '@/features/machines/useMachinesResource';
import { usePaneState } from '@/shell/PaneStateProvider';

// RIGHT PANEL — context drawer + icon rail, following glass-prototype.dc.html L247–362 (segmented
// tab control, ringed cards, badge-carrying rail). Real tRPC data (cost.summary / threads.list /
// threads.get / tasks.list) is substituted into the design's structure. Machines and the
// project-scoped daily budget use their live query data; Pause still has no mutate op and remains
// non-functional.

type Tab = 'threads' | 'tasks' | 'machines';
type PanelTarget = Tab | 'notes';
type PanelLabels = Record<PanelTarget, string>;
type PanelCounts = Record<Tab, number>;
type PanelBudget = ReturnType<typeof rightPanelBudget>;

const PANEL_WIDTH = 380;
const PANEL_RAIL_WIDTH = 42;

const PANEL_ICONS: Record<PanelTarget, ReactNode> = {
  threads: <><path d="M8 6h11M8 12h8M8 18h5" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8 12 2.5 2.5L16 9" /></>,
  machines: <><rect x="4" y="4" width="16" height="6" rx="2" /><rect x="4" y="14" width="16" height="6" rx="2" /><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5" /></>,
  notes: <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v5h4M9 12h6M9 16h6" /></>,
};

function PanelIcon({ target, size = 14 }: { target: PanelTarget; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PANEL_ICONS[target]}
    </svg>
  );
}

function PanelRailButton({ target, label, active, count = 0, pulse, onClick }: {
  target: PanelTarget;
  label: string;
  active: boolean;
  count?: number;
  /** Badges only breathe while the drawer is shut — once it is open the same counts are on screen. */
  pulse?: boolean;
  onClick: () => void;
}) {
  return <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      style={{
        position: 'relative',
        width: 30,
        height: 30,
        border: 0,
        borderRadius: 'var(--r-chip)',
        background: active ? 'var(--proto-accent-bg)' : 'transparent',
        color: active ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
        display: 'grid',
        placeItems: 'center',
        padding: 0,
        cursor: 'pointer',
      }}
    >
      <PanelIcon target={target} size={15} />
      {count > 0 && (
        <span
          style={{
            position: 'absolute',
            top: -3,
            right: -3,
            minWidth: 14,
            height: 14,
            padding: '0 3px',
            boxSizing: 'border-box',
            borderRadius: 7,
            font: "600 11px 'IBM Plex Mono',monospace",
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--proto-accent)',
            color: 'var(--ink-solid-fg)',
            ...(pulse ? { animation: 'cxglow 1.6s ease-in-out infinite' } : {}),
          }}
        >
          {count}
        </span>
      )}
    </button>;
}

function RailBudgetMeter({ budget, label }: { budget: PanelBudget; label: string }) {
  return (
    <div
      title={label}
      style={{
        width: 4,
        height: 64,
        borderRadius: 'var(--r-pill)',
        background: 'var(--proto-line)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        marginBottom: 6,
        overflow: 'hidden',
      }}
    >
      <div style={{ width: '100%', height: `${budget.percent}%`, borderRadius: 'var(--r-pill)', background: 'var(--proto-accent)' }} />
    </div>
  );
}

function RightPanelRail({ active, labels, counts, budget, budgetLabel, navigationLabel, expanded, toggleLabel, onToggle, onSelect }: {
  active: PanelTarget;
  labels: PanelLabels;
  counts: PanelCounts;
  budget: PanelBudget;
  budgetLabel: string;
  navigationLabel: string;
  /** The rail no longer disappears when the drawer opens, so its chevron carries the drawer's state
   *  and its click is a toggle rather than the expand-only action of the docked panel. */
  expanded: boolean;
  toggleLabel: string;
  onToggle: () => void;
  onSelect: (target: PanelTarget) => void;
}) {
  const workTargets: Tab[] = ['threads', 'tasks', 'machines'];
  return (
    <nav aria-label={navigationLabel} style={{ width: PANEL_RAIL_WIDTH - 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 0' }}>
      <PaneToggle side="right" expanded={expanded} label={toggleLabel} onClick={onToggle} />
      <div aria-hidden="true" style={{ width: 20, height: 1, background: 'var(--proto-line)', margin: '3px 0' }} />
      {workTargets.map((target) => <PanelRailButton key={target} target={target} label={labels[target]} active={active === target} count={counts[target]} pulse={!expanded} onClick={() => onSelect(target)} />)}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <RailBudgetMeter budget={budget} label={budgetLabel} />
        <PanelRailButton target="notes" label={labels.notes} active={active === 'notes'} onClick={() => onSelect('notes')} />
      </div>
    </nav>
  );
}

export function RightPanel(): JSX.Element {
  const L = useVocab();
  const notes = useNotes();
  const [tab, setTab] = useState<Tab>('threads');
  const { panelCollapsed: collapsed, setPanelCollapsed: setCollapsed } = usePaneState();
  // Opening Notes force-expands the panel: the drawer renders inside it, so a collapsed panel
  // would swallow the surface the user just asked for.
  useEffect(() => {
    if (notes.isOpen) setCollapsed(false);
  }, [notes.isOpen, setCollapsed]);
  const active: PanelTarget = notes.isOpen ? 'notes' : tab;
  const labels: PanelLabels = { threads: L.threads, tasks: L.tasks, machines: L.machines, notes: notes.copy.title };
  // The rail badges and its budget meter stay on screen while the drawer is shut, so the panel's
  // data is read here rather than inside the drawer body that consumes the rest of it.
  const data = useRightPanelData(tab);
  const counts: PanelCounts = { threads: data.activeThreadCount, tasks: data.openTaskCount, machines: data.machineCount };
  const select = (target: PanelTarget) => {
    setCollapsed(false);
    if (target === 'notes') return notes.open();
    notes.close();
    setTab(target);
  };
  const collapseAction = <DrawerCollapseButton label={L.rpCollapsePanel} onClick={() => setCollapsed(true)} />;
  return (
    <>
      {/* Click-catcher: the drawer covers the workspace, so clicking the covered content is the
          natural "I am done with this" gesture. It stops short of the icon rail, which stays live. */}
      {!collapsed && (
        <div
          onClick={() => setCollapsed(true)}
          style={{ position: 'absolute', inset: `0 ${PANEL_RAIL_WIDTH}px 0 0`, zIndex: 5, background: 'transparent', cursor: 'default' }}
        />
      )}
      {/* The rail is permanent now: it is the drawer's handle, and a handle that vanishes when the
          drawer opens leaves nothing to grab. Kept above the sheet so the entry slide passes behind it. */}
      <aside data-pane="right" data-collapsed={collapsed || undefined} style={{ width: PANEL_RAIL_WIDTH, flex: 'none', background: 'var(--proto-rail)', borderLeft: '1px solid var(--proto-line)', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative', zIndex: 7, borderTopRightRadius: 'var(--r-panel)', borderBottomRightRadius: 'var(--r-panel)' }}>
        <RightPanelRail
          active={active}
          labels={labels}
          counts={counts}
          budget={data.budget}
          budgetLabel={`${L.today} ${data.budget.todayLabel} / ${data.budget.limitLabel}`}
          navigationLabel={L.rpPanelNavigation}
          expanded={!collapsed}
          toggleLabel={collapsed ? L.rpExpandPanel : L.rpCollapsePanel}
          onToggle={() => setCollapsed(!collapsed)}
          onSelect={select}
        />
      </aside>
      {/* The context drawer FLOATS over the workspace instead of docking beside it — it is a thing
          you consult and dismiss, not a third column the chat has to live around. Its width and
          contents are unchanged; only where it sits is.
          This sheet is the one `backdrop-filter` in the workbench: it is a top-level floating
          overlay that does not move or repaint while the lists inside it scroll, so the blur is
          composited once. Nothing inside it may blur.
          `display` rather than unmounting: the notes draft and the panel's queries must survive a
          collapse, and `display: none` also guarantees the blur costs nothing while closed (and
          replays the entry animation on each open). */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          bottom: 10,
          right: PANEL_RAIL_WIDTH + 10,
          width: PANEL_WIDTH,
          zIndex: 6,
          display: collapsed ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
          overflow: 'hidden',
          borderRadius: 'var(--r-float)',
          background: 'var(--glass-2)',
          backdropFilter: 'var(--glass-filter)',
          WebkitBackdropFilter: 'var(--glass-filter)',
          boxShadow: 'var(--shadow-float)',
          animation: 'cxdrawer 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {notes.isOpen
          ? <NotesPane headerIcon={<PanelIcon target="notes" />} headerAction={collapseAction} visible={!collapsed} />
          : <RightWorkPanel data={data} tab={tab} counts={counts} onTabChange={setTab} headerAction={collapseAction} />}
      </div>
    </>
  );
}

// The drawer's own chevron, not the rail's `PaneToggle`: inside the sheet it is a borderless
// hover-lit chip, while the rail keeps its outlined handle.
function DrawerCollapseButton({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-expanded
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 28,
        height: 28,
        border: 0,
        borderRadius: 'var(--r-chip)',
        background: hover ? 'var(--proto-line-2)' : 'transparent',
        color: hover ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
        display: 'grid',
        placeItems: 'center',
        padding: 0,
        cursor: 'pointer',
        flex: 'none',
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  );
}

function TabButton({ label, count, countColor, active, dot, onClick }: {
  label: string;
  count: string;
  countColor: string;
  active: boolean;
  dot?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} style={{ flex: 1, fontFamily: 'inherit', fontSize: 12, fontWeight: active ? 600 : 500, color: active ? 'var(--proto-ink)' : 'var(--proto-muted)', height: 28, border: 0, borderRadius: 'var(--r-chip)', background: active ? 'var(--glass-2)' : 'transparent', boxShadow: active ? 'var(--shadow-card)' : 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, transition: 'background .15s' }}>
      {label}
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-accent)', display: 'inline-block' }} />}
      <span style={{ font: "500 11px 'IBM Plex Mono',monospace", color: countColor }}>{count}</span>
    </button>
  );
}

const THREAD_GROUP_LABEL_STYLE = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.07em',
  textTransform: 'uppercase',
  color: 'var(--proto-muted)',
  padding: '6px 6px',
} as const;

function ThreadGroupSection({ group, label, now }: { group: ThreadGroup; label: string; now: number }) {
  return (
    <section>
      <div style={THREAD_GROUP_LABEL_STYLE}>{label} · {group.threads.length}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {group.threads.map((thread) => <RightThreadCard key={thread.id} thread={thread} now={now} />)}
      </div>
    </section>
  );
}

function useRightPanelData(tab: Tab) {
  const trpc = useTRPC();
  const { currentProjectId } = useCurrentProject();
  const projectId = currentProjectId ?? undefined;
  const now = useRecentNow(tab === 'threads');
  useThreadsLiveSync();
  const costQuery = useQuery({ ...trpc.cost.summary.queryOptions({ projectId }), enabled: !!projectId });
  const threadsQuery = useQuery(trpc.threads.list.queryOptions({ projectId }));
  const tasksQuery = useQuery(trpc.tasks.list.queryOptions({ ...(projectId ? { projectId } : {}) }));
  const machines = useMachinesResource();
  const threadGroups = groupThreads(threadsQuery.data ?? []);
  return {
    projectId,
    now,
    threadGroups,
    threadsReady: threadsQuery.isSuccess,
    activeThreadCount: threadGroups.find((group) => group.kind === 'active')?.threads.length ?? 0,
    openTaskCount: tasksQuery.data ? actionableOpenCount(tasksQuery.data) : 0,
    machineCount: onlineMachineCount(machines.machines),
    budget: rightPanelBudget(costQuery.data?.today, costQuery.data?.dailyBudget),
  };
}

function RightTabs({ tab, counts, headerAction, onTabChange }: {
  tab: Tab;
  counts: PanelCounts;
  headerAction: ReactNode;
  onTabChange: (tab: Tab) => void;
}) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '10px 10px 8px', flex: 'none' }}>
      <div role="tablist" style={{ display: 'flex', alignItems: 'center', gap: 2, padding: 3, borderRadius: 'var(--r-control)', background: 'var(--proto-line-2)', flex: 1 }}>
        <TabButton label={L.threads} count={String(counts.threads)} countColor="var(--proto-accent)" active={tab === 'threads'} onClick={() => onTabChange('threads')} />
        <TabButton label={L.tasks} count={String(counts.tasks)} countColor="var(--proto-muted)" active={tab === 'tasks'} onClick={() => onTabChange('tasks')} />
        <TabButton label={L.machines} count={String(counts.machines)} countColor="var(--proto-muted)" active={tab === 'machines'} dot onClick={() => onTabChange('machines')} />
      </div>
      {headerAction}
    </div>
  );
}

function BudgetBar({ budget }: { budget: PanelBudget }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 18px 12px', flex: 'none' }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-muted)' }}>{L.today}</span>
      <div style={{ flex: 1, height: 5, borderRadius: 'var(--r-pill)', background: 'var(--proto-line-2)', overflow: 'hidden' }}>
        <div style={{ width: `${budget.percent}%`, height: '100%', borderRadius: 'var(--r-pill)', background: 'var(--proto-accent)' }} />
      </div>
      <span style={{ font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)' }}>{budget.todayLabel} / {budget.limitLabel}</span>
    </div>
  );
}

function ThreadsTab({ groups, ready, now }: { groups: ThreadGroup[]; ready: boolean; now: number }) {
  const L = useVocab();
  return (
    <div style={{ flex: 1, padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto', minHeight: 0 }}>
      {groups.map((group) => <ThreadGroupSection key={group.kind} group={group} label={group.kind === 'active' ? L.active : L.history} now={now} />)}
      {ready && groups.length === 0 && (
        <div style={{ textAlign: 'center', padding: '26px 12px', border: '1px dashed var(--proto-line)', borderRadius: 'var(--r-card)' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-muted)' }}>{L.rpNoActiveThreads}</div>
          <div style={{ fontSize: 11, color: 'var(--proto-muted)', marginTop: 4, lineHeight: 1.6 }}>{L.rpNoActiveThreadsHint}</div>
        </div>
      )}
    </div>
  );
}

function TasksTab({ projectId }: { projectId?: string }) {
  return (
    <div style={{ flex: 1, padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto', minHeight: 0 }}>
      <TasksPanel projectId={projectId} />
    </div>
  );
}

function RightWorkPanel({ data, tab, counts, headerAction, onTabChange }: {
  data: ReturnType<typeof useRightPanelData>;
  tab: Tab;
  counts: PanelCounts;
  headerAction: ReactNode;
  onTabChange: (tab: Tab) => void;
}) {
  return (
    // No background: the drawer sheet this fills IS the surface, and a tint on top of it would
    // only mute the glass.
    <div style={{ width: '100%', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <RightTabs tab={tab} counts={counts} headerAction={headerAction} onTabChange={onTabChange} />
      <BudgetBar budget={data.budget} />
      {tab === 'threads' && <ThreadsTab groups={data.threadGroups} ready={data.threadsReady} now={data.now} />}
      {tab === 'tasks' && <TasksTab projectId={data.projectId} />}
      {tab === 'machines' && <RightMachinesTab />}
    </div>
  );
}
