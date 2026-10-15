import { expect, test } from 'vitest';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import type { EngineSpec } from '../../../src/agent-adapter/types.js';
import { buildEngineSpec } from '../../../src/domain/runs/engine-spec.js';
import { claudeProcessLaunch, launchFromSpec } from '../../../src/agent-adapter/claude/session-options.js';
import { buildSessionRequest } from '../../../src/agent-adapter/pi/session-options.js';
import { buildServerStates } from '../../../src/agent-adapter/pi/mcp-bridge.js';
import { toolContextFromEnv } from '../../../src/domain/mcp/tools/context.js';
import { runRequestFixture } from '../../run-request-fixture.js';

const STALE_ENV = {
  CORTEX_BACKEND: 'stale-backend', CORTEX_MODEL: 'stale-model',
  CORTEX_PROVIDER: 'stale-provider', CORTEX_THINKING: 'stale-thinking', CORTEX_MODE: 'stale-mode',
};
const selections: EngineSelection[] = [
  { backend: 'claude', provider: null, model: 'claude-opus-4-6', thinking: 'high', mode: 'plan' },
  { backend: 'claude', provider: null, model: 'claude-sonnet-4-6', thinking: null, mode: 'api' },
  { backend: 'pi', provider: 'deepseek', model: 'deepseek-v4-flash[1m]', thinking: 'xhigh', mode: 'deepseek' },
  { backend: 'pi', provider: 'openai', model: 'gpt-5', thinking: null, mode: 'openai' },
];

function specFor(selection: EngineSelection): EngineSpec {
  // Deliberately different from the selected attempt: the request is not the spawn authority.
  const request = runRequestFixture({ pinnedEnv: STALE_ENV, loadCortexRules: false });
  return buildEngineSpec(request, selection);
}

function launchEnv(spec: EngineSpec): NodeJS.ProcessEnv {
  if (spec.backend.kind === 'claude') return claudeProcessLaunch(launchFromSpec(spec)).env;
  return buildSessionRequest(spec, {
    agentDir: '/fixture/pi', sessionDir: '/fixture/sessions', sessionPath: null,
    cwd: '/fixture', streamDeltas: false,
  }).env;
}

function expectSelection(env: NodeJS.ProcessEnv, selection: EngineSelection): void {
  expect(toolContextFromEnv(env).selection).toEqual(selection);
  expect(env.CORTEX_BACKEND).toBe(selection.backend);
  expect(env.CORTEX_MODEL).toBe(selection.model);
  expect(env.CORTEX_MODE).toBe(selection.mode);
  expect(env.CORTEX_PROVIDER).toBe(selection.provider ?? undefined);
  expect(env.CORTEX_THINKING).toBe(selection.thinking ?? undefined);
  if (selection.provider === null) expect(env).not.toHaveProperty('CORTEX_PROVIDER');
  if (selection.thinking === null) expect(env).not.toHaveProperty('CORTEX_THINKING');
}

for (const selection of selections) {
  test(`${selection.backend}/${selection.model}: actual attempt reaches launch and MCP context`, () => {
    const spec = specFor(selection);
    // Even a run without project/session/execution identity must carry its selection.
    expect(spec.env.context?.selection).toEqual(selection);
    const env = launchEnv(spec);
    expectSelection(env, selection);
    expect(STALE_ENV.CORTEX_MODEL).toBe('stale-model');
    if (selection.backend === 'pi') {
      const core = buildServerStates(env).find(state => state.name === 'core');
      expect(core?.source.kind).toBe('bundled');
      if (core?.source.kind !== 'bundled') throw new Error('Missing in-process MCP context');
      expectSelection(core.source.env, selection);
    }
  });
}

for (const selection of [selections[0], selections[2]]) {
  test(`${selection.backend}: missing selection never inherits parent selection fields`, () => {
    const spec = specFor(selection);
    spec.env.context = undefined;
    const env = launchEnv(spec);
    expect(env.CORTEX_BACKEND).toBe(selection.backend);
    for (const key of ['CORTEX_MODEL', 'CORTEX_PROVIDER', 'CORTEX_THINKING', 'CORTEX_MODE']) {
      expect(env).not.toHaveProperty(key);
    }
    expect(toolContextFromEnv(env).selection).toBeNull();
  });
}
