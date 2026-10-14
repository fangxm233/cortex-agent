import * as path from 'path';
import { DATA_DIR } from '@core/paths.js';
// Shared with the rules-loader hook, which applies the path-scoped rules this loader skips.
import { builtinRulesDir, loadLayeredRules } from '../../../defaults/hooks/cortex-context-lib.mjs';

const RULES_DIR = path.join(DATA_DIR, 'rules');

/**
 * Bodies of the global rules (no `paths` frontmatter), in file-name order: the shipped rules with
 * the user's ~/.cortex/rules/ laid over them. Path-scoped rules are skipped; the rules-loader hook
 * applies them.
 */
export function loadCortexRules(
  rulesDir: string = RULES_DIR,
  builtinDir: string | null = builtinRulesDir(),
): string[] {
  return loadLayeredRules(rulesDir, builtinDir).filter((rule) => rule.paths.length === 0).map((rule) => rule.body);
}
