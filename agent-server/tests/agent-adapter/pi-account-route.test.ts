// A PI selection on an account runs over the account's own agent dir: the spec carries the dir,
// the adapter builds the session over it (a different pooled identity from the default login),
// and the catalog written there is the account's.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { PI_HOME_AGENT_DIR_ENV } from '../../src/agent-adapter/pi/session-options.js';
import type { PiProviderCatalog } from '../../src/agent-adapter/pi/providers-config.js';
import { writeConnections } from '../../src/core/connections-file.js';
import { PI_ACCOUNTS_HOME } from '../../src/core/paths.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';
import { specFromFixture } from '../run-request-fixture.js';

const HOME = process.env.CORTEX_HOME!;

function adapter(catalogDirs: string[]): PIAdapter {
  return new PIAdapter(undefined, path.join(HOME, 'sessions-pi'), {
    agentDir: path.join(HOME, 'pi-home'),
    catalog: (agentDir): PiProviderCatalog => {
      catalogDirs.push(agentDir);
      return { providers: {}, runtimeKeys: {} };
    },
  });
}

function identityOf(pi: PIAdapter, spec: ReturnType<typeof engineSpecFixture>): Record<string, any> {
  return JSON.parse(pi.specIdentity(spec));
}

describe('a PI spec on an account', () => {
  it('runs over the account dir, with the adapter\'s own dir left for children on other providers', () => {
    const pi = adapter([]);
    const own = engineSpecFixture({ sessionKey: 'k', piProvider: 'deepseek', model: 'deepseek-v4' });
    const accountDir = path.join(HOME, 'pi-accounts-test', 'deepseek-work');
    const onAccount = { ...own, route: { connection: 'deepseek-work', piAgentDir: accountDir } };
    const ownIdentity = identityOf(pi, own);
    const accountIdentity = identityOf(pi, onAccount);
    expect(ownIdentity.agentDir).toBe(pi.agentDir);
    expect(accountIdentity.agentDir).toBe(accountDir);
    const env = Object.fromEntries(accountIdentity.env as Array<[string, string]>);
    expect(env.PI_CODING_AGENT_DIR).toBe(accountDir);
    expect(env[PI_HOME_AGENT_DIR_ENV]).toBe(pi.agentDir);
    expect(Object.fromEntries(ownIdentity.env)[PI_HOME_AGENT_DIR_ENV]).toBeUndefined();
  });

  it('writes the catalog of the dir it is asked for', () => {
    const dirs: string[] = [];
    const pi = adapter(dirs);
    const accountDir = path.join(HOME, 'pi-accounts-test', 'codex-lab');
    pi.ensureCatalog(accountDir);
    pi.ensureCatalog();
    expect(dirs).toEqual([accountDir, pi.agentDir]);
    expect(fs.existsSync(path.join(accountDir, 'models.json'))).toBe(true);
  });
});

describe('the engine spec of a PI selection', () => {
  it('names the account\'s dir and connection only for a confirmed account of its provider', () => {
    writeConnections([
      { id: 'deepseek-work', backend: 'pi', type: 'account', provider: 'deepseek', label: 'Work' },
      { id: 'half', backend: 'pi', type: 'account', provider: 'deepseek', label: 'Pending', pending: true },
    ]);
    const pick = { backend: 'pi' as const, provider: 'deepseek', model: 'deepseek-v4' };
    const onAccount = specFromFixture({}, { ...pick, connection: 'deepseek-work' });
    expect(onAccount.route).toEqual({
      connection: 'deepseek-work', piAgentDir: path.join(PI_ACCOUNTS_HOME, 'deepseek-work'),
    });
    expect(fs.existsSync(path.join(PI_ACCOUNTS_HOME, 'deepseek-work'))).toBe(true);
    for (const connection of [null, 'half', 'gone']) {
      expect(specFromFixture({}, { ...pick, connection }).route.piAgentDir).toBeUndefined();
    }
    expect(specFromFixture({}, { ...pick, provider: 'openai', connection: 'deepseek-work' }).route.piAgentDir)
      .toBeUndefined();
  });
});
