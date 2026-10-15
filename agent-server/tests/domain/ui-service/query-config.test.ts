import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleConfigGet, readConfigSnapshot } from '../../../src/domain/ui-service/query/config.js';
import { SETTINGS_SPEC } from '../../../src/core/settings-spec.js';
import { resolveSettingsSnapshot } from '../../../src/core/settings.js';
import type { ConfigLang, EngineSelection } from '../../../src/domain/ui-service/types.js';
import { makeUiDeps } from './ui-deps-fixture.js';

const selection: EngineSelection = { backend: 'claude', provider: null, model: 'm1', thinking: 'high', mode: 'plan' };
const favorites = [
  { backend: 'claude', provider: null, model: 'm1' },
  { backend: 'pi', provider: 'deepseek', model: 'm2' },
];

const RAW_SECRET = 'sk-super-secret-value-123456';
const LANG: ConfigLang = { value: 'en', source: 'default' };

async function makeFixture(): Promise<{ configDir: string; hooksDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-fixture-'));
  const configDir = path.join(root, 'config');
  const hooksDir = path.join(root, 'hooks');
  await fs.mkdir(path.join(configDir, 'thread-templates', 'agents'), { recursive: true });
  await fs.mkdir(path.join(configDir, 'thread-templates', 'templates'), { recursive: true });
  await fs.mkdir(path.join(configDir, 'thread-templates', 'shells'), { recursive: true });
  await fs.mkdir(path.join(configDir, 'hooks'), { recursive: true });
  await fs.mkdir(hooksDir, { recursive: true });

  await fs.writeFile(path.join(configDir, 'budget.json'), JSON.stringify({ daily_usd: 100, monthly_usd: 2000 }));
  await fs.writeFile(
    path.join(configDir, 'models.json'),
    JSON.stringify({ default: selection, favorites }),
  );
  await fs.writeFile(
    path.join(configDir, 'machines.json'),
    JSON.stringify({
      hub: { cortexPath: '/x', gpuCount: 2 },
      lab: { cortexPath: '/y', gpuCount: 1, ssh: 'user@host', win: false },
    }),
  );
  await fs.writeFile(path.join(configDir, 'mcp-config.json'), JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }));
  await fs.writeFile(path.join(configDir, 'thread-templates', 'agents', 'coder.json'), '{}');
  await fs.writeFile(path.join(configDir, 'thread-templates', 'templates', 'coder-review.json'), JSON.stringify({
    hooks: { onEnd: { command: 'node review.mjs' } },
  }));
  await fs.writeFile(path.join(configDir, 'thread-templates', 'shells', 'default.json'), '{}');
  await fs.mkdir(path.join(configDir, 'environments'), { recursive: true });
  await fs.writeFile(path.join(configDir, 'environments', 'main.json'), JSON.stringify({
    name: 'main', description: 'General', profile: '__active__',
  }));
  await fs.writeFile(path.join(configDir, 'environments', 'creative.json'), JSON.stringify({
    name: 'creative', profile: 'fast',
  }));
  await fs.writeFile(path.join(configDir, 'hooks', '01-managed.json'), JSON.stringify({
    id: 'managed-hook', event: 'agent:pre-tool', run: { command: 'true' }, version: '2026.7.29',
  }));
  await fs.writeFile(path.join(configDir, 'hooks', '02-user.json'), JSON.stringify({
    id: 'user-hook', event: 'pi:message_end', run: { command: 'true' }, enabled: true,
  }));
  await fs.writeFile(path.join(configDir, 'hooks', '03-disabled.json'), JSON.stringify({
    id: 'disabled-hook', event: 'cc:Notification', run: { command: 'true' }, enabled: false,
  }));
  await fs.writeFile(path.join(configDir, '.env'), `# a comment\nSECRET_TOKEN=${RAW_SECRET}\nEMPTY_KEY=\nBASE_URL=https://api.example.com\n`);
  await fs.writeFile(path.join(hooksDir, 'my-hook.mjs'), '// executable asset, not a mounted declaration');
  return { configDir, hooksDir };
}

test('readConfigSnapshot surfaces per-project budgets and drops half-pair entries', async () => {
  const { configDir } = await makeFixture();
  await fs.writeFile(path.join(configDir, 'budget.json'), JSON.stringify({
    daily_usd: 100, monthly_usd: 2000,
    projects: {
      alpha: { daily_usd: 5, monthly_usd: 100 },
      halfPair: { daily_usd: 5 },
      notAnObject: 3,
    },
  }));
  const snap = await readConfigSnapshot(configDir, [], LANG, null);
  assert.deepEqual(snap.budget?.projects, { alpha: { daily_usd: 5, monthly_usd: 100 } });
});

test('readConfigSnapshot reports file, env, and default setting sources with plaintext values', async () => {
  const { configDir } = await makeFixture();
  const previousShowToolCalls = process.env.CORTEX_SHOW_TOOL_CALLS;
  const previousMaxWakes = process.env.CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR;
  process.env.CORTEX_SHOW_TOOL_CALLS = 'yes';
  delete process.env.CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR;
  try {
    const snap = await readConfigSnapshot(configDir, resolveSettingsSnapshot({ turnNotify: false, sessionRetentionDays: 31 }), LANG);
    assert.deepEqual(snap.settings.map((entry) => entry.key), Object.keys(SETTINGS_SPEC));
    assert.deepEqual(
      snap.settings.find((entry) => entry.key === 'turnNotify'),
      { key: 'turnNotify', value: false, source: 'file' },
    );
    assert.deepEqual(
      snap.settings.find((entry) => entry.key === 'showToolCalls'),
      { key: 'showToolCalls', value: true, source: 'env' },
    );
    assert.deepEqual(
      snap.settings.find((entry) => entry.key === 'waitpointMaxWakesPerHour'),
      { key: 'waitpointMaxWakesPerHour', value: 12, source: 'default' },
    );
    assert.deepEqual(
      snap.settings.find((entry) => entry.key === 'sessionRetentionDays'),
      { key: 'sessionRetentionDays', value: 31, source: 'file' },
    );
  } finally {
    if (previousShowToolCalls === undefined) delete process.env.CORTEX_SHOW_TOOL_CALLS;
    else process.env.CORTEX_SHOW_TOOL_CALLS = previousShowToolCalls;
    if (previousMaxWakes === undefined) delete process.env.CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR;
    else process.env.CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR = previousMaxWakes;
  }
});

test('readConfigSnapshot redacts .env secrets — raw value never appears in the DTO', async () => {
  const { configDir } = await makeFixture();
  const snap = await readConfigSnapshot(configDir, [], LANG, null);
  const serialized = JSON.stringify(snap);
  assert.ok(!serialized.includes(RAW_SECRET), 'raw secret leaked into snapshot');

  const secret = snap.env.find((e) => e.key === 'SECRET_TOKEN');
  assert.ok(secret, 'SECRET_TOKEN entry missing');
  assert.equal(secret!.present, true);
  assert.notEqual(secret!.masked, RAW_SECRET);
  assert.ok(secret!.masked.length > 0);

  const empty = snap.env.find((e) => e.key === 'EMPTY_KEY');
  assert.ok(empty, 'EMPTY_KEY entry missing');
  assert.equal(empty!.present, false);
  assert.equal(empty!.masked, '');

  const base = snap.env.find((e) => e.key === 'BASE_URL');
  assert.ok(base, 'BASE_URL entry missing');
  assert.equal(base!.present, true);
  // comment line is not an entry
  assert.ok(!snap.env.some((e) => e.key.startsWith('#')));
});

test('readConfigSnapshot maps models / machines / mcp / environments / hooks', async () => {
  const { configDir } = await makeFixture();
  const snap = await readConfigSnapshot(configDir, [], LANG, null);

  assert.deepEqual(snap.models, { default: selection, favorites, memory: {} });
  assert.equal(snap.selectionDefault, null);
  assert.equal('profiles' in snap, false);

  const hub = snap.machines.find((m) => m.name === 'hub');
  const lab = snap.machines.find((m) => m.name === 'lab');
  assert.deepEqual(hub, { name: 'hub', cortexPath: '/x', gpuCount: 2, ssh: false, win: false });
  assert.equal(lab!.ssh, true, 'ssh should be a presence flag (true), never the raw user@host');
  const serialized = JSON.stringify(snap);
  assert.ok(!serialized.includes('user@host'), 'raw ssh string leaked into snapshot');

  assert.deepEqual(snap.mcp!.servers.sort(), ['alpha', 'beta']);
  // The composer picker lists the execution environments only, never the thread agents.
  assert.deepEqual(snap.agents, [
    { name: 'creative' },
    { name: 'main', description: 'General' },
  ]);
  assert.deepEqual(snap.hooks, [
    { id: 'managed-hook', event: 'agent:pre-tool', enabled: true, source: 'user', overridden: false },
    { id: 'user-hook', event: 'pi:message_end', enabled: true, source: 'user', overridden: false },
    { id: 'disabled-hook', event: 'cc:Notification', enabled: false, source: 'user', overridden: false },
  ]);
  // A thread template left on disk by an older install no longer contributes a hook.
  assert.ok(!JSON.stringify(snap.hooks).includes('my-hook.mjs'));
});

test('readConfigSnapshot never exposes foreign fields from models.json', async () => {
  const { configDir } = await makeFixture();
  await fs.writeFile(path.join(configDir, 'models.json'), JSON.stringify({
    default: selection, favorites,
    extraEnv: { PI_TOKEN: 'super-secret' },
    arbitrary: 'also-secret',
  }));
  const snap = await readConfigSnapshot(configDir, [], LANG, null);
  assert.deepEqual(snap.models, { default: selection, favorites, memory: {} });
  assert.ok(!JSON.stringify(snap).includes('super-secret'));
  assert.ok(!JSON.stringify(snap).includes('also-secret'));
});

test('readConfigSnapshot omits incomplete or unsupported engine choices', async () => {
  const { configDir } = await makeFixture();
  await fs.writeFile(path.join(configDir, 'models.json'), JSON.stringify({
    default: { ...selection, backend: 'codex' },
    favorites: [{ backend: 'other', provider: null, model: 'old' }, { model: 'implicit' }, ...favorites],
  }));
  const snap = await readConfigSnapshot(configDir, [], LANG, null);
  assert.deepEqual(snap.models, { default: null, favorites, memory: {} });
});

test('config.get joins live model memory and the complete draft seed', async () => {
  const memory = { '["claude",null,"m1"]': { thinking: 'high', mode: 'plan' } };
  const seed = { ...selection, agentName: 'main' };
  const snap = await handleConfigGet(makeUiDeps({ getModelMemory: () => memory, getSelectionDefault: () => seed }), {});
  assert.deepEqual(snap.models.memory, memory);
  assert.deepEqual(snap.selectionDefault, seed);
});

test('readConfigSnapshot returns null / empty when files are absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-empty-'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const snap = await readConfigSnapshot(path.join(root, 'config'), [], LANG, null);
  error.mockRestore();
  assert.equal(snap.budget, null);
  assert.deepEqual(snap.models, { default: null, favorites: [], memory: {} });
  assert.equal(snap.mcp, null);
  assert.deepEqual(snap.machines, []);
  assert.deepEqual(snap.hooks, []);
  assert.deepEqual(snap.env, []);
});

test('readConfigSnapshot returns empty hooks for malformed registry JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-hook-json-'));
  const configDir = path.join(root, 'config');
  await fs.mkdir(path.join(configDir, 'hooks'), { recursive: true });
  await fs.writeFile(path.join(configDir, 'hooks', 'broken.json'), '{broken');
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  const snap = await readConfigSnapshot(configDir, [], LANG, null);

  assert.deepEqual(snap.hooks, []);
  assert.match(error.mock.calls.flat().join('\n'), /broken\.json/);
  error.mockRestore();
});

// ── display language ────────────────────────────────────────────────
// `lang` is what the Web UI picks its vocabulary from AND what every server-side t() renders in.
// It is passed in rather than read off the configDir: the live process locale (post-!lang) is the
// honest answer, and readConfigSnapshot must stay hermetic over its directory argument.

test('DEBUG settings report exact opt-in without changing variable presence', async () => {
  const { configDir } = await makeFixture();
  for (const [value, enabled] of [['1', true], ['"1"', true], ['0', false], ['false', false], ['true', false], ['', false], ['" 1 "', false]] as const) {
    await fs.writeFile(path.join(configDir, '.env'), `DEBUG=${value}\n`);
    const snap = await readConfigSnapshot(configDir, [], LANG, null);
    assert.deepEqual(snap.env[0], { key: 'DEBUG', present: value.length > 0, masked: value ? '••••••••' : '', enabled });
  }
});
