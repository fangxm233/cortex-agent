// input:  formatDurationCompact (core/utils)
// output: 5 pure formatting functions: computeElapsed / formatMetricsSuffix / buildSessionTag / buildUserProcessingMessage / buildThreadStatusMessage
// pos:    zero-dependency pure functions in the core layer; the subset imported by domain-layer status-helpers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { formatDurationCompact } from './utils.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

export function computeElapsed(startTime: number): { elapsedStr: string; elapsedS: number } {
  const elapsedS = (Date.now() - startTime) / 1000;
  return { elapsedStr: formatDurationCompact(elapsedS), elapsedS };
}

export function formatMetricsSuffix({ costUsd, numTurns }: { costUsd: number | null; numTurns: number | null }): string {
  const turnsStr = numTurns != null ? ` · ${numTurns} turns` : '';
  const costStr = costUsd != null ? ` · $${costUsd.toFixed(4)}` : '';
  return `${turnsStr}${costStr}`;
}

/** Build "cortex-XXXX · `uuid`" tag for Slack status messages. */
export function buildSessionTag(sessionName: string | null, sessionId: string | null): string {
  if (!sessionName && !sessionId) return '';
  const parts: string[] = [];
  if (sessionName) parts.push(sessionName);
  if (sessionId) parts.push(`\`${sessionId}\``);
  return parts.join(' · ') + ' | ';
}

/** `todoProgress` is a pre-rendered task-list line (see normalize/todo.ts renderTodoProgress).
 *  Passing the rendered string rather than a snapshot keeps this formatter free of todo parsing
 *  and lets every caller decide whether the surface shows task progress at all. */
export function buildUserProcessingMessage({ startTime, elapsed_s = null, num_turns = null, profileName, sessionName = null, sessionId = null, todoProgress = null }: { startTime: number; elapsed_s?: number | null; num_turns?: number | null; profileName: string; sessionName?: string | null; sessionId?: string | null; todoProgress?: string | null }): string {
  const elapsed = elapsed_s ?? ((Date.now() - startTime) / 1000);
  const sessionTag = buildSessionTag(sessionName, sessionId);
  const turnsStr = num_turns != null ? ` | ${Icons.repeat} ${num_turns} turns` : '';
  const todoStr = todoProgress ? ` | ${Icons.todo} ${todoProgress}` : '';
  return `${Icons.processing} ${t('status.processing')} | ${sessionTag}${profileName || 'default'} | ${Icons.stopwatch} ${formatDurationCompact(elapsed || 0)}${turnsStr}${todoStr}`;
}

const THREAD_STATUS_TASK_TEXT_MAX = 60;
const THREAD_STATUS_THREAD_ID_LEN = 12;

/** Build the multi-agent thread step status line. When task info is present (task-dispatch
 *  threads carry taskProject/taskId/taskText in metadata) the line leads with the task identity
 *  — "[proj] <text…> · `id`" — so a glance tells you what is running; the short thread id is kept
 *  at the tail for thread-op debugging. Without task info it falls back to the thread-only form. */
export function buildThreadStatusMessage({ threadId, stepNumber, label, elapsedS, numTurns = null, taskProject = null, taskId = null, taskText = null }: {
  threadId: string;
  stepNumber: number;
  label: string;
  elapsedS: number;
  numTurns?: number | null;
  taskProject?: string | null;
  taskId?: string | null;
  taskText?: string | null;
}): string {
  const shortId = threadId.substring(0, THREAD_STATUS_THREAD_ID_LEN);
  const turnsPart = numTurns != null ? ` (${numTurns} turns)` : '';
  const stepPart = `Step ${stepNumber}: *${label}*${turnsPart}`;
  const timePart = `${Icons.stopwatch} ${formatDurationCompact(elapsedS)}`;
  if (taskId) {
    const projPart = taskProject ? `[${taskProject}] ` : '';
    const raw = (taskText ?? '').trim();
    const text = raw.length > THREAD_STATUS_TASK_TEXT_MAX
      ? raw.slice(0, THREAD_STATUS_TASK_TEXT_MAX).trimEnd() + '…'
      : raw;
    const textPart = text ? `${text} ` : '';
    return `${Icons.processing} ${projPart}${textPart}· \`${taskId}\` | ${stepPart} | ${shortId} | ${timePart}`;
  }
  return `${Icons.processing} Thread ${shortId} | ${stepPart} | ${timePart}`;
}
