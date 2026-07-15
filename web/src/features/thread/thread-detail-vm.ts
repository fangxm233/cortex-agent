// Pure view-model for the thread-detail view (design 11b), rebuilt 1:1 from prototype.dc.html
// L398–522 + its buildDetail() script (L2813–2944). Framework-free so the mapping from the real
// `threads.get` DTO (ThreadDetail, B1) → the prototype's exact `detail` model is unit-tested in
// isolation (TDD). The presentation (ThreadDetailView / ThreadPipeline / ThreadArtifactPanel) binds
// this VM into the design's exact inline-style structure.
//
// Data-driven, not stage-name-string matched (same discipline as thread-steps.ts): the active step
// surfaces whatever children the DTO carries. Flagged gaps (see features/thread/CORTEX.md):
//   - crumb ancestor NAMES ride the drill trail (threads.get has no parent chain) → real, no new scope;
//   - the AGENT feed is `agentFlow.lastOutput` only (no per-agent tool-call trace in the DTO — Stage 4);
//   - the artifact BODY (title/RESULT/METRICS) needs the file content → fs-read scope (Stage 6);
//     header refs + written-by (from steps) are real, `contentGap` flags the deferred body.

import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadChildNode,
  ThreadInfo,
} from '@cortex-agent/ui-contract';
import { dispatchesForStep } from './thread-steps';
import { nodeLevel, treeMaxLevel, MAX_LEVEL } from './nested-threads';

const RUNNING = new Set<ThreadInfo['status']>(['running', 'waiting']);

export interface DetailPill {
  bg: string;
  fg: string;
  text: string;
}

/** Thread status → the prototype status-pill pair + word (prototype pill(), L1838–1849). */
export function threadPill(status: ThreadInfo['status']): DetailPill {
  switch (status) {
    case 'running':
      return { bg: '#EEF0FA', fg: '#4655D4', text: 'Running' };
    case 'waiting':
      return { bg: '#F7ECCE', fg: '#8A5B06', text: 'Waiting' };
    case 'completed':
      return { bg: '#E9F4EE', fg: '#23854F', text: 'Done' };
    case 'failed':
      return { bg: '#FBEDEB', fg: '#C03D33', text: 'Failed' };
    default:
      return { bg: '#F1F2F5', fg: '#8A93A2', text: 'Cancelled' };
  }
}

/** Zero-padded MM:SS clock; minutes are not rolled into hours (prototype fmtClock). */
export function fmtClock(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(m)}:${pad(s)}`;
}

/** Local HH:MM of an ISO timestamp (prototype `started`). */
function fmtHM(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(durationS: number): string {
  const total = Math.round(durationS);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** Collapsed step meta "39m · $2.10" (duration then cost); the stage is in the title. */
function stepMeta(step: ThreadStepDetail): string {
  const parts: string[] = [];
  if (step.durationS != null) parts.push(formatDuration(step.durationS));
  if (step.costUsd != null) parts.push('$' + step.costUsd.toFixed(2));
  return parts.join(' · ');
}

export interface DetailCrumb {
  id: string | null;
  name: string;
  accent: boolean;
}

export interface DetailDepthDot {
  filled: boolean;
}

export interface DetailStepSub {
  id: string;
  name: string;
  level: string;
  pill: DetailPill;
  hasLine: boolean;
  line: string;
  isMax: boolean;
  /** Show the `open ›` drill link: the sub-thread has a subtree to re-root into (children/truncated).
   *  Decoupled from `hasLine` so a *terminal* sub-thread that still has children stays drillable (the
   *  task's ≤5-level 2b nesting). The prototype nests `open ›` inside `hasLine`, but that mirrors mock
   *  semantics where the only drillable sub was also the running one; with real data drillability is a
   *  property of the subtree, not the active agent. The proto-shot's childless leaf (check-claims) has
   *  no children → drillable false → no `open ›`, so the visual still matches. */
  drillable: boolean;
}

export interface DetailStepAgent {
  profile: string;
  execInfo: string;
  lastOutput: string | null;
  streaming: boolean;
  live: boolean;
}

export interface DetailStep {
  kind: 'done' | 'running' | 'pending';
  title: string;
  note: string;
  meta: string;
  hasConnector: boolean;
  agent?: DetailStepAgent;
  subs: DetailStepSub[];
  subCount: number;
  /** Zero-based step index (from the DTO), used as a stable selection key. */
  stepIndex: number;
  /** The agent session backing this step — its transcript (assistant markdown + tool calls) is the
   *  step's expandable chat. Null for a pending step that has not started (no session yet). */
  sessionId: string | null;
  /** Human session name (`cortex-XXXX`) for the step header; null when the session is unresolved. */
  sessionName: string | null;
  /** The agent profile/slot label shown in the expanded header. Falls back to the slot id. */
  profile: string | null;
}

export interface WrittenByChip {
  label: string;
  active: boolean;
}

export interface DetailArtifact {
  path: string | null;
  live: boolean;
  updated: string;
  taskId: string | null;
  taskProject: string | null;
  workspacePath: string | null;
  writtenBy: WrittenByChip[];
  /** true = the rich body (RESULT/METRICS/…) needs the fs-read scope (Stage 6) — refs shown instead. */
  contentGap: boolean;
}

export interface ThreadDetailVm {
  name: string;
  tid: string;
  pill: DetailPill;
  crumbs: DetailCrumb[];
  template: string;
  started: string;
  elapsed: string;
  cost: string;
  task: string;
  depthDots: DetailDepthDot[];
  depthText: string;
  live: boolean;
  steps: DetailStep[];
  artifact: DetailArtifact;
}

/** An ancestor breadcrumb entry carried through the drill-down trail (React Router location.state). */
export interface TrailCrumb {
  id: string;
  name: string;
}

function relativeAge(iso: string | null, now: number): string {
  if (!iso) return '';
  const diffS = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (diffS < 60) return 'just now';
  const m = Math.floor(diffS / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function stepTitle(step: ThreadStepDetail): string {
  return `${step.stepIndex + 1} · ${step.stage ?? 'step'}`;
}

function mapSub(node: ThreadChildNode): DetailStepSub {
  const pill = threadPill(node.status);
  return {
    id: node.id,
    name: node.templateName ?? node.id,
    level: 'L' + nodeLevel(node),
    pill,
    hasLine: !!node.activeAgent,
    line: node.activeAgent ?? '',
    isMax: nodeLevel(node) >= MAX_LEVEL || node.truncated,
    drillable: node.children.length > 0 || node.truncated,
  };
}

/** Per-step artifact write-trail chips (prototype `writtenBy`). Derived from step stage + status —
 *  the DTO has no per-step artifact-write record, so the running step is the active writer. */
function buildWrittenBy(steps: ThreadStepDetail[]): WrittenByChip[] {
  return steps.map((s) => {
    const stage = s.stage ?? `step ${s.stepIndex + 1}`;
    const word = s.status === 'completed' ? 'done' : s.status === 'running' ? 'editing' : 'queued';
    return { label: `${s.stepIndex + 1} ${stage} · ${word}`, active: s.status === 'running' };
  });
}

export function buildThreadDetailVm(
  detail: ThreadDetail,
  trail: TrailCrumb[],
  now: number,
): ThreadDetailVm {
  const live = RUNNING.has(detail.status);

  const crumbs: DetailCrumb[] = [
    { id: null, name: detail.projectId, accent: false },
    ...trail.map((t) => ({ id: t.id, name: t.name, accent: true })),
  ];

  const endMs = detail.endedAt ? Date.parse(detail.endedAt) : now;
  const elapsedS = Math.max(0, (endMs - Date.parse(detail.createdAt)) / 1000);

  const filledLevels = treeMaxLevel(detail.children);
  const depthDots: DetailDepthDot[] = Array.from({ length: MAX_LEVEL }, (_, i) => ({
    filled: i < filledLevels,
  }));

  const steps: DetailStep[] = detail.steps.map((step, i) => {
    const kind: DetailStep['kind'] =
      step.status === 'completed' ? 'done' : step.status === 'running' ? 'running' : 'pending';
    const running = kind === 'running';
    const dispatch = running ? dispatchesForStep(detail, step)[0] : undefined;
    const execInfo = running
      ? [step.executionId ?? dispatch?.executionId, dispatch?.machine ?? 'local']
          .filter(Boolean)
          .join(' · ')
      : '';
    const agent: DetailStepAgent | undefined = running
      ? {
          profile: detail.agentFlow?.profile ?? detail.activeAgent ?? 'agent',
          execInfo,
          lastOutput: detail.agentFlow?.lastOutput ?? step.outputSummary,
          streaming: true,
          live,
        }
      : undefined;
    const subs = running ? detail.children.map(mapSub) : [];
    const profile = running
      ? (detail.agentFlow?.profile ?? detail.activeAgent ?? step.agentSlotId)
      : step.agentSlotId;
    return {
      kind,
      title: stepTitle(step),
      note: step.outputSummary ?? '',
      meta: running ? stepMeta(step) || 'running' : kind === 'done' ? stepMeta(step) : 'gated',
      hasConnector: i > 0,
      agent,
      subs,
      subCount: subs.length,
      stepIndex: step.stepIndex,
      sessionId: step.sessionId,
      sessionName: step.sessionName,
      profile,
    };
  });

  const artifact: DetailArtifact = {
    path: detail.artifacts.artifactPath,
    live,
    updated: relativeAge(detail.updatedAt, now),
    taskId: detail.artifacts.taskId,
    taskProject: detail.artifacts.taskProject,
    workspacePath: detail.artifacts.workspacePath,
    writtenBy: buildWrittenBy(detail.steps),
    contentGap: true,
  };

  return {
    name: detail.templateName,
    tid: detail.id,
    pill: threadPill(detail.status),
    crumbs,
    template: detail.templateName,
    started: fmtHM(detail.createdAt),
    elapsed: fmtClock(elapsedS),
    cost: 'Σ $' + detail.totalCostUsd.toFixed(2),
    task: detail.artifacts.taskId ?? '—',
    depthDots,
    depthText: `${filledLevels}/${MAX_LEVEL}`,
    live,
    steps,
    artifact,
  };
}
