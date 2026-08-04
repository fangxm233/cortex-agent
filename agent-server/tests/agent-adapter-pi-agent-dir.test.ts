// input:  agent-dir module, temporary provider/auth/role files
// output: PI provider, auth, and built-in role installation contracts
// pos:    Unit tests for PI managed agent directory helpers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  writeProvidersConfig,
  ensureAuthVisible,
  ensurePIAgentRoles,
  ensureQuotaVisibleTransport,
  buildProviderOverrides,
} from '../src/agent-adapter/pi/agent-dir.js';

// ─── writeProvidersConfig: multi-provider override ──────────────

test('writeProvidersConfig: writes one provider entry per ProviderOverride', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-models-'));
  try {
    const modelsPath = path.join(tmpDir, 'models.json');
    writeProvidersConfig(
      [
        { name: 'anthropic' },
        { name: 'deepseek' },
        { name: 'openai-codex' },
      ],
      'http://127.0.0.1:9880',
      { modelsPath },
    );
    const data = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
    assert.ok(data.providers.anthropic);
    assert.ok(data.providers.deepseek);
    assert.ok(data.providers['openai-codex']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProvidersConfig: each provider baseUrl points to gateway/<provider-name>', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-models-'));
  try {
    const modelsPath = path.join(tmpDir, 'models.json');
    writeProvidersConfig(
      [{ name: 'openai-codex' }, { name: 'deepseek' }],
      'http://127.0.0.1:9880',
      { modelsPath },
    );
    const data = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
    assert.equal(data.providers['openai-codex'].baseUrl, 'http://127.0.0.1:9880/openai-codex');
    assert.equal(data.providers.deepseek.baseUrl, 'http://127.0.0.1:9880/deepseek');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProvidersConfig: does NOT write apiKey field (let PI auth.json resolve)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-models-'));
  try {
    const modelsPath = path.join(tmpDir, 'models.json');
    writeProvidersConfig(
      [{ name: 'anthropic' }],
      'http://127.0.0.1:9880',
      { modelsPath },
    );
    const data = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
    assert.equal(data.providers.anthropic.apiKey, undefined,
      'apiKey must NOT be set — PI resolves from auth.json or env');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProvidersConfig: explicit basePath overrides default /<name>', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-models-'));
  try {
    const modelsPath = path.join(tmpDir, 'models.json');
    writeProvidersConfig(
      [{ name: 'deepseek', basePath: '/deepseek/anthropic' }],
      'http://127.0.0.1:9880',
      { modelsPath },
    );
    const data = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
    assert.equal(data.providers.deepseek.baseUrl, 'http://127.0.0.1:9880/deepseek/anthropic');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProvidersConfig: creates parent directory if missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-models-'));
  try {
    const modelsPath = path.join(tmpDir, 'nested', 'dir', 'models.json');
    writeProvidersConfig(
      [{ name: 'anthropic' }],
      'http://127.0.0.1:9880',
      { modelsPath },
    );
    assert.ok(fs.existsSync(modelsPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProvidersConfig: atomic — leaves no .tmp files on success', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-models-'));
  try {
    const modelsPath = path.join(tmpDir, 'models.json');
    writeProvidersConfig([{ name: 'anthropic' }], 'http://127.0.0.1:9880', { modelsPath });
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    assert.equal(tmpFiles.length, 0, `unexpected tmp files: ${tmpFiles.join(',')}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProvidersConfig: deepseek gets compat.supportsDeveloperRole=false (gateway hides deepseek.com so PI cannot auto-detect)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-models-'));
  try {
    const modelsPath = path.join(tmpDir, 'models.json');
    writeProvidersConfig([{ name: 'deepseek' }], 'http://127.0.0.1:9880', { modelsPath });
    const data = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
    assert.equal(data.providers.deepseek.compat.supportsDeveloperRole, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProvidersConfig: non-deepseek provider has NO compat field (no regression)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-models-'));
  try {
    const modelsPath = path.join(tmpDir, 'models.json');
    writeProvidersConfig([{ name: 'anthropic' }], 'http://127.0.0.1:9880', { modelsPath });
    const data = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
    assert.equal(data.providers.anthropic.compat, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProvidersConfig: explicit per-override compat merges over the static table', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-models-'));
  try {
    const modelsPath = path.join(tmpDir, 'models.json');
    writeProvidersConfig(
      [{ name: 'deepseek', compat: { supportsStore: false } }],
      'http://127.0.0.1:9880',
      { modelsPath },
    );
    const data = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
    // static table contributes supportsDeveloperRole, explicit override adds supportsStore
    assert.equal(data.providers.deepseek.compat.supportsDeveloperRole, false);
    assert.equal(data.providers.deepseek.compat.supportsStore, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── buildProviderOverrides: routing-driven override set ────────
// The set of providers whose baseUrl is overridden to the gateway is driven by what the
// spawn actually uses (current provider) UNION what PI reports having credentials for
// (discovered) — NOT by discovery alone. This lets a profile route through the gateway even
// when PI has no direct credentials (gateway injects managed keys).

test('buildProviderOverrides: unions discovered providers with the current provider', () => {
  const out = buildProviderOverrides(['deepseek', 'qwen-ksu'], 'anthropic', null);
  const names = out.map(o => o.name).sort();
  assert.deepEqual(names, ['anthropic', 'deepseek', 'qwen-ksu']);
});

test('buildProviderOverrides: does not duplicate when current provider is already discovered', () => {
  const out = buildProviderOverrides(['deepseek'], 'deepseek', null);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'deepseek');
});

test('buildProviderOverrides: applies gatewayPath as basePath to the current provider', () => {
  const out = buildProviderOverrides(['deepseek'], 'anthropic', '/deepseek-anthropic');
  const a = out.find(o => o.name === 'anthropic');
  assert.equal(a?.basePath, '/deepseek-anthropic');
});

test('buildProviderOverrides: gatewayPath overrides default path even when current provider was discovered', () => {
  const out = buildProviderOverrides(['deepseek'], 'deepseek', '/deepseek/anthropic');
  assert.equal(out.length, 1);
  assert.equal(out[0].basePath, '/deepseek/anthropic');
});

test('buildProviderOverrides: discovered providers get no explicit basePath (default /<name>)', () => {
  const out = buildProviderOverrides(['deepseek'], 'anthropic', null);
  const d = out.find(o => o.name === 'deepseek');
  assert.equal(d?.basePath, undefined);
});

test('buildProviderOverrides: returns discovered as-is when no current provider', () => {
  const out = buildProviderOverrides(['deepseek', 'qwen-ksu'], null, null);
  assert.deepEqual(out.map(o => o.name).sort(), ['deepseek', 'qwen-ksu']);
});

test('buildProviderOverrides: current provider alone when discovery is empty (gateway-managed creds)', () => {
  const out = buildProviderOverrides([], 'anthropic', null);
  assert.deepEqual(out.map(o => o.name), ['anthropic']);
});

// ─── ensureAuthVisible: symlink user's PI auth.json into cortex-private dir ───

test('ensureAuthVisible: no-op when user auth.json does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-auth-'));
  try {
    const userAuth = path.join(tmpDir, 'user-pi', 'auth.json');
    const agentDir = path.join(tmpDir, 'cortex-pi');
    fs.mkdirSync(agentDir, { recursive: true });
    ensureAuthVisible({ userAuthPath: userAuth, agentDir });
    assert.ok(!fs.existsSync(path.join(agentDir, 'auth.json')),
      'should not create cortex auth.json when source missing');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureAuthVisible: creates symlink on Linux/macOS when user auth.json exists', { skip: process.platform === 'win32' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-auth-'));
  try {
    const userAuth = path.join(tmpDir, 'user-pi', 'auth.json');
    fs.mkdirSync(path.dirname(userAuth), { recursive: true });
    fs.writeFileSync(userAuth, '{"deepseek": {"type":"api_key","key":"sk-test"}}');

    const agentDir = path.join(tmpDir, 'cortex-pi');
    ensureAuthVisible({ userAuthPath: userAuth, agentDir });

    const cortexAuth = path.join(agentDir, 'auth.json');
    assert.ok(fs.existsSync(cortexAuth));
    const stat = fs.lstatSync(cortexAuth);
    assert.ok(stat.isSymbolicLink(), 'should be symlink');
    assert.equal(fs.readlinkSync(cortexAuth), userAuth);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureAuthVisible: idempotent — re-run preserves existing correct symlink', { skip: process.platform === 'win32' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-auth-'));
  try {
    const userAuth = path.join(tmpDir, 'user-pi', 'auth.json');
    fs.mkdirSync(path.dirname(userAuth), { recursive: true });
    fs.writeFileSync(userAuth, '{}');
    const agentDir = path.join(tmpDir, 'cortex-pi');

    ensureAuthVisible({ userAuthPath: userAuth, agentDir });
    const firstInode = fs.lstatSync(path.join(agentDir, 'auth.json')).ino;

    ensureAuthVisible({ userAuthPath: userAuth, agentDir });
    const secondInode = fs.lstatSync(path.join(agentDir, 'auth.json')).ino;

    assert.equal(firstInode, secondInode, 'symlink should not be recreated when already correct');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureAuthVisible: replaces stale regular file with symlink', { skip: process.platform === 'win32' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-auth-'));
  try {
    const userAuth = path.join(tmpDir, 'user-pi', 'auth.json');
    fs.mkdirSync(path.dirname(userAuth), { recursive: true });
    fs.writeFileSync(userAuth, '{"deepseek":{"type":"api_key","key":"new"}}');

    const agentDir = path.join(tmpDir, 'cortex-pi');
    fs.mkdirSync(agentDir, { recursive: true });
    // Pre-existing regular file (e.g. stale auth from a previous Windows-mode copy)
    fs.writeFileSync(path.join(agentDir, 'auth.json'), '{"old":"data"}');

    ensureAuthVisible({ userAuthPath: userAuth, agentDir });

    const stat = fs.lstatSync(path.join(agentDir, 'auth.json'));
    assert.ok(stat.isSymbolicLink(), 'pre-existing regular file should be replaced with symlink');
    // Reading the file should now return the user-side content
    const content = fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf-8');
    assert.match(content, /new/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── built-in subagent roles ─────────────────────────────────────

test('ensurePIAgentRoles installs all roles once without clobbering user edits', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-roles-'));
  try {
    const defaultsDir = path.join(tmpDir, 'defaults');
    const agentDir = path.join(tmpDir, 'managed');
    fs.mkdirSync(defaultsDir, { recursive: true });
    for (const name of ['explore', 'general-purpose', 'plan']) {
      fs.writeFileSync(path.join(defaultsDir, `${name}.md`), `---\nname: ${name}\ndescription: built in\n---\n${name}\n`);
    }

    ensurePIAgentRoles({ defaultsDir, agentDir });
    const explorePath = path.join(agentDir, 'agents', 'explore.md');
    assert.equal(fs.readFileSync(explorePath, 'utf8').includes('built in'), true);
    for (const name of ['explore', 'general-purpose', 'plan']) {
      assert.equal(fs.existsSync(path.join(agentDir, 'agents', `${name}.md`)), true);
    }

    fs.writeFileSync(explorePath, 'user edited role\n');
    fs.writeFileSync(path.join(defaultsDir, 'explore.md'), 'new packaged default\n');
    const inode = fs.statSync(explorePath).ino;
    ensurePIAgentRoles({ defaultsDir, agentDir });

    assert.equal(fs.readFileSync(explorePath, 'utf8'), 'user edited role\n');
    assert.equal(fs.statSync(explorePath).ino, inode);
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
