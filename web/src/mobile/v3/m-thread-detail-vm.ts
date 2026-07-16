// Pure view-model for the 1g 线程详情 screen (scheme-mobile.dc.html 1g L387-438). Maps the real
// `threads.get` DTO (ThreadDetail, B1) into the mobile drill-page model: breadcrumb + self depth,
// meta line, the vertical PIPELINE step list (collapsed done / expanded running agent-flow / faint
// pending), the 产物 refs, and the footer cost. Framework-free so the mapping is unit-tested in
// isolation (TDD), mirroring m-session-list-vm.
//
// REUSES the desktop thread logic (no new scope): `treeMaxLevel`/`MAX_LEVEL` (nested-threads) for the
// honest subtree depth, `dispatchesForStep` (thread-steps) to join a step to its machine dispatch.
//
// HONEST GAPS (per features/thread/CORTEX.md + the 1g task):
//   - ancestry crumb NAMES ride the drill trail (ThreadDetail has no parent chain) → real when carried,
//     omitted (just the template name + real subtree depth) when not — never fabricated;
//   - `selfLevel` (L{n}) = trail.length + 1 (known ancestry depth), null when no trail is carried;
//   - per-thread MACHINE has no direct DTO field → joined from the active step's dispatch (else omitted);
//   - artifact SIZE / +diff are scheme mocks (no DTO source) → only basename + rel-time are rendered.

import type { ThreadDetail, ThreadStepDetail, ThreadInfo } from '@cortex-agent/ui-contract';
import { dispatchesForStep } from '@/features/thread/thread-steps';
import { treeMaxLevel, MAX_LEVEL } from '@/features/thread/nested-threads';
import { relTimeZh } from '@/mobile/ui/format';

const RUNNING = new Set<ThreadInfo['status']>(['running', 'waiting']);

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
}

export interface MThreadArtifactVm {
  filename: string;
  meta: string;
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
  /** Real subtree depth `${treeMaxLevel}/${MAX_LEVEL}` rooted at this thread. */
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

/** The single machine backing this thread — joined from the active step's dispatch, else any dispatch. */
function threadMachine(detail: ThreadDetail, activeStep: ThreadStepDetail | undefined): string | null {
  if (activeStep) {
    const m = dispatchesForStep(detail, activeStep).map((d) => d.machine).find(Boolean);
    if (m) return m;
  }
  return detail.dispatches.map((d) => d.machine).find(Boolean) ?? null;
}

export function buildMThreadDetailVm(
  detail: ThreadDetail,
  trail: MThreadTrailCrumb[],
  now: number,
): MThreadDetailVm {
  const live = RUNNING.has(detail.status);

  const crumbs: MThreadCrumb[] = trail.map((t) => ({ name: t.name, accent: true }));
  const selfLevel = trail.length > 0 ? trail.length + 1 : null;
  const depthText = `${treeMaxLevel(detail.children)}/${MAX_LEVEL}`;

  const activeStep = detail.steps.find((s) => s.status === 'running');
  const machine = threadMachine(detail, activeStep);
  const metaParts = [
    detail.id,
    detail.activeAgent ? `agent ${detail.activeAgent}` : null,
    machine,
  ].filter((x): x is string => !!x);

  const endMs = detail.endedAt ? Date.parse(detail.endedAt) : now;
  const elapsed = fmtClock((endMs - Date.parse(detail.createdAt)) / 1000);

  const lastIndex = detail.steps.length - 1;
  const steps: MThreadStepVm[] = detail.steps.map((s, i) => {
    const kind: MThreadStepVm['kind'] =
      s.status === 'completed' ? 'done' : s.status === 'running' ? 'running' : 'pending';
    const running = kind === 'running';

    let time = '';
    if (running) {
      time = s.startedAt ? fmtClock((now - Date.parse(s.startedAt)) / 1000) : '';
    } else if (kind === 'done' && s.durationS != null) {
      time = fmtDuration(s.durationS);
    }

    let agent: MThreadStepAgent | undefined;
    if (running) {
      const profile = detail.agentFlow?.profile ?? detail.activeAgent ?? s.agentSlotId;
      const output = detail.agentFlow?.lastOutput ?? s.outputSummary ?? '';
      agent = {
        turnLabel: s.numTurns != null ? `turn ${s.numTurns} · ${profile}` : profile,
        cost: s.costUsd != null ? `$${s.costUsd.toFixed(2)}` : '',
        lines: output.split('\n').map((l) => l.trim()).filter(Boolean),
        live,
      };
    }

    return {
      kind,
      name: s.stage ?? `#${s.stepIndex + 1}`,
      note: kind === 'done' ? (s.outputSummary ?? '') : '',
      time,
      hasConnector: i < lastIndex,
      agent,
    };
  });

  const artifacts: MThreadArtifactVm[] = [];
  if (detail.artifacts.artifactPath) {
    artifacts.push({
      filename: basename(detail.artifacts.artifactPath),
      meta: relTimeZh(detail.updatedAt, now),
    });
  }

  return {
    name: detail.templateName,
    tid: detail.id,
    status: detail.status,
    live,
    crumbs,
    selfLevel,
    depthText,
    metaParts,
    elapsed,
    cost: `$${detail.totalCostUsd.toFixed(2)}`,
    steps,
    artifacts,
    artifactCount: artifacts.length,
  };
}
