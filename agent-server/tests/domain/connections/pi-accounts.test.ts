// A PI account is an agent dir of its own: listed while its auth.json holds a credential for its
// provider, billed as that credential (an OAuth login a subscription, an API key metered).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeConnections } from '../../../src/core/connections-file.js';
import { createCredentialInventory } from '../../../src/domain/connections/inventory.js';
import {
  ensurePiAccountDir, piAccountAuthType, piAccountOfDir, removePiAccountDir,
} from '../../../src/domain/connections/pi-account-dir.js';

let dir: string;
let file: string;
let accountsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-accounts-'));
  file = path.join(dir, 'connections.json');
  accountsDir = path.join(dir, 'pi-accounts');
  writeConnections([
    { id: 'deepseek-work', backend: 'pi', type: 'account', provider: 'deepseek', label: 'Work' },
    { id: 'codex-lab', backend: 'pi', type: 'account', provider: 'openai-codex', label: 'Lab' },
    { id: 'gone', backend: 'pi', type: 'account', provider: 'deepseek', label: 'Signed out' },
    { id: 'half', backend: 'pi', type: 'account', provider: 'deepseek', label: 'Pending', pending: true },
  ], file);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function signIn(id: string, provider: string, type: 'api_key' | 'oauth'): void {
  const agentDir = ensurePiAccountDir(id, { accountsDir });
  const credential = type === 'api_key' ? { type, key: 'fake-key' } : { type, access: 'fake', refresh: 'fake', expires: 1 };
  fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ [provider]: credential }));
}

describe('a PI account dir', () => {
  it('is created with the SSE transport pinned, and removed whole', () => {
    const agentDir = ensurePiAccountDir('deepseek-work', { accountsDir });
    expect(agentDir).toBe(path.join(accountsDir, 'deepseek-work'));
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).transport).toBe('sse');
    removePiAccountDir('deepseek-work', { accountsDir });
    expect(fs.existsSync(agentDir)).toBe(false);
  });

  it('knows the credential type it holds for its own provider only', () => {
    signIn('deepseek-work', 'deepseek', 'api_key');
    expect(piAccountAuthType({ id: 'deepseek-work', provider: 'deepseek' }, { accountsDir })).toBe('api_key');
    expect(piAccountAuthType({ id: 'deepseek-work', provider: 'openai' }, { accountsDir })).toBeNull();
    expect(piAccountAuthType({ id: 'gone', provider: 'deepseek' }, { accountsDir })).toBeNull();
  });

  it('maps an agent dir back to its account, and no other dir', () => {
    expect(piAccountOfDir(path.join(accountsDir, 'codex-lab'), { accountsDir, file })?.provider).toBe('openai-codex');
    expect(piAccountOfDir(path.join(accountsDir, 'unknown'), { accountsDir, file })).toBeNull();
    expect(piAccountOfDir(path.join(dir, 'pi'), { accountsDir, file })).toBeNull();
  });

  it('rejects an id that is not a connection id', () => {
    expect(() => ensurePiAccountDir('../escape', { accountsDir })).toThrow(/Invalid account id/);
  });
});

describe('PI accounts in the inventory', () => {
  it('lists the signed-in accounts per provider, billed by their credential', () => {
    signIn('deepseek-work', 'deepseek', 'api_key');
    signIn('codex-lab', 'openai-codex', 'oauth');
    signIn('half', 'deepseek', 'api_key');
    const inventory = createCredentialInventory({
      file, piAccountsDir: accountsDir, piAuthPath: path.join(dir, 'default-auth.json'),
    });
    expect(inventory.piAccounts('deepseek').map((view) => [view.id, view.kind, view.billing]))
      .toEqual([['deepseek-work', 'account', 'metered']]);
    expect(inventory.piAccounts().map((view) => view.id)).toEqual(['deepseek-work', 'codex-lab']);
    expect(inventory.list().filter((view) => view.kind === 'account').map((view) => view.id))
      .toEqual(['deepseek-work', 'codex-lab']);
    expect(inventory.piConnections()).toEqual([]);
    expect(inventory.billingOf({ backend: 'pi', provider: 'openai-codex', connection: 'codex-lab' })).toBe('subscription');
    expect(inventory.billingOf({ backend: 'pi', provider: 'deepseek', connection: 'deepseek-work' })).toBe('metered');
  });
});
