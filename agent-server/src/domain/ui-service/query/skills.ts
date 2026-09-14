// input:  UiServiceDeps + SkillsListParams (empty)
// output: skills.list handler → SkillGroup[] (from domain/memory/skill-scanner getDisplaySkillGroups)
// pos:    query handler for 'skills.list' (plan §12 A item 2 / 8a). Delegates to the module-level
//         getDisplaySkillGroups() which reads DATA_DIR/.claude/skills + DATA_DIR/plugins/*/skills and
//         caches results for 60 s. The returned groups are already sorted (null plugin first for
//         user-owned skills, then plugins alphabetically; skills within each group are sorted).
//         Domain-to-domain import (ui-service ← memory) is acceptable within L3.

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
