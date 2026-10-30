import { createLogger } from '@core/log.js';
import { parseApiRetryEvent, parseModelFallbackEvent } from './event-parser.js';
import type { PendingTurn } from './turn-machine.js';

const log = createLogger('claude-bridge');

type SystemLineCallbacks = Pick<PendingTurn, 'onCompact' | 'onModelFallback' | 'onApiRetry'>;

/** A throwing callback is logged, never allowed to break the stream. */
function invoke(name: string, call: () => void): void {
  try { call(); }
  catch (e) { log.warn(`${name} threw:`, (e as Error).message); }
}

function reportCompaction(turn: SystemLineCallbacks, data: any): void {
  if (data.subtype !== 'compact_boundary' || !turn.onCompact) return;
  const meta = data.compact_metadata ?? {};
  invoke('onCompact', () => turn.onCompact!({
    trigger: typeof meta.trigger === 'string' ? meta.trigger : 'auto',
    preTokens: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined,
  }));
}

function reportModelFallback(turn: SystemLineCallbacks, data: any): void {
  const event = parseModelFallbackEvent(data);
  if (!event || !turn.onModelFallback) return;
  invoke('onModelFallback', () => turn.onModelFallback!({
    originalModel: event.originalModel, fallbackModel: event.fallbackModel,
  }));
}

function reportApiRetry(turn: SystemLineCallbacks, data: any): void {
  const event = parseApiRetryEvent(data);
  if (!event || !turn.onApiRetry) return;
  invoke('onApiRetry', () => turn.onApiRetry!({ attempt: event.attempt, error: event.error }));
}

const REPORTERS = [reportCompaction, reportModelFallback, reportApiRetry];

/** Hand the open turn the `system` lines it reports: compaction boundary, model fallback, API retry. */
export function reportSystemLine(turn: SystemLineCallbacks | null, data: any): void {
  if (!turn || data?.type !== 'system') return;
  for (const report of REPORTERS) report(turn, data);
}
