import { useMemo } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExecutionInfo, IssueInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useProjectSessions } from '@/features/projects/useProjectSessions';
import { useWorkerQuestions } from '@/features/team/useWorkerQuestions';
import { deriveMemoryTreeFacts } from '@/features/memory/memory-tree';
import { useVocab } from '@/i18n';
import { groupSessions, pendingDecisionRows, recentMemoryFiles } from './overview-vm';

// Everything the project Overview reads, scoped to one project. The view renders; this hook owns
// the queries, so the page stays testable without a tRPC client and every query key lives here.
//
// The session lists are the rail's own queries (useProjectSessions selects the project out of the
// shared sessions.list cache), so Needs you / In progress read the same snapshot the rail's dots do
// and stay live through the rail's session.status subscription — no second one is opened here.

/** How many recent runs the page lists. */
const RECENT_RUNS = 6;

export function useOverviewData(projectId: string | null) {
  const trpc = useTRPC();
  const L = useVocab();
  const queryClient = useQueryClient();
  const enabled = !!projectId;

  const cost = useQuery({
    ...trpc.cost.summary.queryOptions({ projectId: projectId ?? undefined }),
    enabled,
  }).data;

  const schedulesQuery = useQuery({
    ...trpc.schedules.list.queryOptions({ projectId: projectId ?? undefined }),
    enabled,
  });
  const schedules = useMemo(() => schedulesQuery.data ?? [], [schedulesQuery.data]);

  // executions.list has no projectId filter → fetch recent and filter client-side by project.
  const executionsQuery = useQuery(trpc.executions.list.queryOptions({ limit: 50 }));
  const executions = useMemo<ExecutionInfo[]>(() => {
    const all = executionsQuery.data ?? [];
    const scoped = projectId ? all.filter((e) => e.projectId === projectId) : all;
    return scoped.slice(0, RECENT_RUNS);
  }, [executionsQuery.data, projectId]);

  // Issues (design sec-24 24a): per-project ISSUES.md entries; the section hides at 0.
  const issuesQuery = useQuery({
    ...trpc.issues.list.queryOptions({ projectId: projectId ?? '' }),
    enabled,
  });
  const issues = useMemo<IssueInfo[]>(() => issuesQuery.data ?? [], [issuesQuery.data]);

  const direct = useProjectSessions(projectId, 'direct').data;
  const scheduled = useProjectSessions(projectId, 'scheduled').data;
  const sessions = useMemo<SessionInfo[]>(
    () => (projectId ? [...(direct ?? []), ...(scheduled ?? [])] : []),
    [projectId, direct, scheduled],
  );
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  const groups = useMemo(() => groupSessions(sessions, L), [sessions, L]);
  // The question each blocked session is asking — one pendingInteraction query per such session,
  // the same lookup the team roster and the board strip make.
  const askingSessions = useMemo(() => {
    const ids = new Set(groups.needsYou.map((r) => r.sessionId));
    return sessions.filter((s) => ids.has(s.sessionId));
  }, [sessions, groups.needsYou]);
  const questions = useWorkerQuestions(askingSessions);

  // Unanswered decisions on the project's boards: boards.list, then one boards.decisions per board
  // (the same queries the board surfaces read, so the board live sync keeps them current).
  const boardsQuery = useQuery({
    ...trpc.boards.list.queryOptions({ projectId: projectId ?? undefined }),
    enabled,
  });
  const boards = useMemo(() => boardsQuery.data ?? [], [boardsQuery.data]);
  const decisionResults = useQueries({
    queries: boards.map((b) => trpc.boards.decisions.queryOptions({ boardId: b.id })),
  });
  const decisions = pendingDecisionRows(boards, decisionResults.map((r) => r.data));

  // The memory tree the memory viewer reads; only its modification times are used here.
  const treeQuery = useQuery({
    ...trpc.memory.tree.queryOptions({ projectId: projectId ?? '' }),
    enabled,
  });
  const memoryFiles = useMemo(
    () => recentMemoryFiles(deriveMemoryTreeFacts(treeQuery.data)),
    [treeQuery.data],
  );

  const resume = useMutation(
    trpc.schedules.resume.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.schedules.list.queryFilter());
      },
    }),
  );
  const remove = useMutation(
    trpc.schedules.remove.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.schedules.list.queryFilter());
      },
    }),
  );

  return {
    cost,
    schedules,
    executions,
    issues,
    sessionsById,
    needsYou: groups.needsYou,
    inProgress: groups.inProgress,
    questions,
    decisions,
    memoryFiles,
    resumeSchedule: resume,
    removeSchedule: remove,
  };
}

export type OverviewData = ReturnType<typeof useOverviewData>;
