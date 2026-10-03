import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, seedEnvironmentsFromThreadAgents } from '../../src/store/version-migrations.js';

let root: string;
let dataDir: string;
let defaultsDir: string;

const SHIPPED_THREAD_MAIN = '{"name":"main","profile":"__active__","persistSession":true,"promptTemplate":"{{input}} -> {{artifactPath}}"}\n';
const SHIPPED_ENV_MAIN = '{"name":"main","profile":"__active__","persistSession":true,"promptTemplate":"{{input}}"}\n';
const SHIPPED_ENV_CREATIVE = '{"name":"creative","profile":"__active__","persistSession":true}\n';

async function write(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
}

const envFile = (name: string) => path.join(dataDir, 'config', 'environments', `${name}.json`);
const threadAgent = (name: string) => path.join(dataDir, 'config', 'thread-templates', 'agents', `${name}.json`);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'env-migration-'));
  dataDir = path.join(root, 'home');
  defaultsDir = path.join(root, 'defaults');
  await write(path.join(defaultsDir, 'config', 'thread-templates', 'agents', 'main.json'), SHIPPED_THREAD_MAIN);
  await write(path.join(defaultsDir, 'config', 'environments', 'main.json'), SHIPPED_ENV_MAIN);
  await write(path.join(defaultsDir, 'config', 'environments', 'creative.json'), SHIPPED_ENV_CREATIVE);
});

afterEach(async () => {
  delete process.env.CORTEX_CONFIG_IMMUTABLE;
  await fs.rm(root, { recursive: true, force: true });
});

test('copies the install\'s own main and creative, leaving the thread agents in place', async () => {
  const ownMain = '{"name":"main","profile":"__active__","persistSession":true,"pluginDirs":["plugins/mine"]}';
  const ownCreative = '{"name":"creative","profile":"fast","persistSession":true}';
  await write(threadAgent('main'), ownMain);
  await write(threadAgent('creative'), ownCreative);
  await write(threadAgent('coder'), '{"name":"coder"}');

  expect(await seedEnvironmentsFromThreadAgents(dataDir, defaultsDir)).toEqual(['main', 'creative']);
  expect(await fs.readFile(envFile('main'), 'utf8')).toBe(ownMain);
  expect(await fs.readFile(envFile('creative'), 'utf8')).toBe(ownCreative);
  expect(existsSync(envFile('coder'))).toBe(false);
  expect(existsSync(threadAgent('main'))).toBe(true);
  expect(existsSync(`${path.dirname(envFile('main'))}.partial`)).toBe(false);
});

test('falls back to the shipped environments, and swaps an unmodified stock thread agent for them', async () => {
  await write(threadAgent('main'), SHIPPED_THREAD_MAIN);

  expect(await seedEnvironmentsFromThreadAgents(dataDir, defaultsDir)).toEqual(['main', 'creative']);
  expect(await fs.readFile(envFile('main'), 'utf8')).toBe(SHIPPED_ENV_MAIN);
  expect(await fs.readFile(envFile('creative'), 'utf8')).toBe(SHIPPED_ENV_CREATIVE);
});

test('an existing environments directory is never touched', async () => {
  await write(envFile('main'), '{"name":"main","mine":true}');
  await write(threadAgent('creative'), '{"name":"creative"}');

  expect(await seedEnvironmentsFromThreadAgents(dataDir, defaultsDir)).toEqual([]);
  expect(await fs.readFile(envFile('main'), 'utf8')).toBe('{"name":"main","mine":true}');
  expect(existsSync(envFile('creative'))).toBe(false);
});

test('a sealed config is left alone', async () => {
  process.env.CORTEX_CONFIG_IMMUTABLE = '1';
  expect(await seedEnvironmentsFromThreadAgents(dataDir, defaultsDir)).toEqual([]);
  expect(existsSync(path.dirname(envFile('main')))).toBe(false);
});

test('runs once as a step migration and records its key', async () => {
  await write(threadAgent('main'), '{"name":"main","profile":"__active__","persistSession":true}');
  const storeDir = path.join(dataDir, 'data');

  await runMigrations({ dataDir, defaultsDir, storeDir });
  expect(existsSync(envFile('main'))).toBe(true);
  const versions = JSON.parse(await fs.readFile(path.join(storeDir, 'versions.json'), 'utf8'));
  expect(versions['config/environments']).toBe('2026.10.2');

  // A later removal is the user's decision: the bumped key keeps the step from re-seeding it.
  await fs.rm(path.dirname(envFile('main')), { recursive: true });
  await runMigrations({ dataDir, defaultsDir, storeDir });
  expect(existsSync(envFile('main'))).toBe(false);
});
