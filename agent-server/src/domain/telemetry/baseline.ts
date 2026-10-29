import { recordFunnelStep } from './funnel.js';
import { SERVER_FUNNEL_STEPS } from './schema.js';
import { STATE_FILE } from './paths.js';
import { updateTelemetryState, type TelemetryState } from './state.js';

/** The first-use steps an install that predates its funnel can no longer report truthfully. */
const FIRST_USE_STEPS: readonly string[] = SERVER_FUNNEL_STEPS.filter((step) => step !== 'server_init_completed');

function settled(state: TelemetryState, freshHome: boolean): TelemetryState {
  if (state.funnelBaseline) return state;
  if (freshHome || state.funnelSent.includes('server_init_completed')) {
    return { ...state, funnelBaseline: 'fresh' };
  }
  const funnelSent = [...new Set([...state.funnelSent, ...FIRST_USE_STEPS])];
  return { ...state, funnelBaseline: 'existing', funnelSent };
}

/**
 * Decide, once per install, whether its funnel began with it. `cortex init` on a home it creates
 * says fresh; so does an init already reported. Any other home predates the funnel, and its
 * first-use steps are marked sent so it never reports a first that was not one.
 */
export function settleFunnelBaseline(opts: { freshHome?: boolean; file?: string } = {}): TelemetryState {
  return updateTelemetryState((state) => settled(state, opts.freshHome ?? false), opts.file ?? STATE_FILE);
}

/** At boot: settle the baseline and flag an install that predates its funnel (once, while telemetry is on). */
export function settleFunnelBaselineAtBoot(): void {
  if (settleFunnelBaseline().funnelBaseline === 'existing') recordFunnelStep('existing_install');
}
