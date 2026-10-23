import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('@core/version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/version.js')>();
  return { ...actual, CORTEX_VERSION: '2099.1.1' };
});

const { runMigrations } = await import('../../src/store/version-migrations.js');
const { appendMemoryIndexIgnores } = await import('../../src/store/gitignore-migration.js');

const RULES = [
  'context/projects/*/experiments/index.md',
  'context/projects/*/knowledge/index.md',
  'context/projects/*/patterns/index.md',
];
let tmpDir: string;
let serial = 0;

beforeAll(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-gitignore-migration-')); });
afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

async function migrate(gitignore: string | null): Promise<string | null> {
  const dataDir = path.join(tmpDir, `home-${serial++}`);
  await fs.mkdir(dataDir, { recursive: true });
  const target = path.join(dataDir, '.gitignore');
  if (gitignore !== null) await fs.writeFile(target, gitignore);
  await runMigrations({ dataDir, storeDir: path.join(dataDir, 'data'), defaultsDir: path.join(dataDir, 'defaults'), stepMigrations: [] });
  return fs.readFile(target, 'utf8').catch(() => null);
}

test('appends the context-anchored index rules after the existing content', async () => {
  const before = '# Mine\n*.log\nprojects/*/experiments/index.md\n';
  expect(await migrate(before)).toBe(`${before}${RULES.join('\n')}\n`);
});

test('appends only the missing rules and terminates an unterminated last line', async () => {
  expect(await migrate(`*.log\n${RULES[1]}`)).toBe(`*.log\n${RULES[1]}\n${RULES[0]}\n${RULES[2]}\n`);
});

test('leaves a file that already has every rule byte-identical', async () => {
  const complete = `*.log\r\n${RULES.join('\r\n')}\r\n# tail\r\n`;
  expect(await migrate(complete)).toBe(complete);
});

test('does not create a missing .gitignore', async () => {
  expect(await migrate(null)).toBeNull();
});

test('is idempotent', () => {
  const once = appendMemoryIndexIgnores('*.log\n');
  expect(appendMemoryIndexIgnores(once)).toBe(once);
});
