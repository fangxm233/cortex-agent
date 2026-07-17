// input:  Node test runner + skill-scanner module
// output: plugin discovery + prefix normalization tests
// pos:    Verify !skills group discovery and namespace completion
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  getDisplaySkillNames,
  getDisplaySkillGroups,
  getKnownSkillNames,
  normalizeSkillCommandPrefix,
} from '../src/domain/memory/skill-scanner.js';

test('getDisplaySkillNames surfaces plugin skills and excludes codex-only skills', () => {
  const skills = [...getDisplaySkillNames()];

  assert.ok(skills.includes('code-standards'), 'expected cortex-coder:code-standards to be discovered');
  assert.ok(skills.includes('solution-design'), 'expected cortex-common:solution-design to be discovered');
  assert.ok(!skills.includes('superpowers:brainstorming'));
  assert.ok(!skills.includes('superpowers:using-superpowers'));
});

test('getDisplaySkillGroups returns plugin-grouped skill catalog', () => {
  const groups = getDisplaySkillGroups();

  const plugins = groups.map((g) => g.plugin);
  assert.ok(plugins.includes('cortex-coder'));
  assert.ok(plugins.includes('cortex-common'));

  const coder = groups.find((g) => g.plugin === 'cortex-coder');
  assert.ok(coder);
  assert.ok(coder.skills.includes('code-standards'));

  const common = groups.find((g) => g.plugin === 'cortex-common');
  assert.ok(common);
  assert.ok(common.skills.includes('solution-design'));
});

test('getKnownSkillNames recognizes both bare and plugin-namespaced forms', () => {
  const known = getKnownSkillNames();

  assert.ok(known.has('code-standards'));
  assert.ok(known.has('cortex-coder:code-standards'));
  assert.ok(known.has('solution-design'));
  assert.ok(known.has('cortex-common:solution-design'));
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
