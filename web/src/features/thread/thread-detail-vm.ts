// input:  ThreadDetail DTO, ancestor trail, wall-clock time, and shared USD formatting
// output: desktop thread modal view model
// pos:    Derives pipeline, metadata, and artifact display slots
// >>> If I am updated, update my header comment and CORTEX.md <<<

// Framework-free mapping from the real threads.get DTO into presentation slots.

// Data-driven, not stage-name-string matched (same discipline as thread-steps.ts): the active step
// surfaces whatever children the DTO carries. Flagged gaps (see features/thread/CORTEX.md):
//   - crumb ancestor NAMES ride the drill trail (threads.get has no parent chain) → real, no new scope;
//   - the AGENT feed is `agentFlow.lastOutput` only (no per-agent tool-call trace in the DTO — Stage 4);
//   - artifact text is present only when the detail modal requests it explicitly.

import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadChildNode,
  ThreadInfo,
} from '@cortex-agent/ui-contract';
import { dispatchesForStep } from './thread-steps';
import { nodeLevel, treeMaxLevel, MAX_LEVEL } from './nested-threads';
import { formatUsd } from '@/lib/format';

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
      return { bg: 'var(--pill-running-bg)', fg: 'var(--pill-running-fg)', text: 'Running' };
    case 'waiting':
      return { bg: 'var(--pill-waiting-bg)', fg: 'var(--pill-waiting-fg)', text: 'Waiting' };
    case 'completed':
      return { bg: 'var(--pill-done-bg)', fg: 'var(--pill-done-fg)', text: 'Done' };
    case 'failed':
      return { bg: 'var(--pill-failed-bg)', fg: 'var(--pill-failed-fg)', text: 'Failed' };
    default:
      return { bg: 'var(--pill-cancelled-bg)', fg: 'var(--pill-cancelled-fg)', text: 'Cancelled' };
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
  if (step.costUsd != null) parts.push(formatUsd(step.costUsd));
  return parts.join(' · ');
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
  content: string | null;
}

export interface ThreadDetailVm {
  name: string;
  tid: string;
  pill: DetailPill;
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

function detailStepKind(step: ThreadStepDetail): DetailStep['kind'] {
  if (step.status === 'completed') return 'done';
  if (step.status === 'running') return 'running';
  return 'pending';
}

function buildRunningAgent(detail: ThreadDetail, step: ThreadStepDetail, live: boolean): DetailStepAgent {
  const dispatch = dispatchesForStep(detail, step)[0];
  const execInfo = [step.executionId ?? dispatch?.executionId, dispatch?.machine ?? 'local']
    .filter(Boolean)
    .join(' · ');
  return {
    profile: detail.agentFlow?.profile ?? detail.activeAgent ?? 'agent',
    execInfo,
    lastOutput: detail.agentFlow?.lastOutput ?? step.outputSummary,
    streaming: true,
    live,
  };
}

function mapStep(detail: ThreadDetail, step: ThreadStepDetail, index: number, live: boolean): DetailStep {
  const kind = detailStepKind(step);
  const running = kind === 'running';
  const subs = running ? detail.children.map(mapSub) : [];
  return {
    kind, title: stepTitle(step), note: step.outputSummary ?? '',
    meta: running ? stepMeta(step) || 'running' : kind === 'done' ? stepMeta(step) : 'gated',
    hasConnector: index > 0,
    agent: running ? buildRunningAgent(detail, step, live) : undefined,
    subs, subCount: subs.length, stepIndex: step.stepIndex,
    sessionId: step.sessionId, sessionName: step.sessionName,
    profile: running
      ? (detail.agentFlow?.profile ?? detail.activeAgent ?? step.agentSlotId)
      : step.agentSlotId,
  };
}

function buildArtifact(detail: ThreadDetail, live: boolean, now: number): DetailArtifact {
  return {
    path: detail.artifacts.artifactPath, live, updated: relativeAge(detail.updatedAt, now),
    taskId: detail.artifacts.taskId, taskProject: detail.artifacts.taskProject,
    workspacePath: detail.artifacts.workspacePath, writtenBy: buildWrittenBy(detail.steps),
    content: detail.artifacts.content ?? null,
  };
}

export function buildThreadDetailVm(detail: ThreadDetail, now: number): ThreadDetailVm {
  const live = RUNNING.has(detail.status);
  const endMs = detail.endedAt ? Date.parse(detail.endedAt) : now;
  const elapsedS = Math.max(0, (endMs - Date.parse(detail.createdAt)) / 1000);
  const filledLevels = treeMaxLevel(detail.children);
  const depthDots = Array.from({ length: MAX_LEVEL }, (_, i) => ({ filled: i < filledLevels }));
  return {
    name: detail.templateName, tid: detail.id, pill: threadPill(detail.status),
    template: detail.templateName, started: fmtHM(detail.createdAt), elapsed: fmtClock(elapsedS),
    cost: `Σ ${formatUsd(detail.totalCostUsd)}`, task: detail.artifacts.taskId ?? '—',
    depthDots, depthText: `${filledLevels}/${MAX_LEVEL}`, live,
    steps: detail.steps.map((step, index) => mapStep(detail, step, index, live)),
    artifact: buildArtifact(detail, live, now),
  };
}
