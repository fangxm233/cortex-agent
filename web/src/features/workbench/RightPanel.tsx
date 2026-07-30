// input:  project data, recent thread scope, notes drawer state
// output: desktop right pane switching between work tabs and notes
// pos:    Workbench right-side pane host
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { TasksPanel } from '@/features/tasks/TasksPanel';
import { actionableOpenCount } from '@/features/tasks/group-tasks';
import { RightThreadCard } from './RightThreadCard';
import { RightMachinesTab } from './RightMachinesTab';
import { formatCost, onlineMachineCount } from './right-panel-vm';
import { recentTerminalThreads, threadScopeFilter, type Scope } from './scope';
import { useRecentNow } from './useRecentNow';
import { useThreadsLiveSync } from './useThreadsLiveSync';
import { useCurrentProject } from './CurrentProjectProvider';
import { useVocab } from '@/i18n';
import { NotesPane } from '@/features/notes/NotesPane';
import { useNotes } from '@/features/notes/NotesProvider';

// RIGHT PANEL — 1:1 from prototype.dc.html L1091–1276 (Stage-R RB sibling C, task 1e96). Exact inline
// styles / px / hex / font / weight / EN copy reproduced verbatim; real tRPC data (cost.summary /
// threads.list / threads.get / tasks.list) substituted into the design's structure. Replaces the
// f528 STUB behind the SAME export signature. Data gaps rendered structurally + flagged (see the
// completion note): Machines tab real (task 2a13); Pause has no mutate op (non-functional);
// the budget denominator has no scope (CostSummary carries `today` only — Stage 7 config surface).

type Tab = 'threads' | 'tasks' | 'machines';

function TabButton({
  label,
  count,
  countColor,
  active,
  dot,
  onClick,
}: {
  label: string;
  count: string;
  countColor: string;
  active: boolean;
  dot?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
        color: active ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
        padding: '13px 0 11px',
        borderBottom: '2px solid ' + (active ? 'var(--proto-ink)' : 'transparent'),
        marginBottom: -1,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      {label}{' '}
      {dot && (
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-accent)', display: 'inline-block' }} />
      )}
      <span style={{ font: "500 10px 'IBM Plex Mono',monospace", color: countColor }}>{count}</span>
    </div>
  );
}

export function RightPanel(): JSX.Element {
  const { isOpen } = useNotes();
  return isOpen ? <NotesPane /> : <RightWorkPanel />;
}

function RightWorkPanel(): JSX.Element {
  const L = useVocab();
  const trpc = useTRPC();
  const [tab, setTab] = useState<Tab>('threads');
  const [filter, setFilter] = useState<Scope>('active');
  const now = useRecentNow(tab === 'threads');

  useThreadsLiveSync();

  // Cost scoping follows the shared cross-pane current project (task 569c): switching the project in
  // the LeftRail switcher re-scopes this cost bar to the selected project.
  const { currentProjectId: activeProjectId } = useCurrentProject();

  const costQuery = useQuery({
    ...trpc.cost.summary.queryOptions({ projectId: activeProjectId ?? undefined }),
    enabled: !!activeProjectId,
  });

  // Tab counts + lists are scoped to the shared cross-pane current project (threads/tasks both accept
  // projectId) so the panel shows only THIS project's threads and tasks. Machines are cross-project.
  const projectId = activeProjectId ?? undefined;
  const activeThreadsQuery = useQuery(trpc.threads.list.queryOptions({ status: threadScopeFilter('active'), projectId }));
  // Same unfiltered query TasksPanel runs (identical input → react-query dedupes it, no extra
  // request), counted the same way, so the tab badge and the panel's chip can never disagree: both
  // are the open (not-done) count — in-progress dispatches, blocked, waiting-deps and pending
  // included. The former badge counted only strictly-claimable tasks and read as a second, smaller
  // truth beside the chip.
  const tasksQuery = useQuery(trpc.tasks.list.queryOptions({ ...(projectId ? { projectId } : {}) }));
  const machinesQuery = useQuery(trpc.machines.list.queryOptions({}));
  const activeThreadCount = activeThreadsQuery.data?.length ?? 0;
  const openTaskCount = tasksQuery.data ? actionableOpenCount(tasksQuery.data) : 0;
  // Machines tab badge = ONLINE machines, not the total in the registry (task: show online count).
  const machineCount = onlineMachineCount(machinesQuery.data);

  // Recent reuses the terminal query and applies its 24-hour window client-side.
  const threadsQuery = useQuery(trpc.threads.list.queryOptions({ status: threadScopeFilter(filter), projectId }));
  const listedThreads = threadsQuery.data ?? [];
  const threads = filter === 'recent' ? recentTerminalThreads(listedThreads, now) : listedThreads;

  const todayCost = costQuery.data?.today;
  // GAP-B: no budget scope in the contract (CostSummary has `today`, no limit). Denominator + bar
  // fill have no real source → rendered as unknown ("—", empty bar). Today is real.
  const todayLabel = typeof todayCost === 'number' ? formatCost(todayCost) : '—';

  return (
    <div
      data-pane="right"
      style={{
        width: 400,
        flex: 'none',
        background: 'var(--proto-rail)',
        borderLeft: '1px solid var(--proto-line)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* tab bar */}
      <div style={{ display: 'flex', gap: 16, padding: '0 18px', borderBottom: '1px solid var(--proto-line)', flex: 'none' }}>
        <TabButton
          label={L.threads}
          count={String(activeThreadCount)}
          countColor="var(--proto-accent)"
          active={tab === 'threads'}
          onClick={() => setTab('threads')}
        />
        <TabButton
          label={L.tasks}
          count={String(openTaskCount)}
          countColor="var(--proto-muted-2)"
          active={tab === 'tasks'}
          onClick={() => setTab('tasks')}
        />
        <TabButton
          label={L.machines}
          count={String(machineCount)}
          countColor="var(--proto-muted-2)"
          active={tab === 'machines'}
          dot
          onClick={() => setTab('machines')}
        />
      </div>

      {/* cost / budget bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 18px',
          borderBottom: '1px solid var(--proto-line-2)',
          flex: 'none',
        }}
      >
        <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--proto-muted-2)' }}>{L.today}</span>
        <div style={{ flex: 1, height: 4, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden' }}>
          <div style={{ width: '0%', height: '100%', borderRadius: 999, background: 'var(--proto-accent)' }} />
        </div>
        <span style={{ font: "500 10.5px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)' }}>
          {todayLabel} / —
        </span>
      </div>

      {/* threads tab */}
      {tab === 'threads' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 16px 0', flex: 'none' }}>
            <div style={{ display: 'flex', background: 'var(--proto-line-2)', borderRadius: 7, padding: 2 }}>
              <span
                onClick={() => setFilter('active')}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: filter === 'active' ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
                  background: filter === 'active' ? 'var(--proto-card)' : 'transparent',
                  borderRadius: 5,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  boxShadow: filter === 'active' ? '0 1px 2px rgba(16,24,40,.08)' : 'none',
                }}
              >
                {L.active} {activeThreadCount}
              </span>
              <span
                onClick={() => setFilter('recent')}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: filter === 'recent' ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
                  background: filter === 'recent' ? 'var(--proto-card)' : 'transparent',
                  borderRadius: 5,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  boxShadow: filter === 'recent' ? '0 1px 2px rgba(16,24,40,.08)' : 'none',
                }}
              >
                {L.recentDay}
              </span>
              <span
                onClick={() => setFilter('history')}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: filter === 'history' ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
                  background: filter === 'history' ? 'var(--proto-card)' : 'transparent',
                  borderRadius: 5,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  boxShadow: filter === 'history' ? '0 1px 2px rgba(16,24,40,.08)' : 'none',
                }}
              >
                {L.history}
              </span>
            </div>
          </div>
          <div
            style={{
              flex: 1,
              padding: '12px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              overflow: 'auto',
              minHeight: 0,
            }}
          >
            {threads.map((t) => (
              <RightThreadCard key={t.id} thread={t} now={now} />
            ))}
            {threadsQuery.isSuccess && threads.length === 0 && filter === 'active' && (
              <div style={{ textAlign: 'center', padding: '26px 12px', border: '1px dashed var(--proto-line)', borderRadius: 10 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-muted-2)' }}>{L.rpNoActiveThreads}</div>
                <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', marginTop: 4, lineHeight: 1.6 }}>
                  {L.rpNoActiveThreadsHint}
                </div>
              </div>
            )}
            {threadsQuery.isSuccess && threads.length === 0 && filter === 'recent' && (
              <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--proto-faint)', padding: '24px 0' }}>
                {L.rpNoRecentThreads}
              </div>
            )}
            {threadsQuery.isSuccess && threads.length === 0 && filter === 'history' && (
              <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--proto-faint)', padding: '24px 0' }}>
                {L.rpNoFinishedThreads}
              </div>
            )}
          </div>
        </>
      )}

      {/* tasks tab — design 4a: lifecycle groups with built-in Actionable/All filter */}
      {tab === 'tasks' && (
        <div
          style={{
            flex: 1,
            padding: '12px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            overflow: 'auto',
            minHeight: 0,
          }}
        >
          <TasksPanel projectId={projectId} />
        </div>
      )}

      {/* machines tab — real machines.list (plan §12 A item 1, task 2a13) */}
      {tab === 'machines' && <RightMachinesTab />}
    </div>
  );
}
