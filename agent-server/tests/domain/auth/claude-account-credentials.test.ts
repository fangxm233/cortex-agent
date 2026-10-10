import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, test } from 'vitest';
import { loadClaudeAccountCredentials } from '../../../src/domain/auth/claude-account-credentials.js';

const CLAUDE_DIR = '/fixture/.claude';
const LOGIN = path.join(CLAUDE_DIR, '.credentials.json');
const CONFIG = path.join(CLAUDE_DIR, '.claude.json');
const NOW_MS = 1_790_000_000_000;

function reader(files: Record<string, string>) {
  return (filePath: string): string => {
    const content = files[filePath];
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  };
}

const login = (expiresAt = NOW_MS + 3_600_000) => JSON.stringify({ claudeAiOauth: { accessToken: 'login-token', expiresAt } });
const config = JSON.stringify({ oauthAccount: { organizationUuid: 'org-1234' } });

function load(files: Record<string, string>, cliVersion: () => Promise<string | null> = async () => '2.1.280') {
  return loadClaudeAccountCredentials({
    env: {}, claudeConfigDir: CLAUDE_DIR, readFile: reader(files), now: () => NOW_MS, cliVersion,
  });
}

describe('loadClaudeAccountCredentials', () => {
  test("Claude's login token, its organization and the installed Claude Code identity", async () => {
    const credentials = await load({ [LOGIN]: login(), [CONFIG]: config });

    assert.equal(credentials?.organizationUuid, 'org-1234');
    assert.equal(credentials?.headers.authorization, 'Bearer login-token');
    assert.equal(credentials?.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(credentials?.userAgent, 'claude-cli/2.1.280 (external, cli)');
  });

  test('an unknown Claude Code version still names the client', async () => {
    const credentials = await load({ [LOGIN]: login(), [CONFIG]: config }, async () => null);
    assert.equal(credentials?.userAgent, 'claude-cli (external, cli)');
  });

  test.each([
    ['no login', { [CONFIG]: config }],
    ['an expired login Cortex cannot refresh', { [LOGIN]: login(NOW_MS - 1), [CONFIG]: config }],
    ['no organization on record', { [LOGIN]: login(), [CONFIG]: JSON.stringify({ oauthAccount: {} }) }],
    ['an unreadable config', { [LOGIN]: login(), [CONFIG]: '{not json' }],
  ])('%s means signed out', async (_case, files) => {
    let asked = false;
    assert.equal(await load(files, async () => { asked = true; return '2.1.280'; }), null);
    assert.equal(asked, false, 'the CLI is not run without a usable login');
  });

  test('an API key is not an account login', async () => {
    const credentials = await loadClaudeAccountCredentials({
      env: { ANTHROPIC_API_KEY: 'sk-ant-real' }, claudeConfigDir: CLAUDE_DIR,
      readFile: reader({ [CONFIG]: config }), now: () => NOW_MS, cliVersion: async () => '2.1.280',
    });
    assert.equal(credentials, null);
  });
});
