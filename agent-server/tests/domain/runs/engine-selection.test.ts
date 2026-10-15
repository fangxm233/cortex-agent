import { expect, test } from 'vitest';
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
