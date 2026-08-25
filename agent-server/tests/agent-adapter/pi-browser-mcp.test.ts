// input:  AgentSpawnConfig with and without a browser CDP endpoint, on the PI spawn path
// output: pinned opt-in behaviour of the Playwright MCP layer for the PI backend
// pos:    tests for per-session browser control on the backend that has no --mcp-config
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { _test as piTest } from '../../src/agent-adapter/pi/adapter.js';
import { browserMcpServer, BROWSER_MCP_SERVER_NAME } from '../../src/agent-adapter/browser-mcp-server.js';

const ENDPOINT = 'http://127.0.0.1:9222';
const ENV_VAR = 'CORTEX_PI_PLUGIN_MCP_CONFIG_PATH';

function envelope(env: NodeJS.ProcessEnv): { mcpServers: Array<{ name: string; args?: string[] }> } | null {
  const p = env[ENV_VAR];
  if (!p || !fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function spawnEnv(extra: Record<string, unknown>): NodeJS.ProcessEnv {
  return piTest.buildSpawnEnvironment(
    { sessionId: 's', sessionKey: 'k', resume: false, ...extra } as never,
    '/tmp',
    'direct',
  );
}

describe('browser MCP on the PI backend', () => {
  it('writes no plugin envelope at all when nothing asked for one', () => {
    // PI has no --mcp-config; the envelope IS the mechanism, so its absence is the off state.
    expect(envelope(spawnEnv({}))).toBeNull();
  });

  it('writes an envelope holding only the browser when that is the only server', () => {
    // The pre-existing guard skipped the file when the plugin list was empty; a browser-only
    // session has exactly that shape, so it would have silently got no tools.
    const parsed = envelope(spawnEnv({ browserCdpEndpoint: ENDPOINT }));
    expect(parsed?.mcpServers.map((s) => s.name)).toEqual([BROWSER_MCP_SERVER_NAME]);
    expect(parsed?.mcpServers[0].args).toContain(ENDPOINT);
  });

  it('appends the browser after the plugin servers rather than replacing them', () => {
    const plugin = { name: 'other', type: 'stdio', command: 'true', args: [], env: {}, cwd: '/tmp' };
    const parsed = envelope(spawnEnv({ browserCdpEndpoint: ENDPOINT, mcpServers: [plugin] }));
    expect(parsed?.mcpServers.map((s) => s.name)).toEqual(['other', BROWSER_MCP_SERVER_NAME]);
  });

  it('refuses the browser outside a direct session', () => {
    // An unattended worker sharing one browser is a cross-run side channel, not a feature — the
    // same reason the Claude path gates on `direct`.
    const env = piTest.buildSpawnEnvironment(
      { sessionId: 's', sessionKey: 'k', resume: false, browserCdpEndpoint: ENDPOINT } as never,
      '/tmp',
      'thread-control',
    );
    const parsed = envelope(env);
    expect(parsed?.mcpServers.some((s) => s.name === BROWSER_MCP_SERVER_NAME) ?? false).toBe(false);
  });

  it('changes the config path when the endpoint changes, retiring a pooled process', () => {
    // PI's spawn identity hashes argv+env, so a new path is what makes the pool drop the old
    // subprocess instead of reusing one bound to a dead browser.
    const a = spawnEnv({ browserCdpEndpoint: ENDPOINT })[ENV_VAR];
    const b = spawnEnv({ browserCdpEndpoint: 'http://127.0.0.1:9333' })[ENV_VAR];
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('shares one descriptor with the Claude path', () => {
    const parsed = envelope(spawnEnv({ browserCdpEndpoint: ENDPOINT }));
    expect(parsed?.mcpServers[0]).toEqual(browserMcpServer(ENDPOINT));
  });
});
