// An account route differs from the default subscription only in its config dir: neither carries a
// credential variable. The pool identity and the child env must both see that difference, or a
// connection switch reuses the process still signed in to the previous account.
import { describe, expect, it } from 'vitest';
import { claudeSpecIdentity } from '../../src/agent-adapter/claude/adapter.js';
import { claudeProcessLaunch, sessionOptionsFromSpec } from '../../src/agent-adapter/claude/session-options.js';
import { buildClaudeEnv, claudeRouteIdentity } from '../../src/agent-adapter/claude/spawn-args.js';
import { CLAUDE_CONFIG_HOME } from '../../src/core/paths.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

const CLEARED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
const ACCOUNT_DIR = '/tmp/cortex-test/claude-accounts/school';

function accountSpec(connection: string, configDir?: string) {
  const spec = engineSpecFixture({ sessionKey: 'k', connection, unsetEnv: CLEARED });
  if (configDir) spec.route.claudeConfigDir = configDir;
  return spec;
}

describe('the route identity of an account', () => {
  it('differs from the subscription and from another account', () => {
    const subscription = claudeRouteIdentity({ unsetEnv: CLEARED, connection: 'subscription' });
    const school = claudeRouteIdentity({ unsetEnv: CLEARED, connection: 'school', configDir: ACCOUNT_DIR });
    const lab = claudeRouteIdentity({ unsetEnv: CLEARED, connection: 'lab', configDir: '/tmp/x/lab' });
    expect(new Set([subscription, school, lab]).size).toBe(3);
    expect(school).toBe(claudeRouteIdentity({ unsetEnv: CLEARED, connection: 'school', configDir: ACCOUNT_DIR }));
  });

  it('keeps a route that names neither unchanged', () => {
    expect(claudeRouteIdentity({ unsetEnv: CLEARED })).toBe(
      'deleted ANTHROPIC_API_KEY=deleted ANTHROPIC_AUTH_TOKEN=deleted CLAUDE_CODE_OAUTH_TOKEN=deleted');
  });

  it('separates two specs that differ only in the account', () => {
    expect(claudeSpecIdentity(accountSpec('subscription'))).not.toBe(claudeSpecIdentity(accountSpec('school', ACCOUNT_DIR)));
  });
});

describe('the child env of an account', () => {
  it('sets CLAUDE_CONFIG_DIR to the account dir, else Cortex\'s own', () => {
    expect(buildClaudeEnv('C1', 's1', null, null, undefined, undefined, undefined, undefined, CLEARED, ACCOUNT_DIR)
      .CLAUDE_CONFIG_DIR).toBe(ACCOUNT_DIR);
    expect(buildClaudeEnv('C1', 's1').CLAUDE_CONFIG_DIR).toBe(CLAUDE_CONFIG_HOME);
  });

  it('carries the account dir from the spec to the launch', () => {
    const options = sessionOptionsFromSpec(accountSpec('school', ACCOUNT_DIR));
    expect(options.configDir).toBe(ACCOUNT_DIR);
    const { env } = claudeProcessLaunch({ channel: 'C1', sessionId: 's1', needsResume: false, options });
    expect(env.CLAUDE_CONFIG_DIR).toBe(ACCOUNT_DIR);
    for (const name of CLEARED) expect(env[name]).toBeUndefined();
  });
});
