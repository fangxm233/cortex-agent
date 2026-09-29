// Framework-free mapping from the real threads.get DTO into presentation slots.

// Data-driven, not stage-name-string matched: the active step
// surfaces whatever children the DTO carries. Flagged gaps:
//   - crumb ancestor NAMES ride the drill trail (threads.get has no parent chain) → real, no new scope;
//   - artifact text is present only when the detail modal requests it explicitly.

import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadChildNode,
  ThreadInfo,
} from '@cortex-agent/ui-contract';
import { nodeLevel } from './nested-threads';
import {
  buildThreadDetailFacts,
  type ThreadDetailFacts,
  type ThreadDetailStepFacts,
} from './thread-detail-facts';
import { formatUsd } from '@/lib/format';
import { formatSpanPrecise, timeAgo, type TimeLang } from '@/lib/time-format';
import { pickVocab, type Lang, type Vocab } from '@/i18n';

export type DetailPillTone = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export interface DetailPill {
  bg: string;
  fg: string;
  text: string;
  /** Status bucket behind the pill — logic compares this, never the translated `text`. */
  tone: DetailPillTone;
}

function pillTone(status: ThreadInfo['status']): DetailPillTone {
  switch (status) {
    case 'running': return 'running';
    case 'waiting': return 'waiting';
    case 'completed': return 'done';
    case 'failed': return 'failed';
    default: return 'cancelled';
  }
}

const PILL_WORD: Record<DetailPillTone, keyof Vocab> = {
  running: 'pillRunning', waiting: 'pillWaiting', done: 'pillDone', failed: 'pillFailed', cancelled: 'pillCancelled',
};

/** Thread status → the prototype status-pill pair + word (prototype pill(), L1838–1849). */
export function threadPill(status: ThreadInfo['status'], lang: Lang = 'en'): DetailPill {
  const tone = pillTone(status);
  return {
    bg: `var(--pill-${tone}-bg)`, fg: `var(--pill-${tone}-fg)`, text: pickVocab(lang)[PILL_WORD[tone]], tone,
  };
}

// Feature-specific words for the step/artifact slots; the generic status words live in the vocab.
const DETAIL_COPY = {
  en: { step: 'step', done: 'done', editing: 'editing', queued: 'queued', local: 'local', agent: 'agent', running: 'running', gated: 'gated' },
  zh: { step: '步骤', done: '完成', editing: '编辑中', queued: '排队中', local: '本地', agent: 'agent', running: '运行中', gated: '待开始' },
} as const;
type DetailCopy = (typeof DETAIL_COPY)[Lang];

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

/** Collapsed step meta "39m · $2.10" (duration then cost); the stage is in the title. */
function stepMeta(item: ThreadDetailStepFacts, lang: TimeLang): string {
  const parts: string[] = [];
  if (item.durationSeconds != null) parts.push(formatSpanPrecise(Math.round(item.durationSeconds) * 1000, lang));
  if (item.step.costUsd != null) parts.push(formatUsd(item.step.costUsd));
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

function stepTitle(step: ThreadStepDetail, copy: DetailCopy): string {
  return `${step.stepIndex + 1} · ${step.stage ?? copy.step}`;
}

function mapSub(node: ThreadChildNode, lang: Lang): DetailStepSub {
  const pill = threadPill(node.status, lang);
  return {
    id: node.id,
    name: node.templateName ?? node.id,
    level: 'L' + nodeLevel(node),
    pill,
    hasLine: !!node.activeAgent,
    line: node.activeAgent ?? '',
    drillable: node.children.length > 0 || node.truncated,
  };
}

/** Per-step artifact write-trail chips (prototype `writtenBy`). Derived from step stage + status —
 *  the DTO has no per-step artifact-write record, so the running step is the active writer. */
function buildWrittenBy(steps: ThreadStepDetail[], copy: DetailCopy): WrittenByChip[] {
  return steps.map((s) => {
    const stage = s.stage ?? `${copy.step} ${s.stepIndex + 1}`;
    const word = s.status === 'completed' ? copy.done : s.status === 'running' ? copy.editing : copy.queued;
    return { label: `${s.stepIndex + 1} ${stage} · ${word}`, active: s.status === 'running' };
  });
}

function buildRunningAgent(
  item: ThreadDetailStepFacts,
  facts: ThreadDetailFacts,
  copy: DetailCopy,
): DetailStepAgent {
  const step = item.step;
  const execInfo = [step.executionId, copy.local].filter(Boolean).join(' · ');
  return {
    profile: facts.activeProfile ?? copy.agent, execInfo, live: facts.live,
  };
}

function mapStep(
  detail: ThreadDetail,
  item: ThreadDetailStepFacts,
  index: number,
  facts: ThreadDetailFacts,
  lang: TimeLang,
): DetailStep {
  const step = item.step;
  const running = item.kind === 'running';
  const copy = DETAIL_COPY[lang];
  const subs = running ? detail.children.map((node) => mapSub(node, lang)) : [];
  return {
    kind: item.kind, title: stepTitle(step, copy), note: step.outputSummary ?? '',
    meta: running ? stepMeta(item, lang) || copy.running : item.kind === 'done' ? stepMeta(item, lang) : copy.gated,
    hasConnector: index > 0, agent: running ? buildRunningAgent(item, facts, copy) : undefined,
    subs, subCount: subs.length,
    sessionId: step.sessionId, sessionName: step.sessionName,
    profile: running ? (facts.activeProfile ?? step.agentSlotId) : step.agentSlotId,
  };
}

function buildArtifact(detail: ThreadDetail, live: boolean, now: number, lang: TimeLang): DetailArtifact {
  return {
    path: detail.artifacts.artifactPath, live, updated: timeAgo(detail.updatedAt, now, lang),
    taskId: detail.artifacts.taskId, taskProject: detail.artifacts.taskProject,
    workspacePath: detail.artifacts.workspacePath, writtenBy: buildWrittenBy(detail.steps, DETAIL_COPY[lang]),
    content: detail.artifacts.content ?? null,
  };
}

export function buildThreadDetailVm(detail: ThreadDetail, now: number, lang: TimeLang): ThreadDetailVm {
  const facts = buildThreadDetailFacts(detail, now);
  const depthDots = Array.from(
    { length: facts.depth.limit }, (_, index) => ({ filled: index < facts.depth.level }),
  );
  return {
    name: detail.templateName, tid: detail.id, pill: threadPill(detail.status, lang),
    template: detail.templateName, started: fmtHM(detail.createdAt),
    elapsed: fmtClock(facts.elapsedSeconds), cost: `Σ ${formatUsd(detail.totalCostUsd)}`,
    task: detail.artifacts.taskId ?? '—', depthDots,
    depthText: `${facts.depth.level}/${facts.depth.limit}`, live: facts.live,
    steps: facts.steps.map((item, index) => mapStep(detail, item, index, facts, lang)),
    artifact: buildArtifact(detail, facts.live, now, lang),
  };
}
