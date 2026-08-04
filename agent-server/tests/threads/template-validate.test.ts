// input:  vitest + domain/threads/template-validate (the thread-template validation layer)
// output: validateEntity / validateRegistry coverage — the error set, the warning set, the
//         cross-entity impact pass, and the shipped-defaults regression guard
// pos:    Errors block a save, warnings do not. The split is the contract this suite pins down:
//         every check that can silently stall a running thread must be an error, and every check
//         that merely looks suspicious must be a warning. The last test is the one that matters
//         most — every entity Cortex actually ships must validate clean, or the validator is wrong.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  validateEntity,
  validateRegistry,
  withCandidate,
  rawRegistryFromDir,
  dependentTemplates,
  type RawRegistry,
} from '../../src/domain/threads/template-validate.js';

// --- Fixtures ---

function stagedAgent(name: string, stages: string[]) {
  return {
    name,
    description: `${name} agent`,
    profile: 'plan',
    persistSession: true,
    systemPrompt: `file:${name}.md`,
    tools: 'Read,Write',
    entryStage: stages[0],
    stages: Object.fromEntries(stages.map((s) => [s, { promptTemplate: `${s}: {{input}}` }])),
  };
}

function flatAgent(name: string) {
  return {
    name,
    description: `${name} agent`,
    profile: '__active__',
    persistSession: false,
    promptTemplate: '{{input}}',
    tools: 'Read',
  };
}

const WORKER_REVIEW_SHELL = {
  params: ['worker', 'reviewer'],
  agents: ['{worker}', '{reviewer}'],
  transitions: [
    { from: '{worker}:{worker.entryStage}', to: '{reviewer}', condition: { type: 'always' } },
    {
      from: '{reviewer}',
      to: '{worker}:retry',
      condition: { type: 'convergence', marker: '[APPROVED]', maxIterations: 1 },
    },
    {
      from: '{worker}:retry',
      to: '{reviewer}',
      condition: { type: 'output_not_contains', pattern: '\\[REVISED\\]' },
    },
  ],
  entryAgent: '{worker}',
  entryStage: '{worker.entryStage}',
  maxTotalSteps: 4,
};

function baseRegistry(): RawRegistry {
  return {
    agents: {
      coder: stagedAgent('coder', ['implement', 'retry']),
      'coder-reviewer': stagedAgent('coder-reviewer', ['implReview']),
      solo: flatAgent('solo'),
    },
    templates: {},
    shells: { 'worker-review': WORKER_REVIEW_SHELL },
  };
}

const FULL_TEMPLATE = {
  name: 'coder-review',
  description: 'coder → reviewer',
  agents: ['coder', 'coder-reviewer'],
  transitions: [
    { from: 'coder:implement', to: 'coder-reviewer:implReview', condition: { type: 'always' } },
  ],
  entryAgent: 'coder',
  entryStage: 'implement',
  maxTotalSteps: 4,
};

function messages(issues: Array<{ path: string; message: string }>): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join(' | ');
}

// --- Happy paths ---

describe('valid entities', () => {
  test('a full template with matching agents and stages is clean', () => {
    const reg = baseRegistry();
    const result = validateEntity('template', 'coder-review', FULL_TEMPLATE, reg);
    assert.deepEqual(result.errors, [], messages(result.errors));
    assert.deepEqual(result.warnings, [], messages(result.warnings));
  });

  test('a shell binding that expands cleanly is clean', () => {
    const reg = baseRegistry();
    const binding = { shell: 'worker-review', worker: 'coder', reviewer: 'coder-reviewer' };
    const result = validateEntity('template', 'coder-review', binding, reg);
    assert.deepEqual(result.errors, [], messages(result.errors));
  });

  test('a staged agent is clean', () => {
    const result = validateEntity('agent', 'coder', stagedAgent('coder', ['implement', 'retry']), baseRegistry());
    assert.deepEqual(result.errors, [], messages(result.errors));
    assert.deepEqual(result.warnings, [], messages(result.warnings));
  });

  test('__active__ is a valid agent slot and entryAgent', () => {
    const reg = baseRegistry();
    const tpl = {
      name: 'default',
      description: 'single active agent',
      agents: ['__active__'],
      transitions: [],
      entryAgent: '__active__',
      maxTotalSteps: 1,
    };
    const result = validateEntity('template', 'default', tpl, reg);
    assert.deepEqual(result.errors, [], messages(result.errors));
  });
});

// --- Errors: the things that stall a running thread ---

describe('errors', () => {
  test('a non-object body is rejected', () => {
    const result = validateEntity('agent', 'x', 'not an object', baseRegistry());
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /must be a JSON object/);
  });

  test('agent name must equal the filename', () => {
    const body = { ...stagedAgent('coder', ['implement']), name: 'other' };
    const result = validateEntity('agent', 'coder', body, baseRegistry());
    assert.ok(result.errors.some((e) => e.path === 'name'), messages(result.errors));
  });

  test('entryAgent outside the template agents list is an error', () => {
    const tpl = { ...FULL_TEMPLATE, entryAgent: 'solo' };
    const result = validateEntity('template', 'coder-review', tpl, baseRegistry());
    assert.ok(
      result.errors.some((e) => e.path === 'entryAgent' && /cannot take its first step/.test(e.message)),
      messages(result.errors),
    );
  });

  test('an unknown agent in the agents list is an error', () => {
    const tpl = { ...FULL_TEMPLATE, agents: ['coder', 'ghost'] };
    const result = validateEntity('template', 'coder-review', tpl, baseRegistry());
    assert.ok(result.errors.some((e) => e.path === 'agents[1]' && /unknown agent "ghost"/.test(e.message)));
  });

  test('a transition target outside the agents list is an error', () => {
    const tpl = {
      ...FULL_TEMPLATE,
      transitions: [{ from: 'coder:implement', to: 'solo', condition: { type: 'always' } }],
    };
    const result = validateEntity('template', 'coder-review', tpl, baseRegistry());
    assert.ok(result.errors.some((e) => e.path === 'transitions[0].to'), messages(result.errors));
  });

  test('a transition pinning a stage the agent lacks is an error', () => {
    const tpl = {
      ...FULL_TEMPLATE,
      transitions: [{ from: 'coder:nope', to: 'coder-reviewer:implReview', condition: { type: 'always' } }],
    };
    const result = validateEntity('template', 'coder-review', tpl, baseRegistry());
    assert.ok(
      result.errors.some((e) => e.path === 'transitions[0].from' && /has no "nope" stage/.test(e.message)),
      messages(result.errors),
    );
  });

  test('agent entryStage naming a nonexistent stage is an error', () => {
    const body = { ...stagedAgent('coder', ['implement']), entryStage: 'ghost' };
    const result = validateEntity('agent', 'coder', body, baseRegistry());
    assert.ok(result.errors.some((e) => e.path === 'entryStage'), messages(result.errors));
  });

  test('an unparseable regex is an error, because the edge can never fire', () => {
    const tpl = {
      ...FULL_TEMPLATE,
      transitions: [
        {
          from: 'coder:implement',
          to: 'coder-reviewer:implReview',
          condition: { type: 'output_contains', pattern: '[unclosed' },
        },
      ],
    };
    const result = validateEntity('template', 'coder-review', tpl, baseRegistry());
    assert.ok(
      result.errors.some((e) => e.path === 'transitions[0].condition.pattern' && /Invalid regex/.test(e.message)),
      messages(result.errors),
    );
  });

  test('maxTotalSteps must be a positive integer', () => {
    const result = validateEntity('template', 'coder-review', { ...FULL_TEMPLATE, maxTotalSteps: 0 }, baseRegistry());
    assert.ok(result.errors.some((e) => e.path === 'maxTotalSteps'), messages(result.errors));
  });

  test('an unknown shell is an error', () => {
    const binding = { shell: 'nope', worker: 'coder', reviewer: 'coder-reviewer' };
    const result = validateEntity('template', 'x', binding, baseRegistry());
    assert.ok(result.errors.some((e) => e.path === 'shell' && /unknown shell "nope"/.test(e.message)));
  });

  test('a shell binding missing a param surfaces the expander error', () => {
    const binding = { shell: 'worker-review', worker: 'coder' };
    const result = validateEntity('template', 'x', binding, baseRegistry());
    assert.ok(result.errors.some((e) => /missing "reviewer" binding/.test(e.message)), messages(result.errors));
  });

  test('a shell placeholder that is not a declared param is an error', () => {
    const shell = { ...WORKER_REVIEW_SHELL, entryAgent: '{missing}' };
    const result = validateEntity('shell', 'worker-review', shell, baseRegistry());
    assert.ok(
      result.errors.some((e) => e.path === 'entryAgent' && /unknown placeholder/.test(e.message)),
      messages(result.errors),
    );
  });

  test('an unsupported placeholder property is an error', () => {
    const shell = { ...WORKER_REVIEW_SHELL, entryStage: '{worker.profile}' };
    const result = validateEntity('shell', 'worker-review', shell, baseRegistry());
    assert.ok(result.errors.some((e) => /only .entryStage is supported/.test(e.message)), messages(result.errors));
  });
});

// --- Warnings: suspicious but functional ---

describe('warnings', () => {
  test('an unrecognised field is a warning, never an error', () => {
    const body = { ...stagedAgent('coder', ['implement']), futureField: 'x' };
    const result = validateEntity('agent', 'coder', body, baseRegistry());
    assert.deepEqual(result.errors, [], messages(result.errors));
    assert.ok(result.warnings.some((w) => w.path === 'futureField'), messages(result.warnings));
  });

  test('convergence without a marker warns', () => {
    const tpl = {
      ...FULL_TEMPLATE,
      transitions: [
        {
          from: 'coder:implement',
          to: 'coder-reviewer:implReview',
          condition: { type: 'convergence', maxIterations: 2 },
        },
      ],
    };
    const result = validateEntity('template', 'coder-review', tpl, baseRegistry());
    assert.deepEqual(result.errors, [], messages(result.errors));
    assert.ok(result.warnings.some((w) => /never converges/.test(w.message)), messages(result.warnings));
  });

  test('an agent declared but never reached warns', () => {
    const tpl = { ...FULL_TEMPLATE, transitions: [] };
    const result = validateEntity('template', 'coder-review', tpl, baseRegistry());
    assert.deepEqual(result.errors, [], messages(result.errors));
    assert.ok(result.warnings.some((w) => /never reached/.test(w.message)), messages(result.warnings));
  });

  test('multiple stages without an entryStage warns about the silent fallback', () => {
    const body = stagedAgent('coder', ['implement', 'retry']);
    delete (body as Record<string, unknown>).entryStage;
    const result = validateEntity('agent', 'coder', body, baseRegistry());
    assert.deepEqual(result.errors, [], messages(result.errors));
    assert.ok(result.warnings.some((w) => /silently used/.test(w.message)), messages(result.warnings));
  });

  test('an agent with neither promptTemplate nor stages warns', () => {
    const body = flatAgent('solo');
    delete (body as Record<string, unknown>).promptTemplate;
    const result = validateEntity('agent', 'solo', body, baseRegistry());
    assert.ok(result.warnings.some((w) => /no prompt to run/.test(w.message)), messages(result.warnings));
  });

  test('a missing prompt file ref warns only when a resolver is supplied', () => {
    const body = stagedAgent('coder', ['implement']);
    const withoutResolver = validateEntity('agent', 'coder', body, baseRegistry());
    assert.deepEqual(withoutResolver.warnings, [], messages(withoutResolver.warnings));

    const withResolver = validateEntity('agent', 'coder', body, baseRegistry(), {
      promptsDir: '/prompts',
      pluginBaseDir: '/data',
      join: (...p) => p.join('/'),
      exists: () => false,
      isAbsolute: (p) => p.startsWith('/'),
    });
    assert.ok(withResolver.warnings.some((w) => w.path === 'systemPrompt'), messages(withResolver.warnings));
  });

  test('a binding key the shell does not declare warns', () => {
    const binding = { shell: 'worker-review', worker: 'coder', reviewer: 'coder-reviewer', extra: 'x' };
    const result = validateEntity('template', 'x', binding, baseRegistry());
    assert.deepEqual(result.errors, [], messages(result.errors));
    assert.ok(result.warnings.some((w) => w.path === 'extra'), messages(result.warnings));
  });
});

// --- Impact: what a save breaks elsewhere ---

describe('cross-entity impact', () => {
  test('removing a stage an existing template pins is reported at save time', () => {
    const reg = baseRegistry();
    reg.templates['coder-review'] = FULL_TEMPLATE;
    // The candidate drops the `implement` stage the template's transition pins.
    const candidate = stagedAgent('coder', ['retry']);
    const next = withCandidate(reg, 'agent', 'coder', candidate);
    const result = validateEntity('agent', 'coder', candidate, next);
    assert.ok(
      result.errors.some((e) => e.path === 'template:coder-review'),
      `expected an impact error, got: ${messages(result.errors)}`,
    );
  });

  test('a shell edit that breaks a bound template is reported against that template', () => {
    const reg = baseRegistry();
    reg.templates.x = { shell: 'worker-review', worker: 'coder', reviewer: 'coder-reviewer' };
    const candidate = { ...WORKER_REVIEW_SHELL, transitions: [{ from: '{worker}:ghost', to: '{reviewer}', condition: { type: 'always' } }] };
    const next = withCandidate(reg, 'shell', 'worker-review', candidate);
    const result = validateEntity('shell', 'worker-review', candidate, next);
    assert.ok(result.errors.some((e) => e.path === 'template:x'), messages(result.errors));
  });

  test('dependentTemplates finds both full-form and shell-binding users', () => {
    const reg = baseRegistry();
    reg.templates['coder-review'] = FULL_TEMPLATE;
    reg.templates.bound = { shell: 'worker-review', worker: 'coder', reviewer: 'coder-reviewer' };
    assert.deepEqual(dependentTemplates('agent', 'coder', reg).sort(), ['bound', 'coder-review']);
    assert.deepEqual(dependentTemplates('shell', 'worker-review', reg), ['bound']);
    assert.deepEqual(dependentTemplates('template', 'coder-review', reg), []);
  });
});

// --- Regression guard: everything Cortex ships must validate clean ---

describe('shipped defaults', () => {
  const defaultsDir = path.resolve(__dirname, '../../defaults/config/thread-templates');

  test('every shipped agent, template and shell validates without errors', (ctx) => {
    if (!existsSync(defaultsDir)) return ctx.skip();
    const registry = rawRegistryFromDir(defaultsDir, {
      readdirSync,
      readFileSync: (p, enc) => readFileSync(p, enc),
      existsSync,
      join: path.join,
    });

    const total =
      Object.keys(registry.agents).length +
      Object.keys(registry.templates).length +
      Object.keys(registry.shells).length;
    assert.ok(total > 0, 'expected the defaults directory to contain entities');

    const failures: string[] = [];
    for (const [key, result] of validateRegistry(registry)) {
      if (result.errors.length > 0) failures.push(`${key} → ${messages(result.errors)}`);
    }
    assert.deepEqual(failures, [], `shipped entities must validate clean:\n${failures.join('\n')}`);
  });
});
