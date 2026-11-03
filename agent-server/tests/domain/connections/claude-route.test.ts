import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeConnections } from '../../../src/core/connections-file.js';
import { resolveClaudeRoute } from '../../../src/domain/connections/claude-route.js';

let dir: string;

function deps(login: boolean, env: NodeJS.ProcessEnv = {}) {
  const claudeConfigDir = path.join(dir, login ? 'claude-login' : 'claude-empty');
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  if (login) {
    fs.writeFileSync(path.join(claudeConfigDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3_600_000 } }));
  }
  return { file: path.join(dir, 'connections.json'), claude: { claudeConfigDir, env, platform: 'linux' as const } };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-route-'));
  writeConnections([
    { id: 'official', backend: 'claude', label: 'official', authStyle: 'x-api-key', key: 'fake-official-key', billing: 'metered' },
    { id: 'relay', backend: 'claude', label: 'relay', baseUrl: 'https://relay.example.com', authStyle: 'bearer',
      key: 'fake-relay-key', billing: 'metered' },
  ], path.join(dir, 'connections.json'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('resolveClaudeRoute on an account', () => {
  it('runs on the account\'s own config dir and lets no credential variable through', () => {
    const file = path.join(dir, 'connections.json');
    writeConnections([{ id: 'school', backend: 'claude', type: 'account', label: 'School' }], file);
    const sharedDir = path.join(dir, 'shared');
    const accountsDir = path.join(dir, 'accounts');
    fs.mkdirSync(sharedDir);
    const route = resolveClaudeRoute('school', {
      ...deps(true, { CLAUDE_CODE_OAUTH_TOKEN: 'fake-static-token' }), accountDir: { sharedDir, accountsDir },
    });
    expect(route).toEqual({
      connection: 'school', sets: {}, configDir: path.join(accountsDir, 'school'),
      unsets: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    });
    expect(fs.lstatSync(path.join(accountsDir, 'school', 'projects')).isSymbolicLink()).toBe(true);
  });
});

describe('resolveClaudeRoute', () => {
  it('runs the subscription on Claude\'s own login, clearing every routing variable', () => {
    expect(resolveClaudeRoute('subscription', deps(true))).toEqual({
      connection: 'subscription', sets: {},
      unsets: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    });
  });

  it('carries a legacy static token only while Claude\'s store holds nothing', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'fake-static-token' };
    expect(resolveClaudeRoute('subscription', deps(false, env)).sets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-static-token' });
    expect(resolveClaudeRoute('subscription', deps(true, env)).sets).toEqual({});
  });

  it('sends an x-api-key connection to the official API with ANTHROPIC_API_KEY', () => {
    expect(resolveClaudeRoute('official', deps(true))).toEqual({
      connection: 'official', sets: { ANTHROPIC_API_KEY: 'fake-official-key' },
      unsets: ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    });
  });

  it('sends a bearer relay to its URL with ANTHROPIC_AUTH_TOKEN', () => {
    expect(resolveClaudeRoute('relay', deps(true))).toEqual({
      connection: 'relay', baseUrl: 'https://relay.example.com', sets: { ANTHROPIC_AUTH_TOKEN: 'fake-relay-key' },
      unsets: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    });
  });

  it('runs a selection naming no connection on the default one', () => {
    expect(resolveClaudeRoute(null, deps(true)).connection).toBe('subscription');
    expect(resolveClaudeRoute(null, deps(false)).connection).toBe('official');
  });

  it('refuses a connection that does not exist rather than falling back to another account', () => {
    expect(() => resolveClaudeRoute('gone', deps(true))).toThrow(/'gone' is not configured/);
  });

  it('still routes a host with no Claude connection to the subscription, so Claude reports the missing login', () => {
    fs.rmSync(path.join(dir, 'connections.json'));
    expect(resolveClaudeRoute(null, deps(false)).connection).toBe('subscription');
  });
});
