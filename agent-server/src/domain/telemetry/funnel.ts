import type { FunnelEvent } from './schema.js';
import { recordTelemetryEvent } from './service.js';
import { readTelemetryState, updateTelemetryState } from './state.js';

type ServerStep = Extract<FunnelEvent['step'], `server_${string}` | 'provider_authed' | `first_${string}`>;

const sentThisProcess = new Set<string>();

/** Report an onboarding step the first time this install reaches it; later calls are no-ops. */
export function recordFunnelStep(step: ServerStep, detail: string | null = null): void {
  if (sentThisProcess.has(step)) return;
  if (readTelemetryState().funnelSent.includes(step)) {
    sentThisProcess.add(step);
    return;
  }
  const recorded = recordTelemetryEvent({
    type: 'funnel', at: new Date().toISOString(), source: 'server', step, detail,
  });
  if (!recorded) return;
  sentThisProcess.add(step);
  updateTelemetryState((state) => ({ ...state, funnelSent: [...new Set([...state.funnelSent, step])] }));
}

export function resetFunnelCacheForTests(): void {
  sentThisProcess.clear();
}
