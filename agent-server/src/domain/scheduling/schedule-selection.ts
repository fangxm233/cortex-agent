import { resolveModelRef } from '../agents/models.js';
import { resolveDaemonSelection } from '../agents/model-selection.js';
import type { EngineSelection } from '../agents/engine-selection.js';
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
