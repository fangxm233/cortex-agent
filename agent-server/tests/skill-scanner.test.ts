import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR, PLUGINS_DIR } from '../src/core/paths.js';
import {
  clearSkillScanCache,
  getDisplaySkillGroups,
} from '../src/domain/memory/skill-scanner.js';

const USER_SKILLS = path.join(DATA_DIR, '.claude', 'skills');

function writeSkill(root: string, name: string): void {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `# ${path.basename(name)}\n`);
}

function clearFixture(): void {
  for (const root of [USER_SKILLS, PLUGINS_DIR]) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  clearSkillScanCache();
}

beforeEach((t) => {
  // The vitest setup file's per-file home guarantees these roots are disposable, even with a seeded catalog.
  t.onTestFinished(clearFixture);
  clearFixture();
  writeSkill(USER_SKILLS, 'personal-review');
  writeSkill(path.join(PLUGINS_DIR, 'cortex-coder', 'skills'), 'code-standards');
  writeSkill(path.join(PLUGINS_DIR, 'cortex-common', 'skills'), 'solution-design');
  writeSkill(path.join(PLUGINS_DIR, 'superpowers', 'skills'), 'brainstorming');
  writeSkill(path.join(PLUGINS_DIR, 'superpowers', 'skills'), 'using-superpowers');
});

test('getDisplaySkillGroups returns plugin-grouped skill catalog', () => {
  const groups = getDisplaySkillGroups();

  assert.deepEqual(groups, [
    { plugin: null, skills: ['personal-review'] },
    { plugin: 'cortex-coder', skills: ['code-standards'] },
    { plugin: 'cortex-common', skills: ['solution-design'] },
    { plugin: 'superpowers', skills: ['brainstorming', 'using-superpowers'] },
  ]);
});
