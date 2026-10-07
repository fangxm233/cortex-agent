import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { CLAUDE_CONFIG_HOME } from '../../src/core/paths.js';
import {
  seedClaudeUserSettings,
  syncClaudeUserCleanupPeriodDays,
} from '../../src/domain/auth/claude-user-settings.js';

interface Dirs {
  configDir: string;
  seedFromDir: string;
}

async function makeDirs(terminalSettings?: unknown): Promise<Dirs> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-user-settings-'));
  const dirs = { configDir: path.join(root, 'cortex-claude'), seedFromDir: path.join(root, 'terminal-claude') };
  await fsp.mkdir(dirs.seedFromDir, { recursive: true });
  if (terminalSettings !== undefined) {
    const raw = typeof terminalSettings === 'string' ? terminalSettings : JSON.stringify(terminalSettings);
    await fsp.writeFile(path.join(dirs.seedFromDir, 'settings.json'), raw);
  }
  return dirs;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

const TERMINAL = {
  model: 'opus[1m]',
  effortLevel: 'xhigh',
  modelSettings: { opus: { thinking: true } },
  autoCompactWindow: 450_000,
  autoMemoryEnabled: false,
  env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  attribution: { commit: '', pr: '' },
  enabledPlugins: { 'feature-dev@claude-plugins-official': true },
  hooks: { Stop: [] },
  cleanupPeriodDays: 30,
  theme: 'dark',
};

test('settings default to Cortex\'s own Claude config dir', async () => {
  const { seedFromDir } = await makeDirs();
  const result = await syncClaudeUserCleanupPeriodDays(5, { seedFromDir });
  assert.equal(result.filePath, path.join(CLAUDE_CONFIG_HOME, 'settings.json'));
});

test('the first seed copies only the listed keys from the terminal settings', async () => {
  const dirs = await makeDirs(TERMINAL);

  assert.equal(await seedClaudeUserSettings(dirs), true);

  const { enabledPlugins, hooks, cleanupPeriodDays, theme, ...seeded } = TERMINAL;
  void enabledPlugins; void hooks; void cleanupPeriodDays; void theme;
  assert.deepEqual(await readJson(path.join(dirs.configDir, 'settings.json')), seeded);
  assert.equal((await fsp.stat(dirs.configDir)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(path.join(dirs.configDir, 'settings.json'))).mode & 0o777, 0o600);
});

test('the seed runs while settings.json is missing even when the dir already holds a login', async () => {
  const dirs = await makeDirs({ model: 'sonnet' });
  await fsp.mkdir(dirs.configDir, { recursive: true });
  await fsp.writeFile(path.join(dirs.configDir, '.credentials.json'), '{}');

  assert.equal(await seedClaudeUserSettings(dirs), true);
  assert.deepEqual(await readJson(path.join(dirs.configDir, 'settings.json')), { model: 'sonnet' });
});

test('an existing settings.json is never reseeded, so later terminal changes stay out', async () => {
  const dirs = await makeDirs({ model: 'sonnet' });
  await seedClaudeUserSettings(dirs);
  await fsp.writeFile(path.join(dirs.seedFromDir, 'settings.json'), JSON.stringify({ model: 'haiku' }));

  assert.equal(await seedClaudeUserSettings(dirs), false);
  assert.deepEqual(await readJson(path.join(dirs.configDir, 'settings.json')), { model: 'sonnet' });
});

test('a missing or malformed terminal settings file seeds an empty object', async () => {
  for (const terminal of [undefined, '{ not json', '[]']) {
    const dirs = await makeDirs(terminal);
    assert.equal(await seedClaudeUserSettings(dirs), true);
    assert.deepEqual(await readJson(path.join(dirs.configDir, 'settings.json')), {});
  }
});

test('cleanupPeriodDays lands on top of the seeded keys on a fresh dir', async () => {
  const dirs = await makeDirs({ model: 'sonnet', cleanupPeriodDays: 30 });

  const result = await syncClaudeUserCleanupPeriodDays(999, dirs);

  assert.equal(result.changed, true);
  assert.deepEqual(await readJson(result.filePath), { model: 'sonnet', cleanupPeriodDays: 999 });
});

test('cleanupPeriodDays merges into existing settings and preserves every other key', async () => {
  const dirs = await makeDirs();
  await fsp.mkdir(dirs.configDir, { recursive: true });
  const filePath = path.join(dirs.configDir, 'settings.json');
  await fsp.writeFile(filePath, JSON.stringify({ theme: 'dark', nested: { keep: true }, cleanupPeriodDays: 3 }));

  await syncClaudeUserCleanupPeriodDays(9, dirs);

  assert.deepEqual(await readJson(filePath), { theme: 'dark', nested: { keep: true }, cleanupPeriodDays: 9 });
  assert.deepEqual(await fsp.readdir(dirs.configDir), ['settings.json']);
});

test('a matching cleanupPeriodDays leaves the file untouched', async () => {
  const dirs = await makeDirs();
  await fsp.mkdir(dirs.configDir, { recursive: true });
  const filePath = path.join(dirs.configDir, 'settings.json');
  const text = JSON.stringify({ cleanupPeriodDays: 12, keep: 'same' });
  await fsp.writeFile(filePath, text);
  const before = await fsp.stat(filePath);

  const result = await syncClaudeUserCleanupPeriodDays(12, dirs);

  assert.equal(result.changed, false);
  assert.equal(await fsp.readFile(filePath, 'utf8'), text);
  assert.equal((await fsp.stat(filePath)).mtimeMs, before.mtimeMs);
});

test('malformed or non-object Cortex settings fail without being overwritten', async () => {
  for (const [raw, error] of [['{ not json', /malformed/], ['[]', /JSON object/]] as const) {
    const dirs = await makeDirs();
    await fsp.mkdir(dirs.configDir, { recursive: true });
    const filePath = path.join(dirs.configDir, 'settings.json');
    await fsp.writeFile(filePath, raw);
    await assert.rejects(() => syncClaudeUserCleanupPeriodDays(7, dirs), error);
    assert.equal(await fsp.readFile(filePath, 'utf8'), raw);
  }
});
