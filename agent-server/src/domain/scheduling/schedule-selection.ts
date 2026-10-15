import { getDefaultSelection, resolveModelRef, selectionForModel } from '../agents/models.js';
import { isValidThinkingLevel, THINKING_LEVELS_BY_BACKEND, type EngineSelection } from '../agents/engine-selection.js';
import { ScheduleSpecError } from './schedule-spec.js';

/** CLI/chat model flags resolve once, at creation or edit, never again when the task fires. */
export function resolveScheduleSelection(
  model?: string, thinking?: string, current?: EngineSelection,
): EngineSelection | undefined {
  if (model === undefined && thinking === undefined) return undefined;
  const selection = model === undefined ? current ?? getDefaultSelection() : selectionForModel(resolveModelRef(model));
  if (thinking === undefined) return { ...selection };
  if (!isValidThinkingLevel(selection.backend, thinking)) {
    const levels = THINKING_LEVELS_BY_BACKEND[selection.backend].join(', ');
    throw new ScheduleSpecError('thinking', `Invalid thinking '${thinking}' for ${selection.backend}. Valid values: ${levels}`, thinking);
  }
  return { ...selection, thinking };
}
