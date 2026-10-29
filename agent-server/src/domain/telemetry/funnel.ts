import type { AuthStatusSnapshot } from '@domain/auth/auth-status.js';
import { isTelemetryActive } from './gate.js';
import { usable } from './heartbeat.js';
import type { FunnelEvent } from './schema.js';
import { recordTelemetryEvent } from './service.js';
import { readTelemetryState, updateTelemetryState } from './state.js';

type ServerStep = Extract<
  FunnelEvent['step'], `server_${string}` | 'provider_authed' | `first_${string}` | 'existing_install'
>;

const sentThisProcess = new Set<string>();

function alreadySent(step: ServerStep): boolean {
  if (sentThisProcess.has(step)) return true;
  if (!readTelemetryState().funnelSent.includes(step)) return false;
  sentThisProcess.add(step);
  return true;
}

/** Report an onboarding step the first time this install reaches it; later calls are no-ops. */
export function recordFunnelStep(step: ServerStep, detail: string | null = null): void {
  if (alreadySent(step)) return;
  const recorded = recordTelemetryEvent({
    type: 'funnel', at: new Date().toISOString(), source: 'server', step, detail,
  });
  if (!recorded) return;
  sentThisProcess.add(step);
  updateTelemetryState((state) => ({ ...state, funnelSent: [...new Set([...state.funnelSent, step])] }));
}

/** `provider_authed` once any backend has usable credentials, however they were added. */
export async function recordProviderAuthed(
  authStatus: () => Promise<AuthStatusSnapshot | null>,
): Promise<void> {
  if (!isTelemetryActive() || alreadySent('provider_authed')) return;
  const snapshot = await authStatus().catch(() => null);
  const account = snapshot?.accounts.find(usable);
  if (account) recordFunnelStep('provider_authed', account.backend);
}

export function resetFunnelCacheForTests(): void {
  sentThisProcess.clear();
}
