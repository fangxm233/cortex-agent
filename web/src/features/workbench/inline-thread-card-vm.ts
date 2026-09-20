// Pure mapper: ThreadDetail (threads.get, B1) → the inline-thread-card row model
// (prototype.dc.html L180–246). Frame-work-free so it is unit-tested in isolation (TDD). The card
// is the ONE live-data surface in the center chat; it renders whatever the real DTO carries
// (data-driven, not stage-name-string matched).

import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadChildNode,
} from '@cortex-agent/ui-contract';
import { formatDurationShort, formatUsd } from '@/lib/format';
import { threadPill, type Pill } from './right-panel-vm';

export interface ThreadCardNested {
  name: string;
  level: string;
  running: boolean;
  meta: string;
}

export interface ThreadCardSub {
  name: string;
  level: string;
  chev: string;
  border: string;
  bg: string;
  iconColor: string;
  nameColor: string;
  pillBg: string;
  pillColor: string;
  pillText: string;
  hasLine: boolean;
  line: string;
  meta: string;
  nested: ThreadCardNested | null;
}

export interface ThreadCardRow {
  node: 'done' | 'running' | 'pending';
  hasTail: boolean;
  padB: string;
  name: string;
  fw: number;
  color: string;
  sub: string;
  subColor: string;
  meta: string;
  metaColor: string;
  chev: boolean;
  expanded: boolean;
  subs: ThreadCardSub[];
}

export interface ThreadCardVm {
  id: string;
  name: string;
  pill: Pill;
  pillText: string;
  meta: string;
  rows: ThreadCardRow[];
}

/** display level: root children = L2, grandchildren = L3 (prototype uses L2/L3). */
function childLevel(depth: number): string {
  return 'L' + (depth + 2);
}

/** collapsed step meta: "3m · $0.04" from real duration/cost (both optional). */
function stepMeta(step: ThreadStepDetail): string {
  const parts: string[] = [];
  if (step.durationS != null) parts.push(formatDurationShort(step.durationS));
  if (step.costUsd != null) parts.push(formatUsd(step.costUsd));
  return parts.join(' · ');
}

function mapNested(node: ThreadChildNode): ThreadCardNested | null {
  const first = node.children[0];
  if (!first) return null;
  return {
    name: first.templateName ?? first.id,
    level: childLevel(first.depth),
    running: first.status === 'running',
    meta: first.status === 'running' ? 'running' : 'done',
  };
}

function mapSub(node: ThreadChildNode): ThreadCardSub {
  const running = node.status === 'running';
  const pill = threadPill(node.status);
  const nested = mapNested(node);
  return {
    name: node.templateName ?? node.id,
    level: childLevel(node.depth),
    chev: running ? '▾' : '▸',
    border: running ? 'var(--proto-line-4)' : 'var(--proto-line-2)',
    bg: running ? 'var(--proto-alt)' : 'var(--proto-rail)',
    iconColor: running ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
    nameColor: running ? 'var(--proto-ink)' : 'var(--proto-muted)',
    pillBg: pill.bg,
    pillColor: pill.fg,
    pillText: running ? 'Running' : pill.text,
    hasLine: nested != null,
    line: node.activeAgent ?? '',
    meta: node.costUsd ? formatUsd(node.costUsd) : '',
    nested,
  };
}

/**
 * Build the prototype card model from a live ThreadDetail. Each step → a vertical row; only the
 * running (active) step expands its children (subthreads). Completed rows collapse to one line with
 * a chevron; pending rows show the empty ring node.
 */
export function buildThreadCard(detail: ThreadDetail): ThreadCardVm {
  const steps = detail.steps;
  const rows: ThreadCardRow[] = steps.map((step, i) => {
    const node: ThreadCardRow['node'] =
      step.status === 'completed' ? 'done' : step.status === 'running' ? 'running' : 'pending';
    const running = node === 'running';
    const done = node === 'done';
    const subs = running ? detail.children.map(mapSub) : [];
    const hasTail = i < steps.length - 1;
    return {
      node,
      hasTail,
      padB: hasTail ? '8px' : '2px',
      name: step.stage ?? `Step ${step.stepIndex + 1}`,
      fw: running ? 600 : 500,
      color: running ? 'var(--proto-ink)' : done ? 'var(--proto-muted)' : 'var(--proto-faint)',
      sub: running ? (detail.activeStage ?? '') : (step.outputSummary ?? ''),
      subColor: running ? 'var(--proto-muted-3)' : 'var(--proto-faint)',
      meta: running ? stepMeta(step) || 'running' : done ? stepMeta(step) : 'gated',
      metaColor: running ? 'var(--proto-accent)' : done ? 'var(--proto-faint)' : 'var(--proto-disabled)',
      chev: done,
      expanded: running,
      subs,
    };
  });

  const pill = threadPill(detail.status);
  const pillText =
    detail.status === 'running' && detail.currentStep
      ? `Step ${detail.currentStep.index + 1}/${detail.totalSteps}`
      : pill.text;

  return {
    id: detail.id,
    name: detail.templateName,
    pill,
    pillText,
    meta: formatUsd(detail.totalCostUsd),
    rows,
  };
}
