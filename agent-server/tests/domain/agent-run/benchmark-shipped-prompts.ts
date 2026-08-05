// input:  the shipped defaults/prompts tree
// output: the same tree under the live PROMPTS_DIR the loader reads
// pos:    Shared prompt-asset seeding for the benchmark document suites
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import { DEFAULTS_DIR, PROMPTS_DIR } from '../../../src/core/paths.js';
import path from 'node:path';

/**
 * Mirror the copy step production performs at init (`safeCopyDir(DEFAULTS_DIR/prompts →
 * DATA_DIR/prompts)`). The benchmark agent documents reference their directive and system prompt as
 * `file:<name>.md`, and those refs resolve against PROMPTS_DIR, not against the shipped defaults —
 * so a suite that seeds only the documents seeds half the agent.
 */
export function seedShippedPrompts(): void {
  fs.cpSync(path.join(DEFAULTS_DIR, 'prompts'), PROMPTS_DIR, { recursive: true });
}
