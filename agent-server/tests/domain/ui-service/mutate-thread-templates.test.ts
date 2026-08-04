import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR } from '../../../src/core/paths.js';
import {
  handleThreadTemplatesValidate,
  handleThreadTemplatesSave,
  handleThreadTemplatesRemove,
} from '../../../src/domain/ui-service/mutate/thread-templates.js';
import { handleThreadTemplatesDetail } from '../../../src/domain/ui-service/query/thread-template-detail.js';
import { readThreadTemplates } from '../../../src/domain/ui-service/query/thread-templates.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

// The handlers bind CONFIG_DIR, which _test-home has already pointed at an isolated temp home.
const TT_DIR = path.join(CONFIG_DIR, 'thread-templates');

function agentBody(name: string, stages: string[] = ['work']) {
  return {
    name,
    description: `${name} agent`,
    profile: 'plan',
    persistSession: true,
    tools: 'Read',
    entryStage: stages[0],
    stages: Object.fromEntries(stages.map((s) => [s, { promptTemplate: `${s}: {{input}}` }])),
  };
}

function templateBody(name: string) {
  return {
    name,
    description: 'a → b',
    agents: ['a', 'b'],
    transitions: [{ from: 'a:work', to: 'b:work', condition: { type: 'always' } }],
    entryAgent: 'a',
    entryStage: 'work',
    maxTotalSteps: 2,
  };
}

function seed(sub: 'agents' | 'templates' | 'shells', name: string, body: unknown): void {
  mkdirSync(path.join(TT_DIR, sub), { recursive: true });
  writeFileSync(path.join(TT_DIR, sub, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function deps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    ...overrides,
  } as unknown as UiServiceDeps;
}

beforeEach(() => {
  rmSync(TT_DIR, { recursive: true, force: true });
  mkdirSync(TT_DIR, { recursive: true });
  seed('agents', 'a', agentBody('a'));
  seed('agents', 'b', agentBody('b'));
});

describe('threadTemplates.validate', () => {
  test('reports a clean body as ok without writing anything', async () => {
    const result = await handleThreadTemplatesValidate(deps(), {
      kind: 'template',
      name: 'ab',
      body: templateBody('ab'),
    });
    assert.ok(result.ok);
    assert.equal(result.data.ok, true);
    assert.deepEqual(result.data.errors, []);
    assert.equal(existsSync(path.join(TT_DIR, 'templates', 'ab.json')), false, 'validate must not write');
  });

  test('reports errors with field anchors', async () => {
    const result = await handleThreadTemplatesValidate(deps(), {
      kind: 'template',
      name: 'ab',
      body: { ...templateBody('ab'), entryAgent: 'nobody' },
    });
    assert.ok(result.ok);
    assert.equal(result.data.ok, false);
    assert.ok(result.data.errors.some((e) => e.path === 'entryAgent'), JSON.stringify(result.data.errors));
  });

  test('judges the candidate against the world it would produce', async () => {
    // `c` does not exist yet, so a template naming it is invalid...
    const before = await handleThreadTemplatesValidate(deps(), {
      kind: 'template',
      name: 'ac',
      body: { ...templateBody('ac'), agents: ['a', 'c'], transitions: [] },
    });
    assert.ok(before.ok && before.data.ok === false);

    // ...but validating `c` itself sees itself present.
    const self = await handleThreadTemplatesValidate(deps(), { kind: 'agent', name: 'c', body: agentBody('c') });
    assert.ok(self.ok && self.data.ok === true, JSON.stringify(self));
  });
});

describe('threadTemplates.save', () => {
  test('creates, then updates with the returned hash', async () => {
    const created = await handleThreadTemplatesSave(deps(), {
      kind: 'template',
      name: 'ab',
      body: templateBody('ab'),
    });
    assert.ok(created.ok, JSON.stringify(created));
    assert.equal(created.data.changed, true);

    const updated = await handleThreadTemplatesSave(deps(), {
      kind: 'template',
      name: 'ab',
      body: { ...templateBody('ab'), maxTotalSteps: 7 },
      baseHash: created.data.sha256,
    });
    assert.ok(updated.ok);
    assert.equal(
      JSON.parse(readFileSync(path.join(TT_DIR, 'templates', 'ab.json'), 'utf8')).maxTotalSteps,
      7,
    );
  });

  test('an invalid body is rejected as invalid-args and never lands', async () => {
    const result = await handleThreadTemplatesSave(deps(), {
      kind: 'template',
      name: 'ab',
      body: { ...templateBody('ab'), agents: ['a', 'ghost'] },
    });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'invalid-args');
    assert.equal(existsSync(path.join(TT_DIR, 'templates', 'ab.json')), false);
  });

  test('a stale hash surfaces as a conflict code, so the UI can offer a reload', async () => {
    const created = await handleThreadTemplatesSave(deps(), {
      kind: 'template',
      name: 'ab',
      body: templateBody('ab'),
    });
    assert.ok(created.ok);
    await handleThreadTemplatesSave(deps(), {
      kind: 'template',
      name: 'ab',
      body: { ...templateBody('ab'), maxTotalSteps: 5 },
      baseHash: created.data.sha256,
    });

    const stale = await handleThreadTemplatesSave(deps(), {
      kind: 'template',
      name: 'ab',
      body: { ...templateBody('ab'), maxTotalSteps: 3 },
      baseHash: created.data.sha256,
    });
    assert.equal(stale.ok, false);
    assert.equal((stale as { code: string }).code, 'conflict');
  });

  test('warnings come back on a successful save', async () => {
    const result = await handleThreadTemplatesSave(deps(), {
      kind: 'agent',
      name: 'c',
      body: { ...agentBody('c'), somethingNew: 1 },
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(result.data.warnings.some((w) => w.path === 'somethingNew'));
  });
});

describe('threadTemplates.remove', () => {
  test('deletes an unreferenced entity', async () => {
    await handleThreadTemplatesSave(deps(), { kind: 'agent', name: 'c', body: agentBody('c') });
    const result = await handleThreadTemplatesRemove(deps(), { kind: 'agent', name: 'c' });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(existsSync(path.join(TT_DIR, 'agents', 'c.json')), false);
  });

  test('refuses while a template still declares the agent', async () => {
    seed('templates', 'ab', templateBody('ab'));
    const result = await handleThreadTemplatesRemove(deps(), { kind: 'agent', name: 'a' });
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /still used by/);
    assert.equal(existsSync(path.join(TT_DIR, 'agents', 'a.json')), true);
  });

  test('a missing entity is not-found', async () => {
    const result = await handleThreadTemplatesRemove(deps(), { kind: 'agent', name: 'ghost' });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'not-found');
  });
});

describe('threadTemplates.detail', () => {
  test('returns the raw body, hash, dependents and validation verdict', async () => {
    seed('templates', 'ab', templateBody('ab'));
    const detail = await handleThreadTemplatesDetail(deps(), { kind: 'agent', name: 'a' });

    assert.equal(detail.name, 'a');
    assert.equal(detail.body?.name, 'a');
    assert.equal(detail.filePath, path.join(TT_DIR, 'agents', 'a.json'));
    assert.deepEqual(detail.errors, []);
    assert.deepEqual(detail.usedByTemplates, ['ab']);
    assert.equal(detail.origin, 'custom', 'a test-only agent has no shipped default');
    assert.ok(detail.sha256.length === 64);
  });

  test('a `file:` prompt ref survives the round trip, so an edit cannot inline the prompt', async () => {
    seed('agents', 'c', { ...agentBody('c'), systemPrompt: 'file:c.md' });
    const detail = await handleThreadTemplatesDetail(deps(), { kind: 'agent', name: 'c' });
    assert.equal(detail.body?.systemPrompt, 'file:c.md');
  });

  test('counts the live threads and open tasks that an edit would affect', async () => {
    seed('templates', 'ab', templateBody('ab'));
    const detail = await handleThreadTemplatesDetail(
      deps({
        threadStore: {
          getAll: () => [
            { templateName: 'ab', status: 'running' },
            { templateName: 'ab', status: 'completed' },
            { templateName: 'other', status: 'running' },
          ],
          get: () => null,
        },
        taskStore: {
          getAll: () => [
            { template: 'ab', status: 'open' },
            { template: 'ab', status: 'done' },
          ],
          getById: () => null,
          load: () => {},
          refresh: () => {},
        },
      } as unknown as Partial<UiServiceDeps>),
      { kind: 'template', name: 'ab' },
    );
    assert.equal(detail.runningThreads, 1, 'terminal threads and other templates must not count');
    assert.equal(detail.referencingTasks, 1, 'done tasks must not count');
  });

  test('a shell-binding template exposes the graph it expands to', async () => {
    seed('agents', 'worker', agentBody('worker', ['produce', 'retry']));
    seed('agents', 'checker', agentBody('checker', ['review']));
    seed('shells', 'wr', {
      params: ['worker', 'reviewer'],
      agents: ['{worker}', '{reviewer}'],
      transitions: [{ from: '{worker}:{worker.entryStage}', to: '{reviewer}', condition: { type: 'always' } }],
      entryAgent: '{worker}',
      entryStage: '{worker.entryStage}',
      maxTotalSteps: 3,
    });
    seed('templates', 'bound', { shell: 'wr', worker: 'worker', reviewer: 'checker' });

    const detail = await handleThreadTemplatesDetail(deps(), { kind: 'template', name: 'bound' });
    assert.ok(detail.expanded, 'expected an expanded graph');
    assert.deepEqual(detail.expanded?.agents, ['worker', 'checker']);
    assert.equal((detail.expanded?.transitions as Array<{ from: string }>)[0].from, 'worker:produce');
  });

  test('a missing entity is a not-found error', async () => {
    await assert.rejects(() => handleThreadTemplatesDetail(deps(), { kind: 'agent', name: 'ghost' }), /Unknown agent/);
  });
});

describe('threadTemplates.get', () => {
  test('flags a broken entity and counts its errors', async () => {
    seed('templates', 'broken', { ...templateBody('broken'), entryAgent: 'nobody' });
    const entries = await readThreadTemplates(CONFIG_DIR);

    const broken = entries.find((e) => e.name === 'broken');
    assert.ok(broken);
    assert.equal(broken.valid, false);
    assert.ok(broken.errorCount > 0);

    const healthy = entries.find((e) => e.name === 'a');
    assert.ok(healthy);
    assert.equal(healthy.valid, true);
    assert.equal(healthy.errorCount, 0);
  });

  test('classifies origin against the shipped defaults', async () => {
    const entries = await readThreadTemplates(CONFIG_DIR);
    assert.equal(entries.find((e) => e.name === 'a')?.origin, 'custom');
  });
});
