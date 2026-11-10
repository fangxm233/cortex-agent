import { resolveModelRef } from '../agents/models.js';
import { resolveDaemonSelection } from '../agents/model-selection.js';
import type { EngineSelection } from '../agents/engine-selection.js';
import { checkDelegatedModel } from '../agents/delegation.js';
import { delegationName, type DelegationModelRef } from '@core/agents/subagent/delegation-policy.js';
import { ScheduleSpecError } from './schedule-spec.js';

/** CLI/chat model flags resolve once, at creation or edit, never again when the task fires. A task
 *  being edited starts from its own selection; a new one from the configured default. */
export function resolveScheduleSelection(
  model?: string, thinking?: string, current?: EngineSelection,
): EngineSelection | undefined {
  if (model === undefined && thinking === undefined) return undefined;
  const partial: Partial<EngineSelection> = {
    ...(model !== undefined ? resolveModelRef(model) : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
  const resolution = resolveDaemonSelection({ request: current }, partial);
  if (resolution.ok === true) return resolution.selection;
  if (resolution.reason === 'invalid-thinking') {
    const backend = partial.backend ?? current?.backend ?? resolution.base?.backend;
    const levels = (resolution.allowed ?? []).join(', ');
    throw new ScheduleSpecError('thinking', `Invalid thinking '${thinking}' for ${backend}. Valid values: ${levels}`, thinking);
  }
  throw new ScheduleSpecError('model', `Cannot use model '${model ?? ''}': ${resolution.reason}`, model);
}

function sessionModel(env: NodeJS.ProcessEnv): DelegationModelRef | null {
  const backend = env.CORTEX_BACKEND;
  if ((backend !== 'claude' && backend !== 'pi') || !env.CORTEX_MODEL) return null;
  return { backend, provider: env.CORTEX_PROVIDER || null, model: env.CORTEX_MODEL };
}

/** A schedule an agent writes from its session is a delegation: a model it names passes the same
 *  policy as a subagent's. A user at a terminal has no session id and is not checked. */
export function checkAgentScheduleModel(
  model: string | undefined, selection: EngineSelection | undefined, env: NodeJS.ProcessEnv = process.env,
): void {
  if (!model || !selection || !env.CORTEX_SESSION_ID) return;
  try {
    checkDelegatedModel({ backend: selection.backend, model: delegationName(selection), parent: sessionModel(env) });
  } catch (error) {
    throw new ScheduleSpecError('model', (error as Error).message, model);
  }
}
