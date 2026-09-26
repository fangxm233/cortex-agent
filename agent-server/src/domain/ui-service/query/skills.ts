import { getDisplaySkillGroups } from '@domain/memory/skill-scanner.js';
import type { UiServiceDeps, SkillsListParams, SkillGroup } from '../types.js';

export async function handleSkillsList(
  _deps: UiServiceDeps,
  _params: SkillsListParams,
): Promise<SkillGroup[]> {
  // getDisplaySkillGroups() returns Array<{ plugin: string | null; skills: string[] }> —
  // structurally identical to SkillGroup[]. Spread to avoid returning the cached array reference.
  return getDisplaySkillGroups().map((g) => ({ plugin: g.plugin, skills: [...g.skills] }));
}
