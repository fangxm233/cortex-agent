import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

/** §18 (18.8) G5-R6/G5-R8. Two named arrays spliced into the single `forbidden` export: LIVE rules
 *  are wired to the repo-wide lint gate, STAGED rules are evaluated by every cruise and report
 *  nothing because their routes run through modules outside Gate 5's scope. This file is the fence
 *  that makes a staged rule more than a comment: it promotes every staged rule to `error`, cruises,
 *  and pins the per-rule counts exactly. An INCREASE is a new coupling and fails here even while
 *  the repo lint is green. A DECREASE is progress and requires the pin lowered in the same commit
 *  that lowers it — a ratchet. */
const require = createRequire(import.meta.url);
const config = require('../../../.dependency-cruiser.cjs');

const SHIPPED_LAYER_RULES = [
  'core-not-to-other-layers',
  'store-known-exceptions-only',
  'events-not-to-other-layers',
  'platform-only-core-events',
  'domain-not-to-orch-or-entry',
  'orch-not-to-entry',
];

const LIVE_RULES = [
  'benchmark-isolation-x3-outbound-queue',
  'benchmark-isolation-x4-host-stores',
  'benchmark-isolation-x6-remote-devices',
  'benchmark-isolation-x7-gpu',
  'benchmark-isolation-x8-update',
  'benchmark-isolation-x9-git-shell-out',
];

const STAGED_RULES = [
  'benchmark-isolation-staged-x1-daemon-jobctx',
  'benchmark-isolation-staged-x2-platform-adapters',
  'benchmark-isolation-staged-x5-host-projects',
  'benchmark-isolation-staged-x10-ambient-homes',
  'benchmark-isolation-staged-x11-ambient-hook-bus',
  'benchmark-isolation-staged-x12-daemon-webhook',
  'benchmark-isolation-staged-x13-orchestration',
];

/** The measured state at landing. Recomputed on this branch with the partition and the Gate-5
 *  modules present; every number is a fact with a named owner in the rule's own `comment`. */
const PINNED_COUNTS: Readonly<Record<string, number>> = {
  'benchmark-isolation-x3-outbound-queue': 0,
  'benchmark-isolation-x4-host-stores': 0,
  'benchmark-isolation-x6-remote-devices': 0,
  'benchmark-isolation-x7-gpu': 0,
  'benchmark-isolation-x8-update': 0,
  'benchmark-isolation-x9-git-shell-out': 0,
  'benchmark-isolation-staged-x1-daemon-jobctx': 2,
  'benchmark-isolation-staged-x2-platform-adapters': 196,
  'benchmark-isolation-staged-x5-host-projects': 3,
  'benchmark-isolation-staged-x10-ambient-homes': 0,
  'benchmark-isolation-staged-x11-ambient-hook-bus': 2,
  'benchmark-isolation-staged-x12-daemon-webhook': 0,
  'benchmark-isolation-staged-x13-orchestration': 2,
};

type Rule = {
  name: string;
  severity: string;
  comment?: string;
  from: { path?: string };
  to: Record<string, unknown>;
};

const rules: Rule[] = config.forbidden;

function rule(name: string): Rule {
  const found = rules.find(candidate => candidate.name === name);
  expect(found, `rule ${name} is absent from the forbidden array`).toBeDefined();
  return found!;
}

describe('§7.3 X1-X13 isolation rules (§18 (18.8))', () => {
  describe('all thirteen are present, in the single forbidden array', () => {
    it('carries the six shipped layer rules plus the thirteen benchmark rules', () => {
      expect(rules.map(r => r.name)).toEqual([
        ...SHIPPED_LAYER_RULES, ...LIVE_RULES, ...STAGED_RULES,
      ]);
    });

    it('subjects every benchmark rule on ^src/domain/benchmark/ and nothing else (G5-R1)', () => {
      for (const name of [...LIVE_RULES, ...STAGED_RULES]) {
        expect(rule(name).from).toEqual({ path: '^src/domain/benchmark/' });
      }
    });
  });

  describe('no rule is softened: G5-R6\'s "only severity differs"', () => {
    it('exempts no path — `pathNot` appears in none of the thirteen', () => {
      for (const name of [...LIVE_RULES, ...STAGED_RULES]) {
        expect(rule(name).to).not.toHaveProperty('pathNot');
        expect(rule(name).from).not.toHaveProperty('pathNot');
      }
    });

    it('omits dependencyTypesNot on every one of the thirteen (§7.3 deviation 1)', () => {
      for (const name of [...LIVE_RULES, ...STAGED_RULES]) {
        expect(rule(name).to).not.toHaveProperty('dependencyTypesNot');
        expect(rule(name).to).not.toHaveProperty('dependencyTypes');
      }
    });

    it('runs the live rules at error and the staged rules at ignore', () => {
      for (const name of LIVE_RULES) expect(rule(name).severity).toBe('error');
      for (const name of STAGED_RULES) expect(rule(name).severity).toBe('ignore');
    });

    it('records an owner for every staged rule (G5-D7(c))', () => {
      for (const name of STAGED_RULES) {
        expect(rule(name).comment, name).toMatch(/Owner:/);
      }
    });

    it('uses the reachability form everywhere except X10 and its declared gap (G5-R3)', () => {
      const direct = 'benchmark-isolation-staged-x10-ambient-homes';
      for (const name of [...LIVE_RULES, ...STAGED_RULES]) {
        if (name === direct) expect(rule(name).to).not.toHaveProperty('reachable');
        else expect(rule(name).to).toHaveProperty('reachable', true);
      }
      expect(rule(direct).comment).toMatch(/DIRECT EDGE/);
    });
  });

  describe('the six shipped layer rules are untouched', () => {
    it('keeps each one\'s own dependencyTypesNot at [\'type-only\']', () => {
      for (const name of SHIPPED_LAYER_RULES) {
        expect(rule(name).to.dependencyTypesNot, name).toEqual(['type-only']);
        expect(rule(name).severity, name).toBe('error');
      }
    });
  });

  describe('the counts are pinned, so a new violating edge fails while the lint is green', () => {
    it('reproduces every per-rule count with the staged rules promoted to error', async () => {
      const counts = await cruisePerRuleCounts();
      expect(counts).toEqual(PINNED_COUNTS);
    }, 120_000);

    it('reports zero for the live rules under the repo-wide lint gate', async () => {
      const counts = await cruisePerRuleCounts({ promoteStaged: false });
      for (const name of LIVE_RULES) expect(counts[name], name).toBe(0);
      for (const name of STAGED_RULES) expect(counts[name], name).toBe(0);
    }, 120_000);
  });
});

async function cruisePerRuleCounts(
  options: { promoteStaged?: boolean } = {},
): Promise<Record<string, number>> {
  const promoteStaged = options.promoteStaged ?? true;
  const { cruise } = await import('dependency-cruiser');
  const { default: extractTsConfig } =
    await import('dependency-cruiser/config-utl/extract-ts-config');
  const forbidden = rules.map(candidate => (
    promoteStaged && candidate.name.startsWith('benchmark-isolation-staged-')
      ? { ...candidate, severity: 'error' }
      : candidate
  ));
  const result = await cruise(
    ['src'],
    { ...config.options, ruleSet: { forbidden }, validate: true },
    null,
    { tsConfig: extractTsConfig('tsconfig.json') },
  );
  const counts: Record<string, number> = Object.fromEntries(
    [...LIVE_RULES, ...STAGED_RULES].map(name => [name, 0]),
  );
  for (const violation of (result.output as { summary: { violations: { rule: { name: string } }[] } })
    .summary.violations) {
    if (violation.rule.name in counts) counts[violation.rule.name] += 1;
  }
  return counts;
}
