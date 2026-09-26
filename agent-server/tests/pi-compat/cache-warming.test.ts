import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { SettingsManager, type CreateAgentSessionRuntimeFactory } from '@earendil-works/pi-coding-agent';
import { createPiRuntime } from '../../src/agent-adapter/pi/runtime.js';
import { createChildSession } from '../../src/agent-adapter/pi/child-session.js';
import type { PiSessionRequest } from '../../src/agent-adapter/pi/session-options.js';

vi.mock('../../src/core/pi-sdk.js', () => ({ loadPiSdk: async () => sdk }));
vi.mock('../../src/core/settings.js', () => ({ getSettings: () => ({ piCompactReserveTokens: 1000 }) }));
vi.mock('../../src/agent-adapter/pi/agent-dir.js', () => ({ ensureCompactionReserve: vi.fn() }));
vi.mock('../../src/agent-adapter/pi/extensions.js', () => ({ createCortexExtensions: () => [] }));
vi.mock('../../src/agent-adapter/pi/ui-context.js', () => ({
  createPiUiContext: () => ({ ui: {}, respond: vi.fn(), cancelAll: vi.fn() }),
}));

const managers: SettingsManager[] = [];
const session = { bindExtensions: async () => {}, subscribe: () => () => {}, dispose: () => {} };
const sdk = {
  SettingsManager,
  initTheme: () => {},
  hasTrustRequiringProjectResources: () => false,
  ModelRuntime: { create: async () => ({}) },
  SessionManager: {
    create: (cwd: string) => ({ getCwd: () => cwd }),
    inMemory: (cwd: string) => ({ getCwd: () => cwd }),
  },
  createAgentSessionServices: async ({ settingsManager }: { settingsManager: SettingsManager }) => {
    managers.push(settingsManager);
    return { diagnostics: [], resourceLoader: { getExtensions: () => ({ errors: [] }) } };
  },
  createAgentSessionFromServices: async () => ({ session }),
  createAgentSessionRuntime: async (factory: CreateAgentSessionRuntimeFactory, options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
    ...await factory(options), setRebindSession: () => {}, dispose: async () => {},
  }),
};

function requestFor(name: string, mode: 'streaming' | 'idle' | undefined): PiSessionRequest {
  const root = join(process.env.CORTEX_HOME!, name);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ cacheWarming: mode }));
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ cacheWarming: 'idle' }));
  return {
    cwd, agentDir, sessionKey: name, sessionDir: join(root, 'sessions'), sessionPath: null,
    provider: null, model: null, thinking: null, systemPrompt: null, appendSystemPrompt: [],
    skillPaths: [], disableHooks: true, reportsProviderQuota: false,
    pluginMcpServers: [], env: {}, streamDeltas: false,
  };
}

const start = {
  main: (request: PiSessionRequest) => createPiRuntime(request, { onEvent: () => {} }),
  child: (request: PiSessionRequest) => createChildSession({ ...request, extensions: [] }),
};

for (const kind of ['main', 'child'] as const) {
  test.each([undefined, 'streaming', 'idle'] as const)(`${kind} forces warming off without persisting (%s)`, async (mode) => {
    const request = requestFor(`${kind}-${mode}`, mode);
    const files = [join(request.agentDir, 'settings.json'), join(request.cwd, '.pi', 'settings.json')];
    const before = files.map((file) => readFileSync(file, 'utf8'));
    const initial = SettingsManager.create(request.cwd, request.agentDir, { projectTrusted: true });
    expect(initial.getCacheWarmingMode()).toBe(mode ?? 'streaming');
    managers.length = 0;
    const handle = await start[kind](request);
    try {
      expect(managers).toHaveLength(1);
      const [settings] = managers;
      expect(settings.getCacheWarmingMode()).toBe('off');
      settings.reload();
      expect(settings.getCacheWarmingMode()).toBe('off');
      await settings.flush();
      expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual(before);
      expect(settings.getGlobalSettings().cacheWarming).toBe(mode);
    } finally {
      await handle.dispose();
    }
  });
}
