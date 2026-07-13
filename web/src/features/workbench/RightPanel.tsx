import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { TasksPanel } from '@/features/tasks/TasksPanel';
import { RightThreadCard } from './RightThreadCard';
import { RightMachinesTab } from './RightMachinesTab';
import { actionableCount, formatCost } from './right-panel-vm';
import { threadScopeFilter, taskScopeFilter, type Scope } from './scope';
import { useThreadsLiveSync } from './useThreadsLiveSync';
import { useCurrentProject } from './CurrentProjectProvider';

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
        color: active ? '#191C22' : '#8A93A2',
        padding: '13px 0 11px',
        borderBottom: '2px solid ' + (active ? '#191C22' : 'transparent'),
        marginBottom: -1,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      {label}{' '}
      {dot && (
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4655D4', display: 'inline-block' }} />
      )}
      <span style={{ font: "500 10px 'IBM Plex Mono',monospace", color: countColor }}>{count}</span>
    </div>
  );
}

export function RightPanel(): JSX.Element {
  const trpc = useTRPC();
  const [tab, setTab] = useState<Tab>('threads');
  const [filter, setFilter] = useState<Scope>('active');

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
  const openTasksQuery = useQuery(trpc.tasks.list.queryOptions({ status: 'open', projectId }));
  const machinesQuery = useQuery(trpc.machines.list.queryOptions({}));
  const activeThreadCount = activeThreadsQuery.data?.length ?? 0;
  const actionable = openTasksQuery.data ? actionableCount(openTasksQuery.data) : 0;
  const machineCount = machinesQuery.data?.length ?? 0;

  // Threads list for the current Active/History filter (project-scoped).
  const threadsQuery = useQuery(trpc.threads.list.queryOptions({ status: threadScopeFilter(filter), projectId }));
  const threads = threadsQuery.data ?? [];
  const now = Date.now();

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
        background: '#FBFBFC',
        borderLeft: '1px solid #E7E9EE',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* tab bar */}
      <div style={{ display: 'flex', gap: 16, padding: '0 18px', borderBottom: '1px solid #E7E9EE', flex: 'none' }}>
        <TabButton
          label="Threads"
          count={String(activeThreadCount)}
          countColor="#4655D4"
          active={tab === 'threads'}
          onClick={() => setTab('threads')}
        />
        <TabButton
          label="Tasks"
          count={String(actionable)}
          countColor="#8A93A2"
          active={tab === 'tasks'}
          onClick={() => setTab('tasks')}
        />
        <TabButton
          label="Machines"
          count={String(machineCount)}
          countColor="#8A93A2"
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
          borderBottom: '1px solid #EFF1F5',
          flex: 'none',
        }}
      >
        <span style={{ fontSize: 10.5, fontWeight: 600, color: '#8A93A2' }}>Today</span>
        <div style={{ flex: 1, height: 4, borderRadius: 999, background: '#EFF1F5', overflow: 'hidden' }}>
          <div style={{ width: '0%', height: '100%', borderRadius: 999, background: '#4655D4' }} />
        </div>
        <span style={{ font: "500 10.5px 'IBM Plex Mono',monospace", color: '#191C22' }}>
          {todayLabel} / —
        </span>
      </div>

      {/* threads tab */}
      {tab === 'threads' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 16px 0', flex: 'none' }}>
            <div style={{ display: 'flex', background: '#EFF1F5', borderRadius: 7, padding: 2 }}>
              <span
                onClick={() => setFilter('active')}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: filter === 'active' ? '#191C22' : '#8A93A2',
                  background: filter === 'active' ? '#fff' : 'transparent',
                  borderRadius: 5,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  boxShadow: filter === 'active' ? '0 1px 2px rgba(16,24,40,.08)' : 'none',
                }}
              >
                Active {activeThreadCount}
              </span>
              <span
                onClick={() => setFilter('history')}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: filter === 'history' ? '#191C22' : '#8A93A2',
                  background: filter === 'history' ? '#fff' : 'transparent',
                  borderRadius: 5,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  boxShadow: filter === 'history' ? '0 1px 2px rgba(16,24,40,.08)' : 'none',
                }}
              >
                History
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
              <div style={{ textAlign: 'center', padding: '26px 12px', border: '1px dashed #E7E9EE', borderRadius: 10 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: '#8A93A2' }}>No active threads</div>
                <div style={{ fontSize: 10.5, color: '#B6BDC9', marginTop: 4, lineHeight: 1.6 }}>
                  Running and waiting threads will appear here.
                </div>
              </div>
            )}
            {threadsQuery.isSuccess && threads.length === 0 && filter === 'history' && (
              <div style={{ textAlign: 'center', fontSize: 11.5, color: '#B6BDC9', padding: '24px 0' }}>
                No finished threads yet.
              </div>
            )}
          </div>
        </>
      )}

      {/* tasks tab — REUSE the real tasks.list panel (features/tasks/TasksPanel) */}
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
          <TasksPanel lifecycle={taskScopeFilter(filter)} projectId={projectId} />
        </div>
      )}

      {/* machines tab — real machines.list (plan §12 A item 1, task 2a13) */}
      {tab === 'machines' && <RightMachinesTab />}
    </div>
  );
}
