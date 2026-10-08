import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createPiRuntime } from '../../src/agent-adapter/pi/runtime.js';
import { createChildSession } from '../../src/agent-adapter/pi/child-session.js';
import { buildPiEnv, type PiSessionRequest } from '../../src/agent-adapter/pi/session-options.js';
import { buildChildEnv } from '../../src/agent-adapter/pi/child-runner.js';

// Real SDK session/services/tools; only disable Cortex's unrelated integrations.
vi.mock('../../src/core/pi-sdk.js', () => ({ loadPiSdk: async () => sdk }));
vi.mock('../../src/core/settings.js', () => ({
  getSettings: () => ({ maxContextTokens: null, piCompactReserveTokens: 1000 }),
}));
vi.mock('../../src/agent-adapter/pi/agent-dir.js', () => ({ ensureCompactionReserve: vi.fn() }));
vi.mock('../../src/agent-adapter/pi/extensions.js', () => ({ createCortexExtensions: () => [] }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const selected = 'C:/Cortex tools/便携 Git/bin/bash.exe';
const selectedPath = 'C:\\Cortex tools\\node;C:\\Cortex tools\\Git\\cmd;C:\\Windows\\System32';

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.stubEnv('CORTEX_GIT_BASH_PATH', selected);
  vi.stubEnv('PATH', selectedPath);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network allowed'); }));
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function requestFor(shellPath?: string): PiSessionRequest {
  const root = process.env.CORTEX_HOME!;
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'auth.json'), '{}');
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ shellPath,
    packages: [], extensions: [], skills: [], prompts: [], enableAnalytics: false,
  }));
  return {
    cwd, agentDir, sessionKey: 'selected-bash', sessionDir: join(root, 'sessions'), sessionPath: null,
    provider: null, model: null, thinking: null, systemPrompt: 'No model calls.', appendSystemPrompt: [],
    skillPaths: [], disableHooks: true, reportsProviderQuota: false,
    pluginMcpServers: [], env: {}, streamDeltas: false,
  };
}

const start = {
  main: (request: PiSessionRequest) => createPiRuntime(request, { onEvent: () => {} }),
  child: (request: PiSessionRequest) => createChildSession({ ...request, extensions: [] }),
};

for (const kind of ['main', 'child'] as const) {
  test.each([undefined, 'C:/explicit/bash.exe'])(`${kind} real SDK consumes shellPath (%s)`, async (explicit) => {
    const request = requestFor(explicit);
    const handle = await start[kind](request);
    try {
      const session = handle.session as sdk.AgentSession;
      expect(session.settingsManager.getShellPath()).toBe(explicit ?? selected);
      // Exercise SDK /reload, including rebuilding the Bash tool from runtime settings.
      await session.reload();
      expect(session.settingsManager.getShellPath()).toBe(explicit ?? selected);
      const bash = session.agent.state.tools.find(tool => tool.name === 'bash')!;
      // Deliberately nonexistent Windows fixture: SDK resolves our exact path and fails before
      // spawning anything. This tests actual tool construction, not a mocked settings consumer.
      await expect(bash.execute('probe', { command: 'printf harmless' })).rejects.toThrow(
        `Custom shell path not found: ${explicit ?? selected}`,
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await handle.dispose();
    }
  });
}

test('PI parent/child env and SDK Bash spawn hook preserve selected Node/npm/Git PATH', async () => {
  const request = requestFor();
  const parent = buildPiEnv({ piAgentDir: request.agentDir });
  const child = buildChildEnv(parent, request.agentDir);
  for (const env of [parent, child]) {
    expect(env.PATH).toBe(selectedPath);
    expect(env.CORTEX_GIT_BASH_PATH).toBe(selected);
  }
  const bash = sdk.createBashTool(request.cwd, { spawnHook: context => {
    // PI prepends its bin directory, but must retain the native-selected PATH intact.
    expect(context.env.PATH?.endsWith(selectedPath)).toBe(true);
    expect(context.env.CORTEX_GIT_BASH_PATH).toBe(selected);
    throw new Error('probe stopped before shell/profile execution');
  } });
  await expect(bash.execute('env-probe', { command: 'printf harmless' })).rejects.toThrow(
    'probe stopped before shell/profile execution',
  );
});
