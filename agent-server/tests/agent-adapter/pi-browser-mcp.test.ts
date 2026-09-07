// input:  AgentSpawnConfig with and without a browser CDP endpoint, on the PI session path
// output: pinned opt-in behaviour of the Playwright MCP layer for the PI backend
// pos:    tests for per-session browser control on the backend that has no --mcp-config
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import {
  buildSessionRequest, sessionIdentity, type PiSessionRequest,
} from '../../src/agent-adapter/pi/session-options.js';
import type { AgentSpawnConfig, McpComposition } from '../../src/agent-adapter/types.js';
import { browserMcpServer, BROWSER_MCP_SERVER_NAME } from '../../src/agent-adapter/browser-mcp-server.js';

const ENDPOINT = 'http://127.0.0.1:9222';

function request(extra: Partial<AgentSpawnConfig>, composition: McpComposition = 'direct'): PiSessionRequest {
  return buildSessionRequest(
    { sessionId: 's', sessionKey: 'k', resume: false, mcpComposition: composition, ...extra },
    { agentDir: '/tmp/pi-agent', sessionDir: '/tmp/pi-sessions', sessionPath: null, cwd: '/tmp', streamDeltas: true },
  );
}

describe('browser MCP on the PI backend', () => {
  it('hands the session no plugin server at all when nothing asked for one', () => {
    // PI has no --mcp-config; the plugin server list IS the mechanism, so an empty list is the
    // off state.
    expect(request({}).pluginMcpServers).toEqual([]);
  });

  it('hands the session only the browser when that is the only server', () => {
    // An earlier guard skipped the plugin handoff when the plugin list was empty; a browser-only
    // session has exactly that shape, so it would have silently got no tools.
    const servers = request({ browserCdpEndpoint: ENDPOINT }).pluginMcpServers;
    expect(servers.map((s) => s.name)).toEqual([BROWSER_MCP_SERVER_NAME]);
    expect(servers[0].type === 'stdio' ? servers[0].args : []).toContain(ENDPOINT);
  });

  it('appends the browser after the plugin servers rather than replacing them', () => {
    const plugin = { name: 'other', type: 'stdio' as const, command: 'true', args: [], env: {}, cwd: '/tmp' };
    const servers = request({ browserCdpEndpoint: ENDPOINT, mcpServers: [plugin] }).pluginMcpServers;
    expect(servers.map((s) => s.name)).toEqual(['other', BROWSER_MCP_SERVER_NAME]);
  });

  it('refuses the browser outside a direct session', () => {
    // An unattended worker sharing one browser is a cross-run side channel, not a feature — the
    // same reason the Claude path gates on `direct`.
    const servers = request({ browserCdpEndpoint: ENDPOINT }, 'thread-control').pluginMcpServers;
    expect(servers.some((s) => s.name === BROWSER_MCP_SERVER_NAME)).toBe(false);
  });

  it('changes the session identity when the endpoint changes, retiring a pooled session', () => {
    // The pool reuses a live session only for an identical request, so a new endpoint is what
    // makes it drop the old session instead of reusing one bound to a dead browser.
    const a = sessionIdentity(request({ browserCdpEndpoint: ENDPOINT }));
    const b = sessionIdentity(request({ browserCdpEndpoint: 'http://127.0.0.1:9333' }));
    expect(a).not.toBe(b);
    expect(a).toBe(sessionIdentity(request({ browserCdpEndpoint: ENDPOINT })));
  });

  it('shares one descriptor with the Claude path', () => {
    const servers = request({ browserCdpEndpoint: ENDPOINT }).pluginMcpServers;
    expect(servers[0]).toEqual(browserMcpServer(ENDPOINT));
  });
});
