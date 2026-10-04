import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { projectInitials } from '@/features/session/list/session-groups';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { MProjectView, type MProjectViewProps } from './MProjectView';
import type { UsageNavState } from './MUsageScreen';
import { pendingApprovalCounts } from './m-project-vm';
import { useProjectSwitchRows } from './useMProjectSwitch';
import { MNewProjectSheet, useNewProjectSheet, type NewProjectSheet } from './useMNewProjectSheet';
import { MobileRateLimitSheet, useRateLimitStatus } from '@/features/rate-limit';
import { useNotesResource } from '@/features/notes/useNotesResource';
import { buildMNotesVm } from './m-notes-vm';
import { useAllSessions } from '@/features/projects/useProjectSessions';
import { setProjectsPanel } from '@/mobile/mobile-navigation';

function useProjectQueries(projectId: string) {
  const trpc = useTRPC();
  return {
    projects: useQuery({ ...trpc.projects.list.queryOptions({}), refetchOnMount: false }).data ?? [],
    sessions: useAllSessions('direct').data ?? [],
    scopedCost: useQuery({ ...trpc.cost.summary.queryOptions({ projectId: projectId || undefined }), enabled: !!projectId }).data ?? null,
    globalCost: useQuery(trpc.cost.summary.queryOptions({})).data,
    approvals: useQuery(trpc.approvals.list.queryOptions({ status: 'pending' })).data ?? [],
    issues: useQuery({ ...trpc.issues.list.queryOptions({ projectId }), enabled: !!projectId }).data ?? [],
  };
}

function useCurrentCard(
  projectId: string,
  queries: ReturnType<typeof useProjectQueries>,
  scopedApprovals: number,
) {
  return useMemo(() => {
    if (!projectId) return null;
    return { id: projectId, initials: projectInitials(projectId), needsYou: scopedApprovals, cost: queries.scopedCost };
  }, [projectId, scopedApprovals, queries.scopedCost]);
}

function ProjectOverlays({ rate, rateOpen, closeRate, project }: { rate: ReturnType<typeof useRateLimitStatus>; rateOpen: boolean; closeRate: () => void; project: NewProjectSheet }) {
  return (
    <>
      {rateOpen && rate && <MobileRateLimitSheet status={rate} onClose={closeRate} />}
      <MNewProjectSheet project={project} />
    </>
  );
}

function useRateLimitSheet() {
  const rate = useRateLimitStatus();
  const [rateOpen, setRateOpen] = useState(false);
  useEffect(() => { if (!rate) setRateOpen(false); }, [rate]);
  return { rate, rateOpen, setRateOpen };
}

/** The Projects panel's content; the home screen hosting it keeps the session list live. */
export function MProjectScreen() {
  const navigate = useNavigate();
  const L = useVocab();
  const { currentProjectId, setCurrentProject } = useCurrentProject();
  const projectId = currentProjectId ?? '';
  const queries = useProjectQueries(projectId);
  const { notes, busy: notesBusy, add: addNote } = useNotesResource(projectId);
  const notesVm = useMemo(() => buildMNotesVm(notes, Date.now(), L), [notes, L]);
  // Project-attributed approval buckets: current project + 全局 (null) drive the amber bar and the
  // current card's 需要你; other projects' counts ride their switch-row badges.
  const approvalCounts = useMemo(() => pendingApprovalCounts(queries.approvals), [queries.approvals]);
  const scopedApprovals = projectId ? approvalCounts.byProject[projectId] ?? 0 : 0;
  const current = useCurrentCard(projectId, queries, scopedApprovals);
  const switchRows = useProjectSwitchRows(projectId, {
    projects: queries.projects, sessions: queries.sessions,
    globalByProject: queries.globalCost?.byProject, approvalsByProject: approvalCounts.byProject,
  });
  const { rate, rateOpen, setRateOpen } = useRateLimitSheet();
  const project = useNewProjectSheet(navigate, setCurrentProject);
  const issues = useMemo(() => ({ count: queries.issues.length, previews: queries.issues.slice(0, 2).map((issue) => issue.title) }), [queries.issues]);
  // Switching closes the panel onto the new project's sessions.
  const onSwitch = (id: string) => { setCurrentProject(id); setProjectsPanel(false, navigate); };
  const viewProps: MProjectViewProps = {
    current, pendingApprovals: scopedApprovals + approvalCounts.global, globalPendingApprovals: approvalCounts.global, issues,
    notesVm, notesBusy, switchRows, rateLimitStatus: rate,
    onOpenRateLimit: () => setRateOpen(true), onIssues: () => navigate('/m/issues'), onNotes: () => navigate('/m/notes'), onAddNote: addNote,
    onApprovals: () => navigate('/m/approvals'), onMemory: () => navigate('/m/memory'),
    onUsage: () => navigate('/m/settings/usage', { state: { from: 'project' } satisfies UsageNavState }), onSettings: () => navigate('/m/settings'), onSwitch, onNewProject: project.show,
  };
  return <><MProjectView {...viewProps} /><ProjectOverlays rate={rate} rateOpen={rateOpen} closeRate={() => setRateOpen(false)} project={project} /></>;
}
