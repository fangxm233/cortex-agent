// input:  ThreadDetail DTO, canonical detail facts, breadcrumb trail, and mobile formatters
// output: mobile copy, crumb, artifact, agent-feed, and pipeline projection
// pos:    Mobile-only projection over shared thread detail semantics
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Maps the real ThreadDetail into the mobile breadcrumb, pipeline, artifact, and footer model.
//
// Shared facts own lifecycle, timing, active agent/output precedence, dispatch joins, and tree depth.
// Mobile keeps its own breadcrumb names, localized artifact age, copy, and final slot shapes.
//
// HONEST GAPS (per features/thread/CORTEX.md + the 1g task):
//   - ancestry crumb NAMES ride the drill trail (ThreadDetail has no parent chain) → real when carried,
//     omitted (just the template name + real subtree depth) when not — never fabricated;
//   - `selfLevel` (L{n}) = trail.length + 1 (known ancestry depth), null when no trail is carried;
//   - per-thread MACHINE has no direct DTO field → shared facts join the active dispatch (else any);
//   - artifact SIZE / +diff are scheme mocks (no DTO source) → only basename + rel-time are rendered.

import type { ThreadDetail, ThreadInfo } from '@cortex-agent/ui-contract';
import {
  buildThreadDetailFacts,
  type ThreadDetailFacts,
  type ThreadDetailStepFacts,
} from '@/features/thread/thread-detail-facts';
import { relTimeZh } from '@/mobile/ui/format';
import { formatUsd } from '@/lib/format';

/** An ancestor breadcrumb entry carried through the drill-down trail (React Router location.state). */
export interface MThreadTrailCrumb {
  id: string;
  name: string;
}

export interface MThreadCrumb {
  name: string;
  accent: boolean;
}

export interface MThreadStepAgent {
  /** `turn N · profile` (turn only when the step carries a turn count), else just the profile. */
  turnLabel: string;
  /** `$0.09` step cost, or '' when the DTO has none. */
  cost: string;
  /** agent-flow lastOutput split into non-empty lines (mono feed box). */
  lines: string[];
  /** Raw agent-flow lastOutput text for markdown rendering. */
  text: string;
  /** true while the backing thread is still running (drives the pulsing feed dot). */
  live: boolean;
}

export interface MThreadStepVm {
  kind: 'done' | 'running' | 'pending';
  /** Stage label from the DTO; falls back to `#N` when the stage is unnamed (honest, no invention). */
  name: string;
  /** Collapsed detail note for a completed step (real outputSummary); '' otherwise. */
  note: string;
  /** Right-side time cell: done → compact duration; running → live MM:SS; pending → '' (view shows 待). */
  time: string;
  /** The vertical connector below the dot — drawn for every step except the last. */
  hasConnector: boolean;
  /** Present only on the running step (its expanded agent-flow box). */
  agent?: MThreadStepAgent;
  /** The agent session backing this step — its transcript is the expandable chat content.
   *  Null for pending steps that have not started yet (no session). */
  sessionId: string | null;
}

export interface MThreadArtifactVm {
  filename: string;
  meta: string;
  /** Workspace-relative path for the file download API (`workspace/threads/<id>/artifact.md`). */
  wsRelPath: string;
}

export interface MThreadDetailVm {
  name: string;
  tid: string;
  status: ThreadInfo['status'];
  live: boolean;
  /** Ancestor crumbs (accent), self is rendered separately from `name`. */
  crumbs: MThreadCrumb[];
  /** Self level L{n} = trail.length + 1; null when no ancestry is carried (honest). */
  selfLevel: number | null;
  /** Real subtree depth `${level}/${limit}` from the canonical detail facts. */
  depthText: string;
  /** Meta line chunks: [tid, `agent X`?, machine?] — nulls dropped. */
  metaParts: string[];
  /** Elapsed MM:SS clock (clamped to endedAt for a terminal thread). */
  elapsed: string;
  /** `$0.41` total cost (view prefixes Σ). */
  cost: string;
  steps: MThreadStepVm[];
  artifacts: MThreadArtifactVm[];
  artifactCount: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** MM:SS clock; minutes are NOT rolled into hours (matches thread-detail-vm fmtClock). */
function fmtClock(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** Compact duration `2m` / `45s` / `1m 5s` (matches thread-steps formatDuration). */
function fmtDuration(durationS: number): string {
  const total = Math.round(durationS);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function mobileStepTime(item: ThreadDetailStepFacts): string {
  if (item.kind === 'running') {
    return item.elapsedSeconds == null ? '' : fmtClock(item.elapsedSeconds);
  }
  const duration = item.durationSeconds;
  return item.kind === 'done' && duration != null ? fmtDuration(duration) : '';
}

function mobileStepAgent(
  item: ThreadDetailStepFacts,
  facts: ThreadDetailFacts,
): MThreadStepAgent | undefined {
  if (item.kind !== 'running') return undefined;
  const profile = facts.activeProfile ?? item.step.agentSlotId;
  const output = facts.activeOutput ?? '';
  return {
    turnLabel: item.step.numTurns != null ? `turn ${item.step.numTurns} · ${profile}` : profile,
    cost: item.step.costUsd != null ? formatUsd(item.step.costUsd) : '',
    lines: output.split('\n').map((line) => line.trim()).filter(Boolean),
    text: output, live: facts.live,
  };
}

function mobileStep(
  item: ThreadDetailStepFacts,
  index: number,
  lastIndex: number,
  facts: ThreadDetailFacts,
): MThreadStepVm {
  const step = item.step;
  return {
    kind: item.kind, name: step.stage ?? `#${step.stepIndex + 1}`,
    note: item.kind === 'done' ? (step.outputSummary ?? '') : '',
    time: mobileStepTime(item), hasConnector: index < lastIndex,
    agent: mobileStepAgent(item, facts), sessionId: step.sessionId ?? null,
  };
}

function mobileArtifacts(detail: ThreadDetail, now: number): MThreadArtifactVm[] {
  const path = detail.artifacts.artifactPath;
  if (!path) return [];
  const filename = basename(path);
  return [{
    filename, meta: relTimeZh(detail.updatedAt, now),
    wsRelPath: `workspace/threads/${detail.id}/${filename}`,
  }];
}

function mobileMetaParts(detail: ThreadDetail, machine: string | null): string[] {
  return [
    detail.id, detail.activeAgent ? `agent ${detail.activeAgent}` : null, machine,
  ].filter((part): part is string => !!part);
}

export function buildMThreadDetailVm(
  detail: ThreadDetail,
  trail: MThreadTrailCrumb[],
  now: number,
): MThreadDetailVm {
  const facts = buildThreadDetailFacts(detail, now);
  const artifacts = mobileArtifacts(detail, now);
  return {
    name: detail.templateName, tid: detail.id, status: detail.status, live: facts.live,
    crumbs: trail.map((item) => ({ name: item.name, accent: true })),
    selfLevel: trail.length > 0 ? trail.length + 1 : null,
    depthText: `${facts.depth.level}/${facts.depth.limit}`,
    metaParts: mobileMetaParts(detail, facts.machine),
    elapsed: fmtClock(facts.elapsedSeconds), cost: formatUsd(detail.totalCostUsd),
    steps: facts.steps.map((item, index) => mobileStep(item, index, facts.steps.length - 1, facts)),
    artifacts, artifactCount: artifacts.length,
  };
}
