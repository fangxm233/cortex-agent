import { getDisplaySkillGroups } from '@domain/memory/skill-scanner.js';
import type { UiServiceDeps, SkillGroup, QueryParams } from '../types.js';

export async function handleSkillsList(
  _deps: UiServiceDeps,
  _params: QueryParams<'skills.list'>,
): Promise<SkillGroup[]> {
  // getDisplaySkillGroups() returns Array<{ plugin: string | null; skills: string[] }> —
  // structurally identical to SkillGroup[]. Spread to avoid returning the cached array reference.
  return getDisplaySkillGroups().map((g) => ({ plugin: g.plugin, skills: [...g.skills] }));
}
