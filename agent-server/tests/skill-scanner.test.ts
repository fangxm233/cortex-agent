// input:  Vitest, isolated skill fixtures, skill-scanner
// output: plugin discovery + prefix normalization tests
// pos:    Verify !skills group discovery and namespace completion
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js';
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR, PLUGINS_DIR } from '../src/core/paths.js';
import {
  clearSkillScanCache,
  getDisplaySkillNames,
  getDisplaySkillGroups,
  getKnownSkillNames,
  normalizeSkillCommandPrefix,
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
  // _test-home guarantees these roots are disposable, even with a seeded catalog.
  t.onTestFinished(clearFixture);
  clearFixture();
  writeSkill(USER_SKILLS, 'personal-review');
  writeSkill(path.join(PLUGINS_DIR, 'cortex-coder', 'skills'), 'code-standards');
  writeSkill(path.join(PLUGINS_DIR, 'cortex-common', 'skills'), 'solution-design');
  writeSkill(path.join(PLUGINS_DIR, 'superpowers', 'skills'), 'brainstorming');
  writeSkill(path.join(PLUGINS_DIR, 'superpowers', 'skills'), 'using-superpowers');
});

test('getDisplaySkillNames surfaces plugin skills and excludes namespaced-only aliases', () => {
  const skills = [...getDisplaySkillNames()];

  assert.ok(skills.includes('code-standards'), 'expected cortex-coder:code-standards to be discovered');
  assert.ok(skills.includes('solution-design'), 'expected cortex-common:solution-design to be discovered');
  assert.ok(skills.includes('personal-review'));
  assert.ok(skills.includes('brainstorming'));
  assert.ok(skills.includes('using-superpowers'));
  assert.ok(!skills.includes('cortex-coder:code-standards'));
  assert.ok(!skills.includes('superpowers:brainstorming'));
  assert.ok(!skills.includes('superpowers:using-superpowers'));
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

test('getKnownSkillNames recognizes both bare and plugin-namespaced forms', () => {
  const known = getKnownSkillNames();

  assert.ok(known.has('code-standards'));
  assert.ok(known.has('cortex-coder:code-standards'));
  assert.ok(known.has('solution-design'));
  assert.ok(known.has('cortex-common:solution-design'));
  assert.ok(known.has('personal-review'));
  assert.ok(known.has('superpowers:brainstorming'));
  assert.ok(known.has('superpowers:using-superpowers'));
});

test('normalizeSkillCommandPrefix prefixes `/` for bare and namespaced skill invocations', () => {
  assert.equal(
    normalizeSkillCommandPrefix('code-standards please review the bridge'),
    '/code-standards please review the bridge',
  );
  assert.equal(
    normalizeSkillCommandPrefix('cortex-coder:code-standards please review the bridge'),
    '/cortex-coder:code-standards please review the bridge',
  );
  assert.equal(normalizeSkillCommandPrefix('personal-review this'), '/personal-review this');
  assert.equal(
    normalizeSkillCommandPrefix('/code-standards already slashed'),
    '/code-standards already slashed',
  );
  assert.equal(
    normalizeSkillCommandPrefix('!status is unrelated'),
    '!status is unrelated',
  );
  assert.equal(
    normalizeSkillCommandPrefix('definitely-not-a-skill foo'),
    'definitely-not-a-skill foo',
  );
});
