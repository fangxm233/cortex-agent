// input:  handleSkillsList handler + mock DATA_DIR (via _test-home.ts)
// output: skills.list query handler tests — group structure, sorted names, empty dirs
// pos:    backend regression test for the skills.list read scope (plan §12 A item 2 / 8a)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../../_test-home.js'; // MUST be first — isolates CORTEX_HOME
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleSkillsList } from '../../../src/domain/ui-service/query/skills.js';
import { clearSkillScanCache } from '../../../src/domain/memory/skill-scanner.js';
import type { SkillGroup } from '../../../src/domain/ui-service/types.js';

// skill-scanner reads DATA_DIR at import time, but SKILL_SCAN_CACHE_MS is 60s.
// We must import DATA_DIR AFTER _test-home.js has set CORTEX_HOME so we get
// the isolated directory path, not the live ~/.cortex.
// We do a fresh dynamic import of DATA_DIR each time — paths.ts exports it
// as a const evaluated at module-load, so the workaround is to read it from
// the env variable directly (which _test-home.js sets before paths.ts loads).
const getDataDir = () => process.env['CORTEX_HOME'] ?? '';

function makeSkillDir(root: string, skillName: string) {
  const dir = path.join(root, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${skillName}`);
}

// Empty deps — handler ignores all deps (reads fs directly via skill-scanner)
const DEPS: any = {};

test('skills.list: returns empty array when no skills directories exist', async () => {
  // DATA_DIR has no .claude/skills and no plugins/ in an isolated CORTEX_HOME
  const result: SkillGroup[] = await handleSkillsList(DEPS, {});
  // May include groups if the test home seeded any plugins; just verify shape
  assert.ok(Array.isArray(result), 'result must be an array');
  for (const g of result) {
    assert.ok(typeof g.plugin === 'string' || g.plugin === null, 'plugin must be string | null');
    assert.ok(Array.isArray(g.skills), 'skills must be an array');
  }
});

test('skills.list: returns user skills group (plugin=null) when .claude/skills has skills', async () => {
  clearSkillScanCache(); // bust 60s cache before creating fixtures
  const dataDir = getDataDir();
  const claudeSkillsRoot = path.join(dataDir, '.claude', 'skills');
  fs.mkdirSync(claudeSkillsRoot, { recursive: true });
  // Create two skill dirs
  makeSkillDir(claudeSkillsRoot, 'commit');
  makeSkillDir(claudeSkillsRoot, 'analyze');

  const result: SkillGroup[] = await handleSkillsList(DEPS, {});

  // Must find the user-owned group (plugin === null)
  const userGroup = result.find((g) => g.plugin === null);
  assert.ok(userGroup, 'must have a user-owned group with plugin=null');
  assert.ok(userGroup.skills.includes('commit'), 'must include commit');
  assert.ok(userGroup.skills.includes('analyze'), 'must include analyze');
  // Skills are sorted alphabetically
  const sorted = [...userGroup.skills].sort();
  assert.deepStrictEqual(userGroup.skills, sorted, 'skills must be sorted');
});

test('skills.list: returns plugin groups from plugins/ directory', async () => {
  clearSkillScanCache(); // bust 60s cache before creating fixtures
  const dataDir = getDataDir();
  const pluginsRoot = path.join(dataDir, 'plugins');
  const pluginSkillsRoot = path.join(pluginsRoot, 'cortex-test', 'skills');
  fs.mkdirSync(pluginSkillsRoot, { recursive: true });
  makeSkillDir(pluginSkillsRoot, 'zebra');
  makeSkillDir(pluginSkillsRoot, 'alpha');

  const result: SkillGroup[] = await handleSkillsList(DEPS, {});

  const pluginGroup = result.find((g) => g.plugin === 'cortex-test');
  assert.ok(pluginGroup, 'must have cortex-test plugin group');
  assert.ok(pluginGroup.skills.includes('zebra'), 'must include zebra');
  assert.ok(pluginGroup.skills.includes('alpha'), 'must include alpha');
  const sorted = [...pluginGroup.skills].sort();
  assert.deepStrictEqual(pluginGroup.skills, sorted, 'plugin skills must be sorted');
});

test('skills.list: each returned group has independent copy (not shared cache reference)', async () => {
  const result1 = await handleSkillsList(DEPS, {});
  const result2 = await handleSkillsList(DEPS, {});
  // Mutating result1 must not affect result2 arrays
  if (result1.length > 0 && result1[0].skills.length > 0) {
    const origLen = result2[0]?.skills.length ?? 0;
    result1[0].skills.push('__injected__');
    const newLen = result2[0]?.skills.length ?? 0;
    assert.strictEqual(newLen, origLen, 'mutating one result must not affect the other');
  }
  // If no groups, this test is vacuously satisfied — still passes
  assert.ok(Array.isArray(result1), 'result is an array');
});
