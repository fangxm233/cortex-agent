import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { ModelRuntime, resolveCliModel, type CreateAgentSessionRuntimeFactory } from '@earendil-works/pi-coding-agent';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { createPiRuntime, type PiRuntimeHandle } from '../../src/agent-adapter/pi/runtime.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

vi.mock('../../src/core/pi-sdk.js', () => ({ loadPiSdk: () => sdkReady }));
vi.mock('../../src/core/settings.js', () => ({ getSettings: () => ({ streamDeltas: false }) }));
vi.mock('../../src/agent-adapter/pi/agent-dir.js', () => ({ ensureCompactionReserve: vi.fn() }));
vi.mock('../../src/agent-adapter/pi/runtime-settings.js', () => ({ createRuntimeSettings: () => ({}) }));
vi.mock('../../src/agent-adapter/pi/extensions.js', () => ({ createCortexExtensions: () => [] }));
vi.mock('../../src/agent-adapter/pi/ui-context.js', () => ({
  createPiUiContext: () => ({ ui: {}, cancelAll: () => {} }),
}));

let sdkReady: Promise<typeof sdk>;
const catalogs: ModelRuntime[] = [];
type Model = NonNullable<ReturnType<typeof resolveCliModel>['model']>;
const sdk = {
  initTheme: () => {},
  resolveCliModel,
  ModelRuntime: { create: async (options: Parameters<typeof ModelRuntime.create>[0]) => {
    const runtime = await ModelRuntime.create({ ...options, refreshOnCreate: false });
    catalogs.push(runtime);
    return runtime;
  } },
  SessionManager: { create: (cwd: string) => ({ getCwd: () => cwd }) },
  createAgentSessionServices: async ({ modelRuntime }: { modelRuntime: ModelRuntime }) => ({
    modelRuntime, diagnostics: [], resourceLoader: { getExtensions: () => ({ errors: [] }) },
  }),
  createAgentSessionFromServices: async ({ model }: { model: Model }) => ({ session: {
    model, sessionId: 'test-session', bindExtensions: async () => {}, subscribe: () => () => {},
    abort: async () => {},
  } }),
  createAgentSessionRuntime: async (factory: CreateAgentSessionRuntimeFactory,
    options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
    ...await factory(options), setRebindSession: () => {}, dispose: async () => {},
  }),
};

function seedCustomCatalog(root: string): string {
  const file = join(root, 'user-models.json');
  writeFileSync(file, JSON.stringify({ providers: { 'test-provider': {
    api: 'openai-completions', baseUrl: 'http://localhost:1/v1', apiKey: 'test-only',
    models: [{ id: 'test-model', maxTokens: 8192, contextWindow: 32768 }],
  } } }));
  return file;
}

function delayedAdapter(root: string, custom: boolean) {
  const pending: Promise<PiRuntimeHandle>[] = [];
  catalogs.length = 0;
  let release!: (value: typeof sdk) => void;
  sdkReady = new Promise(resolve => { release = resolve; });
  const adapter = new PIAdapter((request, callbacks) => {
    const runtime = createPiRuntime(request, callbacks);
    pending.push(runtime);
    return runtime;
  }, join(root, 'sessions'), undefined, {
    agentDir: join(root, 'agent'), userModelsPath: custom ? seedCustomCatalog(root) : undefined,
  });
  return { adapter, pending, release };
}

async function openPair(custom: boolean, cappedFirst: boolean) {
  const root = join(process.env.CORTEX_HOME!, `cap-${custom}-${cappedFirst}`);
  mkdirSync(root, { recursive: true });
  const provider = custom ? 'test-provider' : 'deepseek';
  // Use the installed SDK's catalog, not a hard-coded guess at its model limits.
  const builtin = await ModelRuntime.create({ modelsPath: null, authPath: join(root, 'auth.json'), refreshOnCreate: false });
  const model = custom ? 'test-model' : builtin.getModels(provider)[0]!.id;
  const defaultMax = custom ? 8192 : builtin.getModel(provider, model)!.maxTokens;
  const delayed = delayedAdapter(root, custom);
  const ordinary = engineSpecFixture({
    sessionKey: 'same-identity-key', cwd: root, piProvider: provider, model: custom ? `${model}[1m]` : model,
    piGatewayBaseUrl: 'http://localhost:1', mcpComposition: 'none', pinnedEnv: {},
  });
  const capped = { ...ordinary, model: { ...ordinary.model, benchmarkMaxOutputTokens: 256 } };
  const specs = cappedFirst ? [capped, ordinary] : [ordinary, capped];
  const engines = specs.map(spec => delayed.adapter.open(spec));
  return { ...delayed, provider, model, defaultMax, ordinary, capped, specs, engines };
}

for (const custom of [false, true]) {
  test.each([true, false])(`session-local cap survives delayed SDK initialization (custom=${custom}, cappedFirst=%s)`, async cappedFirst => {
    const { adapter, pending, release, provider, model, defaultMax, ordinary, capped, specs, engines } = await openPair(custom, cappedFirst);
    try {
      expect(catalogs).toHaveLength(0); // Both opens completed while loadPiSdk is blocked.
      release(sdk);
      const handles = await Promise.all(pending);
      expect(handles.map(handle => handle.session.model?.maxTokens)).toEqual(
        cappedFirst ? [256, defaultMax] : [defaultMax, 256],
      );
      expect(catalogs.map(runtime => runtime.getModel(provider, model)!.maxTokens)).toEqual([defaultMax, defaultMax]);
      const catalog = JSON.parse(readFileSync(join(adapter.agentDir, 'models.json'), 'utf8'));
      expect(catalog.providers[provider].modelOverrides).toBeUndefined();
      expect(adapter.specIdentity(capped)).not.toBe(adapter.specIdentity(ordinary));
      expect(engines.map(engine => engine.identity)).toEqual(specs.map(spec => adapter.specIdentity(spec)));
    } finally {
      release(sdk);
      await Promise.all(engines.map(engine => engine.close()));
    }
  });
}
