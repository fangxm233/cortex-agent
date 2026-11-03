import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claudeKeyConnections, parseConnections, piProviderConnections, readConnections, writeConnections,
  type StoredConnection,
} from '../../../src/core/connections-file.js';
import {
  accountId, confirmAccount, createPendingAccount, findAccount, pendingAccounts, removeAccountEntry,
} from '../../../src/domain/connections/accounts.js';
import { createCredentialInventory } from '../../../src/domain/connections/inventory.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-accounts-'));
  file = path.join(dir, 'connections.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function signIn(accountsDir: string, id: string): void {
  const configDir = path.join(accountsDir, id);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3_600_000 } }));
}

describe('account connections in the file', () => {
  it('parses Claude and PI accounts and drops malformed ones', () => {
    const parsed = parseConnections({ connections: [
      { id: 'school', backend: 'claude', type: 'account', label: 'School Team' },
      { id: 'codex-lab', backend: 'pi', type: 'account', provider: 'openai-codex', label: 'Lab', pending: true },
      { id: 'subscription', backend: 'claude', type: 'account', label: 'Reserved' },
      { id: 'nope', backend: 'pi', type: 'account', label: 'No provider' },
      { id: 'deepseek', backend: 'pi', type: 'account', provider: 'deepseek', label: 'Same as provider' },
    ] });
    expect(parsed).toEqual([
      { id: 'school', backend: 'claude', type: 'account', label: 'School Team' },
      { id: 'codex-lab', backend: 'pi', type: 'account', provider: 'openai-codex', label: 'Lab', pending: true },
    ]);
  });

  it('keeps accounts out of the key and provider connection lists', () => {
    const stored: StoredConnection[] = [
      { id: 'school', backend: 'claude', type: 'account', label: 'School' },
      { id: 'relay', backend: 'claude', label: 'Relay', authStyle: 'bearer', key: 'fake-relay-key-01', billing: 'metered' },
      { id: 'codex-lab', backend: 'pi', type: 'account', provider: 'openai-codex', label: 'Lab' },
      { id: 'openai', backend: 'pi', provider: 'openai', baseUrl: 'https://proxy.example.com/v1' },
    ];
    expect(claudeKeyConnections(stored).map((entry) => entry.id)).toEqual(['relay']);
    expect(piProviderConnections(stored).map((entry) => entry.id)).toEqual(['openai']);
  });
});

describe('account ids', () => {
  it('slugs the label and suffixes until free', () => {
    expect(accountId('School Team', new Set())).toBe('school-team');
    expect(accountId('School Team', new Set(['school-team', 'school-team-2']))).toBe('school-team-3');
    expect(accountId('学校', new Set())).toBe('account');
    expect(accountId('  --Lab ChatGPT!!  ', new Set())).toBe('lab-chatgpt');
  });

  it('never takes a reserved or existing id', () => {
    const first = createPendingAccount({ backend: 'claude', label: 'Subscription' }, { file });
    const second = createPendingAccount({ backend: 'claude', label: 'API' }, { file });
    const pi = createPendingAccount(
      { backend: 'pi', label: 'OpenAI', provider: 'openai-codex' }, { file, reservedIds: ['openai'] },
    );
    expect(first.ok && first.account.id).toBe('subscription-2');
    expect(second.ok && second.account.id).toBe('api-2');
    expect(pi.ok && pi.account.id).toBe('openai-2');
  });

  it('never takes an id another backend uses, a provider name, or a default login\'s name', () => {
    writeConnections([
      { id: 'relay', backend: 'claude', label: 'Relay', authStyle: 'x-api-key', key: 'fake-key', billing: 'metered' },
      { id: 'deepseek', backend: 'pi', provider: 'deepseek', baseUrl: 'https://relay.example', key: 'fake-key' },
      { id: 'work', backend: 'pi', type: 'account', provider: 'anthropic', label: 'Work' },
      { id: 'school', backend: 'claude', type: 'account', label: 'School' },
    ], file);
    const ids = [
      createPendingAccount({ backend: 'claude', label: 'Work' }, { file }),
      createPendingAccount({ backend: 'claude', label: 'DeepSeek' }, { file }),
      createPendingAccount({ backend: 'claude', label: 'Anthropic' }, { file, reservedIds: ['anthropic', 'openai'] }),
      createPendingAccount({ backend: 'pi', label: 'School', provider: 'anthropic' }, { file }),
      createPendingAccount({ backend: 'pi', label: 'Relay', provider: 'openai' }, { file }),
      createPendingAccount({ backend: 'pi', label: 'Subscription', provider: 'anthropic' }, { file }),
    ].map((created) => created.ok && created.account.id);
    expect(ids).toEqual(['work-2', 'deepseek-2', 'anthropic-2', 'school-2', 'relay-2', 'subscription-2']);
  });

  it('refuses an empty label and a PI account without a provider', () => {
    expect(createPendingAccount({ backend: 'claude', label: '  ' }, { file }))
      .toEqual({ ok: false, errors: ['label-required'] });
    expect(createPendingAccount({ backend: 'pi', label: 'x' }, { file }))
      .toEqual({ ok: false, errors: ['provider-required'] });
  });
});

describe('the pending lifecycle', () => {
  it('registers pending, confirms, and removes', () => {
    const created = createPendingAccount({ backend: 'claude', label: 'School' }, { file });
    expect(created).toEqual({ ok: true, account: { id: 'school', backend: 'claude', type: 'account', label: 'School', pending: true } });
    expect(pendingAccounts(file).map((entry) => entry.id)).toEqual(['school']);
    confirmAccount({ backend: 'claude', id: 'school' }, file);
    expect(findAccount({ backend: 'claude', id: 'school' }, file)).toEqual(
      { id: 'school', backend: 'claude', type: 'account', label: 'School' });
    expect(pendingAccounts(file)).toEqual([]);
    expect(removeAccountEntry({ backend: 'claude', id: 'school' }, file)).toBe(true);
    expect(readConnections(file)).toEqual([]);
  });

  it('removes only accounts', () => {
    writeConnections([{ id: 'relay', backend: 'claude', label: 'Relay', authStyle: 'bearer', key: 'fake-relay-key-01', billing: 'metered' }], file);
    expect(removeAccountEntry({ backend: 'claude', id: 'relay' }, file)).toBe(false);
    expect(readConnections(file)).toHaveLength(1);
  });
});

describe('accounts in the inventory', () => {
  function inventory(accountsDir: string) {
    const claudeConfigDir = path.join(dir, 'claude');
    fs.mkdirSync(claudeConfigDir, { recursive: true });
    return createCredentialInventory({
      file, claudeAccountsDir: accountsDir, claude: { claudeConfigDir, env: {}, platform: 'linux' },
    });
  }

  it('lists a Claude account only while it is signed in and confirmed', () => {
    const accountsDir = path.join(dir, 'accounts');
    writeConnections([
      { id: 'school', backend: 'claude', type: 'account', label: 'School' },
      { id: 'lab', backend: 'claude', type: 'account', label: 'Lab', pending: true },
      { id: 'other', backend: 'claude', type: 'account', label: 'Other' },
    ], file);
    signIn(accountsDir, 'school');
    signIn(accountsDir, 'lab');
    const views = inventory(accountsDir).claudeConnections();
    expect(views.map((view) => [view.id, view.kind, view.billing])).toEqual([['school', 'account', 'subscription']]);
    expect(inventory(accountsDir).defaultClaudeConnection()).toBe('school');
    expect(inventory(accountsDir).accounts().map((account) => account.id)).toEqual(['school', 'other']);
  });

  it('bills an account as a subscription even while it is signed out', () => {
    writeConnections([{ id: 'school', backend: 'claude', type: 'account', label: 'School' }], file);
    const billing = inventory(path.join(dir, 'accounts')).billingOf({ backend: 'claude', provider: null, connection: 'school' });
    expect(billing).toBe('subscription');
  });

  it('never finds a PI account as the provider connection', () => {
    writeConnections([{ id: 'codex-lab', backend: 'pi', type: 'account', provider: 'openai-codex', label: 'Lab' }], file);
    expect(inventory(path.join(dir, 'accounts')).findPi('openai-codex')).toBeNull();
  });
});
