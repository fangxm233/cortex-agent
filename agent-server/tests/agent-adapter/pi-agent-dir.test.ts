import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  ensurePIAgentRoles,
  ensureQuotaVisibleTransport,
  ensureCompactionReserve,
} from '../../src/agent-adapter/pi/agent-dir.js';
import {
  applyRuntimeKeys,
  readRuntimeKeys,
  writeProviderCatalog,
  type PiProviderCatalog,
} from '../../src/agent-adapter/pi/providers-config.js';
import { PI_AGENT_DIR, piAuthPath } from '../../src/agent-adapter/pi/defaults.js';

// ─── writeProviderCatalog: the per-agent-dir catalog and runtime keys ──────────────

const NO_OAUTH: ReadonlySet<string> = new Set();

function withAgentDir(run: (agentDir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-models-'));
    try {
      await run(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

function writeAndRead(agentDir: string, catalog: PiProviderCatalog): Record<string, any> {
  writeProviderCatalog(catalog, { agentDir, oauthProviders: NO_OAUTH });
  return JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf-8')).providers;
}

test('writeProviderCatalog: writes one block per catalog provider, base URLs as given', withAgentDir((agentDir) => {
  const providers = writeAndRead(agentDir, {
    providers: {
      anthropic: { baseUrl: 'https://relay.example.invalid/anthropic' },
      'openai-codex': { baseUrl: 'https://relay.example.invalid/codex' },
    },
    runtimeKeys: {},
  });
  assert.deepEqual(Object.keys(providers).sort(), ['anthropic', 'openai-codex']);
  assert.equal(providers.anthropic.baseUrl, 'https://relay.example.invalid/anthropic');
  assert.equal(providers['openai-codex'].baseUrl, 'https://relay.example.invalid/codex');
}));

test('writeProviderCatalog: an empty catalog is still written, so a stale one cannot keep routing', withAgentDir((agentDir) => {
  writeAndRead(agentDir, { providers: { anthropic: { baseUrl: 'https://old.example.invalid' } }, runtimeKeys: { anthropic: 'sk-old' } });
  assert.deepEqual(writeAndRead(agentDir, { providers: {}, runtimeKeys: {} }), {});
  assert.deepEqual(readRuntimeKeys(agentDir), {});
}));

test('writeProviderCatalog: keys go to models.json and runtime-keys.json, both owner-only', withAgentDir((agentDir) => {
  const providers = writeAndRead(agentDir, {
    providers: { deepseek: { baseUrl: 'https://relay.example.invalid/ds', apiKey: 'sk-fake-relay' } },
    runtimeKeys: { deepseek: 'sk-fake-relay' },
  });
  assert.equal(providers.deepseek.apiKey, 'sk-fake-relay');
  assert.deepEqual(readRuntimeKeys(agentDir), { deepseek: 'sk-fake-relay' });
  if (process.platform !== 'win32') {
    for (const name of ['models.json', 'runtime-keys.json']) {
      assert.equal(fs.statSync(path.join(agentDir, name)).mode & 0o777, 0o600, name);
    }
  }
}));

test('writeProviderCatalog: atomic — leaves no .tmp files on success', withAgentDir((agentDir) => {
  writeAndRead(agentDir, { providers: { anthropic: { baseUrl: 'https://relay.example.invalid' } }, runtimeKeys: {} });
  const tmpFiles = fs.readdirSync(agentDir).filter(f => f.includes('.tmp.'));
  assert.equal(tmpFiles.length, 0, `unexpected tmp files: ${tmpFiles.join(',')}`);
}));

test('writeProviderCatalog: a deepseek URL override gets the compat flags PI keys on its host', withAgentDir((agentDir) => {
  const providers = writeAndRead(agentDir, {
    providers: { deepseek: { baseUrl: 'https://relay.example.invalid/ds' } },
    runtimeKeys: {},
  });
  assert.equal(providers.deepseek.compat.supportsDeveloperRole, false);
  assert.equal(providers.deepseek.compat.maxTokensField, 'max_completion_tokens');
}));

test('writeProviderCatalog: fields beyond baseUrl on an override pass through', withAgentDir((agentDir) => {
  const modelOverrides = { 'deepseek-v4-flash': { maxTokens: 256 } };
  const providers = writeAndRead(agentDir, {
    providers: { deepseek: { baseUrl: 'https://relay.example.invalid/ds', modelOverrides } },
    runtimeKeys: {},
  });
  assert.deepEqual(providers.deepseek.modelOverrides, modelOverrides);
  assert.equal(providers.deepseek.apiKey, undefined);
}));

test('readRuntimeKeys: a missing or malformed file yields no keys', withAgentDir((agentDir) => {
  assert.deepEqual(readRuntimeKeys(agentDir), {});
  fs.writeFileSync(path.join(agentDir, 'runtime-keys.json'), '{not json');
  assert.deepEqual(readRuntimeKeys(agentDir), {});
  fs.writeFileSync(path.join(agentDir, 'runtime-keys.json'), JSON.stringify({ a: 'sk-fake', b: '', c: 7 }));
  assert.deepEqual(readRuntimeKeys(agentDir), { a: 'sk-fake' });
}));

test('applyRuntimeKeys: installs every written key on the runtime', withAgentDir(async (agentDir) => {
  writeProviderCatalog(
    { providers: {}, runtimeKeys: { deepseek: 'sk-fake-1', 'my-vllm': 'sk-fake-2' } },
    { agentDir, oauthProviders: NO_OAUTH },
  );
  const installed: Array<[string, string]> = [];
  await applyRuntimeKeys({ setRuntimeApiKey: async (provider, key) => { installed.push([provider, key]); } }, agentDir);
  assert.deepEqual(installed.sort(), [['deepseek', 'sk-fake-1'], ['my-vllm', 'sk-fake-2']]);
}));

// ─── piAuthPath: which auth.json an agent dir authenticates with ───

test('the daemon agent dir authenticates with PI\'s own store, never a copy beside it', () => {
  const userStore = path.join(os.homedir(), '.pi', 'agent', 'auth.json');
  assert.equal(piAuthPath(), userStore);
  assert.equal(piAuthPath(PI_AGENT_DIR), userStore);
  assert.equal(piAuthPath(`${PI_AGENT_DIR}${path.sep}`), userStore);
});

test('any other agent dir — a trial\'s — carries its own auth.json', () => {
  const trialDir = path.join(os.tmpdir(), 'cortex-trial-agent');
  assert.equal(piAuthPath(trialDir), path.join(trialDir, 'auth.json'));
});

// ─── built-in subagent roles ─────────────────────────────────────

test('ensurePIAgentRoles copies nothing when there is no legacy role dir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-roles-'));
  try {
    const rolesDir = path.join(tmpDir, 'roles');
    ensurePIAgentRoles({ rolesDir, legacyDir: path.join(tmpDir, 'pi', 'agents') });
    // The shipped roles are read in place; the user's table stays absent until they add one.
    assert.equal(fs.existsSync(rolesDir), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensurePIAgentRoles adopts a legacy PI-only role dir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-roles-legacy-'));
  try {
    const defaultsDir = path.join(tmpDir, 'defaults');
    const legacyDir = path.join(tmpDir, 'pi', 'agents');
    const rolesDir = path.join(tmpDir, 'roles');
    fs.mkdirSync(defaultsDir, { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });
    for (const name of ['explore', 'general-purpose', 'plan']) {
      fs.writeFileSync(path.join(defaultsDir, `${name}.md`), `---\nname: ${name}\ndescription: built in\n---\n${name}\n`);
    }
    fs.writeFileSync(path.join(legacyDir, 'explore.md'), 'user edited legacy role\n');
    fs.writeFileSync(path.join(legacyDir, 'mine.md'), 'a role only this user has\n');

    ensurePIAgentRoles({ defaultsDir, rolesDir, legacyDir });

    // The user's edits survive the move, and their own role comes along with them.
    assert.equal(fs.readFileSync(path.join(rolesDir, 'explore.md'), 'utf8'), 'user edited legacy role\n');
    assert.equal(fs.readFileSync(path.join(rolesDir, 'mine.md'), 'utf8'), 'a role only this user has\n');
    // Built-ins are read in place, never copied.
    assert.equal(fs.existsSync(path.join(rolesDir, 'plan.md')), false);
    // The old dir is renamed aside, so nobody keeps editing files that are no longer read.
    assert.equal(fs.existsSync(legacyDir), false);
    assert.equal(fs.existsSync(`${legacyDir}.migrated`), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── ensureQuotaVisibleTransport: keep the quota probe reachable ──

test('ensureQuotaVisibleTransport: pins SSE so the provider-response hook fires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-settings-'));
  try {
    ensureQuotaVisibleTransport({ agentDir: dir });
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
    assert.equal(settings.transport, 'sse');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureQuotaVisibleTransport: preserves settings PI wrote for itself', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ defaultThinkingLevel: 'high', transport: 'auto' }));
    ensureQuotaVisibleTransport({ agentDir: dir });
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepEqual(settings, { defaultThinkingLevel: 'high', transport: 'sse' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureQuotaVisibleTransport: leaves an already-pinned file untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ transport: 'sse' }));
    const before = fs.statSync(file).mtimeMs;
    ensureQuotaVisibleTransport({ agentDir: dir });
    assert.equal(fs.statSync(file).mtimeMs, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureQuotaVisibleTransport: recovers from an unreadable settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{ not json');
    ensureQuotaVisibleTransport({ agentDir: dir });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { transport: 'sse' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── ensureCompactionReserve: PI's own compaction headroom ──

test('ensureCompactionReserve: writes the reserve PI reads off its settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-settings-'));
  try {
    ensureCompactionReserve(32_768, { agentDir: dir });
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
    assert.deepEqual(settings.compaction, { reserveTokens: 32_768 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCompactionReserve: keeps sibling compaction keys and unrelated settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      transport: 'sse',
      compaction: { enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_384 },
    }));
    ensureCompactionReserve(65_536, { agentDir: dir });
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepEqual(settings, {
      transport: 'sse',
      compaction: { enabled: true, keepRecentTokens: 20_000, reserveTokens: 65_536 },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCompactionReserve: leaves the file untouched when the reserve already matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ compaction: { reserveTokens: 16_384 } }));
    const before = fs.statSync(file).mtimeMs;
    ensureCompactionReserve(16_384, { agentDir: dir });
    assert.equal(fs.statSync(file).mtimeMs, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
