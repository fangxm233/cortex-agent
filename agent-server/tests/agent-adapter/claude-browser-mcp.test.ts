// input:  AgentSpawnConfig with and without a browser CDP endpoint
// output: pinned opt-in behaviour of the Playwright MCP layer in the Claude spawn
// pos:    tests for per-session browser control
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { _test as adapterTest } from '../../src/agent-adapter/claude/adapter.js';
import { writeBrowserMcpConfig } from '../../src/agent-adapter/claude/browser-mcp.js';

const ENDPOINT = 'http://127.0.0.1:9222';

/** `--mcp-config` is variadic: every path until the next flag belongs to it. */
function mcpConfigs(args: string[]): string[] {
  const start = args.indexOf('--mcp-config');
  if (start < 0) return [];
  const rest = args.slice(start + 1);
  const end = rest.findIndex((a) => a.startsWith('--'));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The static config files are generated at daemon startup and absent in a bare test home; only the
 *  runtime-written ones (which is what this suite is about) exist on disk. */
function readableConfigs(args: string[]): Array<{ path: string; text: string }> {
  return mcpConfigs(args)
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
}

describe('browser MCP is opt-in per session', () => {
  it('adds no browser config when the session did not opt in', () => {
    const args = adapterTest.computeSpawnArgs({ sessionId: 'a', sessionKey: 'k', resume: false });
    expect(readableConfigs(args).filter((c) => c.text.includes('playwright'))).toEqual([]);
  });

  it('adds exactly one Playwright config bound to the endpoint when it did', () => {
    const args = adapterTest.computeSpawnArgs({
      sessionId: 'b', sessionKey: 'k', resume: false, browserCdpEndpoint: ENDPOINT,
    });
    const configs = readableConfigs(args).map((c) => JSON.parse(c.text));
    const playwright = configs.filter((c) => c.mcpServers?.playwright);
    expect(playwright).toHaveLength(1);
    const server = playwright[0].mcpServers.playwright;
    expect(server.command).toBe('npx');
    // The endpoint must be passed through verbatim: a mismatch silently launches a private browser
    // instead of attaching to the managed one.
    expect(server.args).toContain('--cdp-endpoint');
    expect(server.args).toContain(ENDPOINT);
    expect(server.args.join(' ')).toMatch(/@playwright\/mcp@\d+\.\d+\.\d+/); // pinned, never floating
  });

  it('refuses the browser layer outside a direct session', () => {
    // Thread and dispatch workers run unattended; a shared browser there is a side channel.
    for (const mcpComposition of ['thread-control', 'none'] as const) {
      const args = adapterTest.computeSpawnArgs({
        sessionId: 'c', sessionKey: 'k', resume: false, browserCdpEndpoint: ENDPOINT, mcpComposition,
      });
      expect(readableConfigs(args).filter((c) => c.text.includes('playwright'))).toEqual([]);
    }
  });
});

describe('writeBrowserMcpConfig identity', () => {
  it('is stable for the same endpoint and different for another', () => {
    const a = writeBrowserMcpConfig(ENDPOINT);
    const b = writeBrowserMcpConfig(ENDPOINT);
    const c = writeBrowserMcpConfig('http://127.0.0.1:9333');
    expect(a.identity).toBe(b.identity);
    expect(a.path).toBe(b.path);
    // The identity is the session-pool compatibility key: a changed endpoint MUST look different,
    // or a pooled process would keep talking to the old browser.
    expect(c.identity).not.toBe(a.identity);
  });

  it('writes the config private to this user', () => {
    const { path } = writeBrowserMcpConfig(ENDPOINT);
    expect(fs.statSync(path).mode & 0o077).toBe(0);
  });
});
