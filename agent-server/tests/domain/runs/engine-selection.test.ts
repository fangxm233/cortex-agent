import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { validateEngineSelection, validateModelRef, type ModelsFile } from '../../../src/domain/agents/engine-selection.js';
import { environmentSchema } from '../../../src/domain/agents/environments/schema.js';
import { buildEngineSpec } from '../../../src/domain/runs/engine-spec.js';
import { runRequestFixture } from '../../run-request-fixture.js';

const context = {
  schema_version: 'cortex-production-benchmark-evidence-context/1' as const,
  trial_id: 'trial', root_run_id: 'root', bundle_manifest_hash: 'a'.repeat(64),
  model_execution: { cli_name: 'pi' as const, cli_version: '1', model_alias_policy: null, max_output_tokens: 8192 },
};

test.each(['claude', 'pi'] as const)('selection model and thinking reach %s unchanged', (backend) => {
  const request = runRequestFixture({ loadCortexRules: false }, {
    backend, provider: backend === 'pi' ? 'deepseek' : null,
    model: 'selected-model', thinking: 'high', mode: backend === 'pi' ? 'deepseek' : 'plan',
  });
  const spec = buildEngineSpec(request, request.selection);
  expect(spec.model.id).toBe('selected-model');
  expect(spec.model.thinking).toBe('high');
  expect(spec.model.provider).toBe(backend === 'pi' ? 'deepseek' : undefined);
  expect(spec).not.toHaveProperty('extraOption');
});

test('null thinking sends no effort and selected provider carries its own route', () => {
  const request = runRequestFixture({ loadCortexRules: false }, {
    backend: 'pi', provider: 'zai', mode: 'zai', model: 'glm', thinking: null,
  });
  const spec = buildEngineSpec(request, request.selection);
  expect(spec.model.thinking).toBeUndefined();
  expect(spec.route.gatewayPath).toBe('/m/zai/zai');
});

test.each([
  ['pi', true, 8192], ['pi', false, undefined], ['claude', true, undefined],
] as const)('output cap is benchmark PI only: %s benchmark=%s', (backend, benchmark, expected) => {
  const request = runRequestFixture({ loadCortexRules: false, benchmarkMaxOutputTokens: 8192 }, {
    backend, provider: backend === 'pi' ? 'deepseek' : null,
  });
  if (benchmark) request.benchmark = { evidenceContext: context, identityDirective: '' };
  const spec = buildEngineSpec(request, request.selection);
  expect(spec.model.benchmarkMaxOutputTokens).toBe(expected);
  expect(spec.env.context ?? {}).not.toHaveProperty('profile');
});

test('route credentials are not overridable by retired selection properties', () => {
  const request = runRequestFixture({ loadCortexRules: false });
  const selection = { ...request.selection, extraEnv: { ANTHROPIC_API_KEY: 'wrong' }, extraOption: { '--effort': 'low' } };
  const spec = buildEngineSpec(request, selection, { route: { ANTHROPIC_API_KEY: null } });
  expect(spec.env.sets).toBeUndefined();
  expect(spec.env.unsets).toContain('ANTHROPIC_API_KEY');
  expect(spec).not.toHaveProperty('extraOption');
});


test.each(['deepseek', 'openai-codex'])('sealed %s bundle uses the server selection contract', (provider) => {
  const home = new URL(`../../../../benchmark/harness/src/cortex_bench_harness/launcher/bundles/direct-pi-${provider}/cortex-home/`, import.meta.url);
  const read = (relative: string) => JSON.parse(readFileSync(new URL(relative, home), 'utf8'));
  const models = read('config/models.json') as ModelsFile;
  validateEngineSelection(models.default);
  models.favorites.forEach(validateModelRef);
  expect(models.favorites).toEqual([{ backend: 'pi', provider, model: models.default.model }]);
  expect(read('data/agent-state.json')).toEqual({ defaultAgent: 'main' });
  const environment = read('config/environments/main.json');
  expect(environmentSchema.parse(environment)).toEqual(environment);
  const request = runRequestFixture({ loadCortexRules: false, benchmarkMaxOutputTokens: 8192 }, models.default);
  request.benchmark = { evidenceContext: context, identityDirective: '' };
  const spec = buildEngineSpec(request, models.default);
  expect(spec.route.gatewayPath).toBe(`/m/trial/${provider}`);
  expect(spec.model.benchmarkMaxOutputTokens).toBe(8192);
  expect(spec.model.thinking).toBe(models.default.thinking);
});
