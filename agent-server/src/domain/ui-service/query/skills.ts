import { listSkillGroups } from '@domain/plugins/catalog.js';
import type { UiServiceDeps, SkillGroup, QueryParams } from '../types.js';

export async function handleSkillsList(
  _deps: UiServiceDeps,
  _params: QueryParams<'skills.list'>,
): Promise<SkillGroup[]> {
  return listSkillGroups();
}
