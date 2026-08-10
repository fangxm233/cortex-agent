// input:  dependency-cruiser config, standalone source graph
// output: standalone direct-runtime architecture assertions
// pos:    Static contract for production standalone wiring
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../../.dependency-cruiser.cjs');

const COMPOSITION_SURFACES = '^src/domain/(agent-run/(runner|standalone-composition|standalone-stores|benchmark-output-adapter)|benchmark/trial-adapter-factory)\\.ts$';
const STANDALONE_RULES = [
  'standalone-root-no-daemon',
  'standalone-root-no-platform',
  'standalone-root-no-remote',
  'standalone-root-no-update',
  'standalone-root-no-host-stores',
  'standalone-root-no-outbound',
  'standalone-root-no-ambient-roots',
] as const;

const FORBIDDEN_EXAMPLES: ReadonlyArray<readonly [typeof STANDALONE_RULES[number], string]> = [
  ['standalone-root-no-daemon', 'src/entry/daemon.ts'],
  ['standalone-root-no-platform', 'src/platform/slack/adapter.ts'],
  ['standalone-root-no-remote', 'src/domain/remote/client-manager.ts'],
  ['standalone-root-no-update', 'src/domain/system/server-update-check.ts'],
  ['standalone-root-no-host-stores', 'src/store/task-repo.ts'],
  ['standalone-root-no-outbound', 'src/store/outbound-queue.ts'],
  ['standalone-root-no-ambient-roots', 'src/core/paths.ts'],
];

type Rule = {
  name: string;
  severity: string;
  from: { path?: string };
  to: { path?: string; reachable?: boolean; dependencyTypesNot?: string[] };
};

const rules: Rule[] = config.forbidden;

function rule(name: string): Rule {
  const found = rules.find(candidate => candidate.name === name);
  expect(found, `architecture rule ${name} is missing`).toBeDefined();
  return found!;
}

describe('standalone production composition architecture', () => {
  it('retires the whole-domain benchmark isolation rule family', () => {
    expect(rules.map(candidate => candidate.name).filter(name => (
      name.startsWith('benchmark-isolation-')
    ))).toEqual([]);
  });

  it('anchors replacement rules at the production entry and factory seams', () => {
    expect(rules.map(candidate => candidate.name).filter(name => (
      name.startsWith('standalone-root-')
    ))).toEqual(STANDALONE_RULES);
    for (const name of STANDALONE_RULES) {
      expect(rule(name).from).toEqual({ path: COMPOSITION_SURFACES });
      expect(rule(name).severity).toBe('error');
    }
  });

  it.each(FORBIDDEN_EXAMPLES)('rejects explicit %s composition', (name, target) => {
    expect(new RegExp(rule(name).to.path!).test(target)).toBe(true);
  });

  it('allows type-only and transitive reusable-domain dependencies', () => {
    for (const name of STANDALONE_RULES) {
      expect(rule(name).to.reachable).toBeUndefined();
      expect(rule(name).to.dependencyTypesNot).toEqual(['type-only']);
    }
  });

  it('finds no forbidden direct runtime edge in the production standalone graph', async () => {
    const { cruise } = await import('dependency-cruiser');
    const { default: extractTsConfig } =
      await import('dependency-cruiser/config-utl/extract-ts-config');
    const result = await cruise(
      ['src'],
      { ...config.options, ruleSet: { forbidden: rules }, validate: true },
      null,
      { tsConfig: extractTsConfig('tsconfig.json') },
    );
    const violations = (result.output as {
      summary: { violations: Array<{ rule: { name: string }; from: string; to: string }> };
    }).summary.violations.filter(violation => (
      STANDALONE_RULES.includes(violation.rule.name as typeof STANDALONE_RULES[number])
    ));
    expect(violations).toEqual([]);
  }, 120_000);
});
