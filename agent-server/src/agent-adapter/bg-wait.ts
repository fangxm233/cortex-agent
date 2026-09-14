//
// The engine owns the wait itself now (`continuation-phase.ts`): it merges the continuation
// turns, runs the grace/max-wait watchdog, and bounds the run. What stays here is the pure
// policy around it: whether background work remains, which backend/result combinations are
// eligible, and how long the ambient bounds are.

import { getSettings } from '@core/settings.js';
import type { AgentResult } from '@core/types/agent-types.js';

/** Background-task continuation feature gate. */
export function isBgContinuationEnabled(): boolean {
  return getSettings().bgContinuation;
}

const DEFAULT_GRACE_MS = 90_000;
const DEFAULT_MAX_WAIT_MS = 1_800_000;

function envMs(name: string, defMs: number): number {
  const raw = process.env[name];
  if (!raw) return defMs;
  const s = Number(raw);
  return Number.isFinite(s) && s > 0 ? s * 1000 : defMs;
}

/** Grace period for work-done-but-unnotified tasks (CORTEX_BG_GRACE_S, default 90s). */
export function getBgGraceMs(): number {
  return envMs('CORTEX_BG_GRACE_S', DEFAULT_GRACE_MS);
}

/** Max hold for still-running tasks (CORTEX_BG_WAIT_MAX_S, default 30min). */
export function getBgMaxWaitMs(): number {
  return envMs('CORTEX_BG_WAIT_MAX_S', DEFAULT_MAX_WAIT_MS);
}

/** Background work remaining on a turn result: running + finished-but-unnotified. */
export function remainingBg(result: { pendingBackgroundTasks?: number; undeliveredBackgroundTasks?: number } | null | undefined): number {
  if (!result) return 0;
  return (result.pendingBackgroundTasks ?? 0) + (result.undeliveredBackgroundTasks ?? 0);
}

/** Backend and result prerequisites shared by the engine's background phase and the hold gates. */
export function canAwaitBgContinuation(
  backend: string,
  result: AgentResult | null | undefined,
  canRegisterSink: boolean,
): boolean {
  if (backend !== 'claude' || !canRegisterSink) return false;
  if (!result || result.rateLimited) return false;
  return remainingBg(result) > 0;
}

/** Inline policy: settings-enabled thread turns wait; interactive turns do not. */
export function shouldAwaitBgInline(
  backend: string,
  threadId: string | null | undefined,
  result: AgentResult | null | undefined,
  canRegisterSink: boolean,
): boolean {
  if (!isBgContinuationEnabled() || !threadId) return false;
  return canAwaitBgContinuation(backend, result, canRegisterSink);
}
