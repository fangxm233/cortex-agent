// input:  runMigrations, assertions, temporary user config trees
// output: Legacy session hook migration regression tests
// pos:    Verifies session hooks move into registry entries
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { runMigrations } from '../../src/store/version-migrations.js';

async function setup(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-hook-migration-'));
  t.onTestFinished(() => fs.rm(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    storeDir: path.join(dataDir, 'data'),
    configDir: path.join(dataDir, 'config'),
    defaultsDir: path.join(dataDir, 'defaults'),
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function migrate(paths: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await runMigrations(paths);
}

test('moves legacy session script and command hooks into the registry', async (t) => {
  const paths = await setup(t);
  const source = path.join(paths.configDir, 'session-hooks.json');
  await writeJson(source, {
    onNew: { script: 'custom-new.mjs', timeout: 45_000 },
    onMessageEnd: { command: 'custom-check', args: ['--mode', 'two words'], timeout: 2_500 },
  });

  await migrate(paths);

  assert.equal(await fs.stat(source).catch(() => null), null);
  assert.deepEqual(await readJson(path.join(paths.configDir, 'hooks', '12-session-new-hook.json')), {
    id: 'session-new-hook',
    event: 'cortex:session.new',
    run: { script: 'custom-new.mjs', timeout: 45 },
    result: 'stdout-as-prompt',
    enabled: true,
  });
  assert.deepEqual(await readJson(path.join(paths.configDir, 'hooks', '13-session-message-end-hook.json')), {
    id: 'session-message-end-hook',
    event: 'cortex:session.messageEnd',
    run: { command: "custom-check '--mode' 'two words'", timeout: 2.5 },
    result: 'stdout-as-prompt',
    enabled: true,
  });
});

test('recognizes historical node hooks commands and is idempotent', async (t) => {
  const paths = await setup(t);
  const source = path.join(paths.configDir, 'session-hooks.json');
  const target = path.join(paths.configDir, 'hooks', '12-session-new-hook.json');
  await writeJson(source, {
    onNew: { command: 'node hooks/new-session-hook.mjs', args: [], timeout: 60_000 },
  });

  await migrate(paths);
  const first = await fs.readFile(target, 'utf8');
  await migrate(paths);

  assert.equal(await fs.readFile(target, 'utf8'), first);
  assert.deepEqual(JSON.parse(first), {
    id: 'session-new-hook',
    event: 'cortex:session.new',
    run: { script: 'new-session-hook.mjs', timeout: 60 },
    result: 'stdout-as-prompt',
    enabled: true,
  });
});

test('preserves registry choices and legacy omission of onNew', async (t) => {
  const paths = await setup(t);
  const source = path.join(paths.configDir, 'session-hooks.json');
  const target = path.join(paths.configDir, 'hooks', '13-session-message-end-hook.json');
  const existing = {
    id: 'custom-message-end',
    event: 'cortex:session.messageEnd',
    run: { command: 'existing-command' },
  };
  await writeJson(source, { onMessageEnd: { command: 'legacy-command' } });
  await writeJson(target, existing);

  await migrate(paths);

  assert.equal(await fs.stat(source).catch(() => null), null);
  assert.deepEqual(await readJson(target), existing);
  assert.deepEqual(await readJson(path.join(paths.configDir, 'hooks', '12-session-new-hook.json')), {
    id: 'session-new-hook',
    event: 'cortex:session.new',
    run: { script: 'new-session-hook.mjs', timeout: 60 },
    result: 'stdout-as-prompt',
    enabled: false,
  });
});

test('keeps the legacy file when a registry destination is invalid', async (t) => {
  const paths = await setup(t);
  const source = path.join(paths.configDir, 'session-hooks.json');
  const target = path.join(paths.configDir, 'hooks', '13-session-message-end-hook.json');
  await writeJson(source, { onMessageEnd: { command: 'legacy-command' } });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '{bad json');

  await migrate(paths);

  assert.notEqual(await fs.stat(source).catch(() => null), null);
  assert.equal(await fs.readFile(target, 'utf8'), '{bad json');
});

test('leaves an absent legacy session hook file untouched', async (t) => {
  const paths = await setup(t);

  await migrate(paths);

  assert.equal(await fs.stat(path.join(paths.configDir, 'hooks')).catch(() => null), null);
});
