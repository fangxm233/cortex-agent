// input:  project data, cost summary, threads, notes state
// output: collapsible desktop right pane with icon navigation
// pos:    Workbench right-side pane host
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { TasksPanel } from '@/features/tasks/TasksPanel';
import { actionableOpenCount } from '@/features/tasks/group-tasks';
import { RightThreadCard } from './RightThreadCard';
import { RightMachinesTab } from './RightMachinesTab';
import { onlineMachineCount, rightPanelBudget } from './right-panel-vm';
import { groupThreads, type ThreadGroup } from './scope';
import { useRecentNow } from './useRecentNow';
import { useThreadsLiveSync } from './useThreadsLiveSync';
import { useCurrentProject } from './CurrentProjectProvider';
import { useVocab } from '@/i18n';
import { NotesPane } from '@/features/notes/NotesPane';
import { useNotes } from '@/features/notes/NotesProvider';

// RIGHT PANEL — 1:1 from prototype.dc.html L1091–1276 (Stage-R RB sibling C, task 1e96). Exact inline
// styles / px / hex / font / weight / EN copy reproduced verbatim; real tRPC data (cost.summary /
// threads.list / threads.get / tasks.list) substituted into the design's structure. Replaces the
// f528 STUB behind the SAME export signature. Machines and the project-scoped daily budget use
// their live query data; Pause still has no mutate op and remains non-functional.

type Tab = 'threads' | 'tasks' | 'machines';
type PanelTarget = Tab | 'notes';
type PanelLabels = Record<PanelTarget, string>;

const PANEL_WIDTH = 400;
const PANEL_RAIL_WIDTH = 42;
const PANEL_COLLAPSED_KEY = 'cortex:right-panel-collapsed';

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

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  const path = direction === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6';
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

function PanelToggle({ expanded, label, onClick }: { expanded: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        border: '1px solid var(--proto-line)',
        borderRadius: 7,
        background: 'transparent',
        color: 'var(--proto-muted-2)',
        display: 'grid',
        placeItems: 'center',
        padding: 0,
        cursor: 'pointer',
        flex: 'none',
      }}
    >
      <ChevronIcon direction={expanded ? 'right' : 'left'} />
    </button>
  );
}

function PanelRailButton({ target, label, active, onClick }: {
  target: PanelTarget;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      style={{
        width: 30,
        height: 30,
        border: `1px solid ${active ? 'var(--proto-line)' : 'transparent'}`,
        borderRadius: 7,
        background: active ? 'var(--proto-card)' : 'transparent',
        boxShadow: active ? 'inset 2px 0 var(--proto-accent)' : 'none',
        color: active ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
        display: 'grid',
        placeItems: 'center',
        padding: 0,
        cursor: 'pointer',
      }}
    >
      <PanelIcon target={target} size={15} />
    </button>
  );
}

function RightPanelRail({ active, labels, navigationLabel, expandLabel, onExpand, onSelect }: {
  active: PanelTarget;
  labels: PanelLabels;
  navigationLabel: string;
  expandLabel: string;
  onExpand: () => void;
  onSelect: (target: PanelTarget) => void;
}) {
  const workTargets: Tab[] = ['threads', 'tasks', 'machines'];
  return (
    <nav aria-label={navigationLabel} style={{ width: PANEL_RAIL_WIDTH - 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '7px 0 8px' }}>
      <PanelToggle expanded={false} label={expandLabel} onClick={onExpand} />
      <div aria-hidden="true" style={{ width: 20, height: 1, background: 'var(--proto-line)', margin: '3px 0' }} />
      {workTargets.map((target) => <PanelRailButton key={target} target={target} label={labels[target]} active={active === target} onClick={() => onSelect(target)} />)}
      <div style={{ marginTop: 'auto' }}>
        <PanelRailButton target="notes" label={labels.notes} active={active === 'notes'} onClick={() => onSelect('notes')} />
      </div>
    </nav>
  );
}

function usePanelCollapsed(notesOpen: boolean) {
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(PANEL_COLLAPSED_KEY) === 'true');
  useEffect(() => {
    window.localStorage.setItem(PANEL_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);
  useEffect(() => {
    if (notesOpen) setCollapsed(false);
  }, [notesOpen]);
  return [collapsed, setCollapsed] as const;
}

export function RightPanel(): JSX.Element {
  const L = useVocab();
  const notes = useNotes();
  const [tab, setTab] = useState<Tab>('threads');
  const [collapsed, setCollapsed] = usePanelCollapsed(notes.isOpen);
  const active: PanelTarget = notes.isOpen ? 'notes' : tab;
  const labels: PanelLabels = { threads: L.threads, tasks: L.tasks, machines: L.machines, notes: notes.copy.title };
  const select = (target: PanelTarget) => {
    setCollapsed(false);
    if (target === 'notes') return notes.open();
    notes.close();
    setTab(target);
  };
  const collapseAction = <PanelToggle expanded label={L.rpCollapsePanel} onClick={() => setCollapsed(true)} />;
  return (
    <aside data-pane="right" data-collapsed={collapsed || undefined} style={{ width: collapsed ? PANEL_RAIL_WIDTH : PANEL_WIDTH, flex: 'none', background: 'var(--proto-rail)', borderLeft: '1px solid var(--proto-line)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      {collapsed && <RightPanelRail active={active} labels={labels} navigationLabel={L.rpPanelNavigation} expandLabel={L.rpExpandPanel} onExpand={() => setCollapsed(false)} onSelect={select} />}
      <div style={{ display: collapsed ? 'none' : 'flex', flex: 1, minHeight: 0, width: '100%' }}>
        {notes.isOpen
          ? <NotesPane headerIcon={<PanelIcon target="notes" />} headerAction={collapseAction} visible={!collapsed} />
          : <RightWorkPanel tab={tab} onTabChange={setTab} headerAction={collapseAction} />}
      </div>
    </aside>
  );
}

function TabButton({ target, label, count, countColor, active, dot, onClick }: {
  target: Tab;
  label: string;
  count: string;
  countColor: string;
  active: boolean;
  dot?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} style={{ fontFamily: 'inherit', fontSize: 12, fontWeight: active ? 600 : 500, color: active ? 'var(--proto-ink)' : 'var(--proto-muted-2)', padding: '13px 0 11px', border: 0, borderBottom: '2px solid ' + (active ? 'var(--proto-ink)' : 'transparent'), marginBottom: -1, background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <PanelIcon target={target} size={13} />
      {label}
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-accent)', display: 'inline-block' }} />}
      <span style={{ font: "500 10px 'IBM Plex Mono',monospace", color: countColor }}>{count}</span>
    </button>
  );
}

const THREAD_GROUP_LABEL_STYLE = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--proto-muted)',
  padding: '8px 2px 4px',
} as const;

function ThreadGroupSection({ group, label, now }: { group: ThreadGroup; label: string; now: number }) {
  return (
    <section>
      <div style={THREAD_GROUP_LABEL_STYLE}>{label} · {group.threads.length}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
  const machinesQuery = useQuery({ ...trpc.machines.list.queryOptions({}), refetchInterval: 10_000 });
  const threadGroups = groupThreads(threadsQuery.data ?? []);
  return {
    projectId,
    now,
    threadGroups,
    threadsReady: threadsQuery.isSuccess,
    activeThreadCount: threadGroups.find((group) => group.kind === 'active')?.threads.length ?? 0,
    openTaskCount: tasksQuery.data ? actionableOpenCount(tasksQuery.data) : 0,
    machineCount: onlineMachineCount(machinesQuery.data),
    budget: rightPanelBudget(costQuery.data?.today, costQuery.data?.dailyBudget),
  };
}

function RightTabs({ tab, counts, headerAction, onTabChange }: {
  tab: Tab;
  counts: Record<Tab, number>;
  headerAction: ReactNode;
  onTabChange: (tab: Tab) => void;
}) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '0 10px 0 18px', borderBottom: '1px solid var(--proto-line)', flex: 'none' }}>
      <TabButton target="threads" label={L.threads} count={String(counts.threads)} countColor="var(--proto-accent)" active={tab === 'threads'} onClick={() => onTabChange('threads')} />
      <TabButton target="tasks" label={L.tasks} count={String(counts.tasks)} countColor="var(--proto-muted-2)" active={tab === 'tasks'} onClick={() => onTabChange('tasks')} />
      <TabButton target="machines" label={L.machines} count={String(counts.machines)} countColor="var(--proto-muted-2)" active={tab === 'machines'} dot onClick={() => onTabChange('machines')} />
      <div style={{ marginLeft: 'auto' }}>{headerAction}</div>
    </div>
  );
}

function BudgetBar({ budget }: { budget: ReturnType<typeof rightPanelBudget> }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', borderBottom: '1px solid var(--proto-line-2)', flex: 'none' }}>
      <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--proto-muted-2)' }}>{L.today}</span>
      <div style={{ flex: 1, height: 4, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden' }}>
        <div style={{ width: `${budget.percent}%`, height: '100%', borderRadius: 999, background: 'var(--proto-accent)' }} />
      </div>
      <span style={{ font: "500 10.5px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)' }}>{budget.todayLabel} / {budget.limitLabel}</span>
    </div>
  );
}

function ThreadsTab({ groups, ready, now }: { groups: ThreadGroup[]; ready: boolean; now: number }) {
  const L = useVocab();
  return (
    <div style={{ flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto', minHeight: 0 }}>
      {groups.map((group) => <ThreadGroupSection key={group.kind} group={group} label={group.kind === 'active' ? L.active : L.history} now={now} />)}
      {ready && groups.length === 0 && (
        <div style={{ textAlign: 'center', padding: '26px 12px', border: '1px dashed var(--proto-line)', borderRadius: 10 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-muted-2)' }}>{L.rpNoActiveThreads}</div>
          <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', marginTop: 4, lineHeight: 1.6 }}>{L.rpNoActiveThreadsHint}</div>
        </div>
      )}
    </div>
  );
}

function TasksTab({ projectId }: { projectId?: string }) {
  return (
    <div style={{ flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto', minHeight: 0 }}>
      <TasksPanel projectId={projectId} />
    </div>
  );
}

function RightWorkPanel({ tab, headerAction, onTabChange }: { tab: Tab; headerAction: ReactNode; onTabChange: (tab: Tab) => void }) {
  const data = useRightPanelData(tab);
  const counts = { threads: data.activeThreadCount, tasks: data.openTaskCount, machines: data.machineCount };
  return (
    <div style={{ width: '100%', flex: 1, background: 'var(--proto-rail)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <RightTabs tab={tab} counts={counts} headerAction={headerAction} onTabChange={onTabChange} />
      <BudgetBar budget={data.budget} />
      {tab === 'threads' && <ThreadsTab groups={data.threadGroups} ready={data.threadsReady} now={data.now} />}
      {tab === 'tasks' && <TasksTab projectId={data.projectId} />}
      {tab === 'machines' && <RightMachinesTab />}
    </div>
  );
}
