import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  agentBrowserArgs, agentBrowserBaseEnv, agentBrowserBinaryName, agentBrowserCallEnv, agentBrowserSessionName,
  isTabGone, resolveAgentBrowserBin, AgentBrowserMissingError,
} from '../../../src/platform/browser/agent-browser.js';

describe('agentBrowserBinaryName', () => {
  it('maps the host to the packaged native binary', () => {
    expect(agentBrowserBinaryName('linux', 'x64', () => false)).toBe('agent-browser-linux-x64');
    expect(agentBrowserBinaryName('linux', 'arm64', () => true)).toBe('agent-browser-linux-musl-arm64');
    expect(agentBrowserBinaryName('darwin', 'arm64')).toBe('agent-browser-darwin-arm64');
    expect(agentBrowserBinaryName('win32', 'arm64')).toBe('agent-browser-win32-x64.exe');
    expect(agentBrowserBinaryName('freebsd', 'x64')).toBeNull();
  });
});

describe('resolveAgentBrowserBin', () => {
  it('resolves the pinned dependency and makes it executable', () => {
    const bin = resolveAgentBrowserBin({});
    expect(path.basename(bin)).toBe(agentBrowserBinaryName());
    expect(() => fs.accessSync(bin, fs.constants.X_OK)).not.toThrow();
  });

  it('honours the override, and names it when it is wrong', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-')), 'agent-browser');
    fs.writeFileSync(file, '');
    expect(resolveAgentBrowserBin({ CORTEX_AGENT_BROWSER_BIN: file })).toBe(file);
    const missing = (() => {
      try { resolveAgentBrowserBin({ CORTEX_AGENT_BROWSER_BIN: `${file}-gone` }); } catch (e) { return e; }
      return null;
    })() as AgentBrowserMissingError;
    expect(missing).toBeInstanceOf(AgentBrowserMissingError);
    expect(missing.message).toContain('does not exist');
    expect(missing.hint).toContain('CORTEX_AGENT_BROWSER_BIN');
  });
});

describe('session naming and arguments', () => {
  it('derives a filesystem-safe agent-browser session from session and device', () => {
    expect(agentBrowserSessionName('2906c633-7e52-4b4a-99a3-9c3deed0e98b', 'server'))
      .toBe('cortex-2906c633-7e52-4b4a-99a3-9c3deed0e98b-server');
    expect(agentBrowserSessionName('exec/../x', 'my pc')).toBe('cortex-execx-mypc');
  });

  it('puts the attach flags on every call', () => {
    expect(agentBrowserArgs('http://127.0.0.1:9222', 'cortex-a-server', ['open', 'x']))
      .toEqual(['--cdp', 'http://127.0.0.1:9222', '--session', 'cortex-a-server', '--pin-tab', 'open', 'x']);
  });

  it('recognizes a tab_gone failure in plain and JSON output', () => {
    expect(isTabGone('✗ tab_gone: bound tab is gone (target X)')).toBe(true);
    expect(isTabGone('{"success":false,"code":"tab_gone"}')).toBe(true);
    expect(isTabGone('✗ Navigation failed')).toBe(false);
  });
});

describe('environment', () => {
  it('passes only the allowlist and pins the socket directory', () => {
    const env = agentBrowserBaseEnv({
      PATH: '/bin', HOME: '/h', LC_ALL: 'C', XDG_RUNTIME_DIR: '/run/user/1',
      CORTEX_WEBHOOK_TOKEN: 'secret', SLACK_BOT_TOKEN: 'x', ANTHROPIC_API_KEY: 'k',
      AGENT_BROWSER_MAX_OUTPUT: '500', AGENT_BROWSER_SESSION: 'other',
    });
    expect(env).toEqual({
      PATH: '/bin', HOME: '/h', LC_ALL: 'C', XDG_RUNTIME_DIR: '/run/user/1',
      AGENT_BROWSER_MAX_OUTPUT: '500', AGENT_BROWSER_SOCKET_DIR: '/run/user/1/agent-browser',
    });
    expect(agentBrowserBaseEnv({ HOME: '/h' }).AGENT_BROWSER_SOCKET_DIR).toBe('/h/.agent-browser');
    expect(agentBrowserBaseEnv({ AGENT_BROWSER_SOCKET_DIR: '/s' }).AGENT_BROWSER_SOCKET_DIR).toBe('/s');
  });

  it("lets a caller tune output but not redirect the daemon", () => {
    const env = agentBrowserCallEnv({ PATH: '/bin', AGENT_BROWSER_SOCKET_DIR: '/run/ab' }, {
      AGENT_BROWSER_MAX_OUTPUT: '100', AGENT_BROWSER_SOCKET_DIR: '/elsewhere', AGENT_BROWSER_CDP: '9999',
      CORTEX_CLIENT_TOKEN: 't',
    });
    expect(env).toEqual({ PATH: '/bin', AGENT_BROWSER_SOCKET_DIR: '/run/ab', AGENT_BROWSER_MAX_OUTPUT: '100' });
  });
});
