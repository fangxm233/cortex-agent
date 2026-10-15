import { expect, test } from 'vitest';
import { validateEngineSelection } from '../../../src/domain/agents/engine-selection.js';
import { buildPiGatewaySubPath } from '../../../src/domain/runs/engine-spec.js';
import { specFromFixture } from '../../run-request-fixture.js';
import { GATEWAY_URL } from '../../../src/domain/costs/gateway-manager.js';

const selection = { model: 'm', backend: 'pi', mode: 'anthropic', provider: 'anthropic', thinking: null };

test('PI requires an explicit safe provider, Claude requires null', () => {
  expect(() => validateEngineSelection(selection)).not.toThrow();
  expect(() => validateEngineSelection({ ...selection, provider: undefined })).toThrow(/provider/);
  expect(() => validateEngineSelection({ ...selection, provider: null })).toThrow(/provider/);
  expect(() => validateEngineSelection({ ...selection, provider: 'has spaces' })).toThrow(/provider/);
  expect(() => validateEngineSelection({ ...selection, backend: 'claude', provider: null })).not.toThrow();
  expect(() => validateEngineSelection({ ...selection, backend: 'claude' })).toThrow(/provider/);
});

test('gateway subpath composes mode/provider and leaves absent route direct', () => {
  expect(buildPiGatewaySubPath('anthropic', 'anthropic')).toBe('/m/anthropic/anthropic');
  expect(buildPiGatewaySubPath(null, 'anthropic')).toBeUndefined();
});

test('PI keeps the gateway authority, not the Claude route URL', () => {
  const spec = specFromFixture(
    { loadCortexRules: false },
    { model: 'gpt-x', backend: 'pi', mode: 'openai-codex', provider: 'openai-codex' },
    { ANTHROPIC_BASE_URL: `${GATEWAY_URL}/m/openai-codex/project=nimbus,trigger=user/anthropic` },
  );
  expect(spec.route.gatewayBaseUrl).toBe(GATEWAY_URL);
  expect(spec.route.gatewayPath).toBe('/m/openai-codex/openai-codex');
  expect(`${spec.route.gatewayBaseUrl}${spec.route.gatewayPath}`).toBe(`${GATEWAY_URL}/m/openai-codex/openai-codex`);
});
