// A `pi` child's model is chosen once, by whoever launches it, and that one choice is what both the
// route and the nested session see. The daemon runner is driven for real down to the session
// factory; the session itself is driven down to PI's resolver, which is faked.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentRole } from '../../../src/core/agents/roles.js';
import type { ChildSessionRequest } from '../../../src/agent-adapter/pi/child-session.js';
import type { SubagentParentContext } from '../../../src/domain/agents/subagent/runner.js';

const fakes = vi.hoisted(() => ({
  childRequests: [] as unknown[],
  routes: [] as unknown[],
  resolverCalls: [] as unknown[],
  sessionOptions: [] as unknown[],
}));

vi.mock('../../../src/agent-adapter/pi/child-session.js', async (original) => ({
  ...await original<object>(),
  createChildSession: async (request: unknown) => {
    fakes.childRequests.push(request);
    return {
      session: { prompt: async () => {}, subscribe: () => () => {}, abort: async () => {} },
      dispose: () => {},
    };
  },
}));

vi.mock('../../../src/core/pi-sdk.js', async (original) => ({
  ...await original<object>(),
  loadPiSdk: async () => ({
    hasTrustRequiringProjectResources: () => false,
    SettingsManager: { create: () => ({ getCompactionReserveTokens: () => 0 }) },
    ModelRuntime: { create: async () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSessionServices: async () => ({ diagnostics: [], modelRuntime: {} }),
    resolveCliModel: (options: { cliModel?: string; cliProvider?: string }) => {
      fakes.resolverCalls.push(options);
      return { model: { id: 'resolved' }, thinkingLevel: 'high', warning: undefined, error: undefined };
    },
    createAgentSessionFromServices: async (options: unknown) => {
      fakes.sessionOptions.push(options);
      return { session: { bindExtensions: async () => {}, dispose: () => {} } };
    },
  }),
}));

const { runSubagent } = await import('../../../src/domain/agents/subagent/runner.js');
const { getPiEngineAdapter } = await import('../../../src/domain/runs/adapters.js');
const { createChildSession } = await vi.importActual<
  typeof import('../../../src/agent-adapter/pi/child-session.js')
>('../../../src/agent-adapter/pi/child-session.js');

beforeEach(() => {
  // The route is recorded, not written: nothing here should touch a models.json.
  vi.spyOn(getPiEngineAdapter(), 'ensureProviderRouting').mockImplementation((route) => { fakes.routes.push(route); });
});

afterEach(() => {
  fakes.childRequests.length = 0;
  fakes.routes.length = 0;
  fakes.resolverCalls.length = 0;
  fakes.sessionOptions.length = 0;
});

const role: AgentRole = { name: 'explore', description: 'd', systemPrompt: 'Explore.' };

async function runPiChild(model: string | undefined, parent: SubagentParentContext): Promise<ChildSessionRequest> {
  await runSubagent({
    task: { description: 'd', prompt: 'p', subagent_type: 'explore', ...(model ? { model } : {}) },
    role, backend: 'pi', cwd: '/tmp', ref: 'tool-1#0', parent: { env: {}, ...parent },
  });
  expect(fakes.childRequests).toHaveLength(1);
  return fakes.childRequests[0] as ChildSessionRequest;
}

const piParent: SubagentParentContext = { backend: 'pi', provider: 'zai', model: 'glm-parent', mode: 'zai' };

test('a named provider/model:thinking is routed and handed to the child as the same three parts', async () => {
  const request = await runPiChild('deepseek/deepseek-chat:high', piParent);
  expect(request).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', thinking: 'high' });
  expect(fakes.routes).toEqual([expect.objectContaining({ provider: 'deepseek', model: 'deepseek-chat' })]);
});

test('a bare named model is not given the parent\'s provider, by the route or the child', async () => {
  const request = await runPiChild('glm-5', piParent);
  expect(request).toMatchObject({ provider: null, model: 'glm-5', thinking: null });
  expect(fakes.routes).toEqual([]);
});

test('with nothing named, a PI parent\'s own selection is the child\'s', async () => {
  const request = await runPiChild(undefined, piParent);
  expect(request).toMatchObject({ provider: 'zai', model: 'glm-parent', thinking: null });
  expect(fakes.routes).toEqual([expect.objectContaining({ provider: 'zai', model: 'glm-parent' })]);
});

test('a Claude parent\'s model is never offered to a PI child', async () => {
  const request = await runPiChild(undefined, { backend: 'claude', model: 'claude-opus-4-8' });
  expect(request).toMatchObject({ provider: null, model: null, thinking: null });
  expect(fakes.routes).toEqual([]);
});

test('the child session resolves the selection as one pattern and runs at the level PI found', async () => {
  const handle = await createChildSession({
    cwd: '/tmp', agentDir: '/nonexistent/pi-agent', provider: 'deepseek', model: 'deepseek-chat',
    thinking: 'high', appendSystemPrompt: [], extensions: [],
  });
  handle.dispose();
  // No separate provider: PI itself decides whether the `/` prefix names one.
  expect(fakes.resolverCalls).toEqual([{ cliModel: 'deepseek/deepseek-chat:high', modelRuntime: {} }]);
  expect(fakes.sessionOptions).toEqual([
    expect.objectContaining({ model: { id: 'resolved' }, thinkingLevel: 'high' }),
  ]);
});
