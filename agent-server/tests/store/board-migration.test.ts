import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retireCommissions } from '../../src/store/board-migration.js';
import { runMigrations } from '../../src/store/version-migrations.js';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';

let root: string;
let dataDir: string;
let storeDir: string;
let projectsDir: string;

async function write(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));

function sessionRecord(id: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: id, projectId: 'proj', channel: `web:${id}`, backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: '2026-09-01T00:00:00.000Z', label: null, profileName: null,
    ...extra,
  };
}

/** Every file under `dir` with its content, for before/after comparison. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(dir, full)] = await fs.readFile(full, 'utf8');
    }
  };
  await walk(dir);
  return out;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'board-migration-'));
  dataDir = path.join(root, 'home');
  storeDir = path.join(dataDir, 'data');
  projectsDir = path.join(dataDir, 'context', 'projects');

  await write(path.join(storeDir, 'commissions.json'), json({ commissions: [
    { id: 'c1', projectId: 'proj', slug: 'ship-it', title: 'Ship it', status: 'active', createdAt: 1, updatedAt: 2 },
    { id: 'c2', projectId: 'proj', slug: 'old-one', title: 'Old one', status: 'done', createdAt: 1, updatedAt: 3, closedAt: 3, closeNote: 'fine' },
  ] }));
  const ctx = path.join(projectsDir, 'proj');
  await write(path.join(ctx, 'commissions', 'ship-it', 'contract.md'), '# Contract');
  await write(path.join(ctx, 'commissions', 'ship-it', 'ledger.md'), '# Ledger');
  await write(path.join(ctx, 'commissions', 'ship-it', 'assets', 'plot.png'), 'png');
  await write(path.join(ctx, 'commissions', 'old-one', 'ledger.md'), '# Old');
  await write(path.join(ctx, 'commissions', '_draft-abcd1234', 'contract.md'), 'draft');

  await write(path.join(storeDir, 'session-registry.jsonl'), [
    { v: 1, op: 'put', id: 's1', record: sessionRecord('s1', { commissionId: 'c1', commissionDraft: null, commissionBlockFor: 'active:c1' }) },
    { v: 1, op: 'put', id: 's2', record: sessionRecord('s2') },
    { v: 1, op: 'patch', id: 's2', fields: { commissionDraft: '_draft-s2' } },
    { v: 1, op: 'patch', id: 's2', fields: { commissionId: 'c2', commissionDraft: null } },
    { v: 1, op: 'put', id: 's3', record: sessionRecord('s3', { commissionDraft: '_draft-abcd1234' }) },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');

  await write(path.join(dataDir, 'config', 'settings.json'), json({ commissionEnabled: true, teamEnabled: true }));
  await write(path.join(dataDir, 'config', 'environments', 'main.json'), json({
    name: 'main', pluginDirs: ['plugins/cortex-system', 'plugins/cortex-commission', 'plugins/cortex-feishu'],
  }));
  await write(path.join(dataDir, 'config', 'environments', 'creative.json'), json({ name: 'creative', pluginDirs: [] }));
  await write(path.join(dataDir, 'plugins', 'cortex-commission', 'skills', 'commission', 'SKILL.md'), 'skill');
});

afterEach(async () => {
  delete process.env.CORTEX_CONFIG_IMMUTABLE;
  await fs.rm(root, { recursive: true, force: true });
});

const NOW = new Date('2026-10-13T12:00:00.000Z');

test('commissions become boards: registry, directories, sessions, settings, environments, plugin', async () => {
  const report = await retireCommissions({ dataDir, storeDir, projectsDir, version: '2026.10.6', now: NOW });
  expect(report).toEqual({
    commissionsFound: 2, boardsAdded: 2, dirsMoved: 2, dirConflicts: 0, draftsLeft: 1,
    sessionsMapped: 2, journalCompacted: true, settingsStripped: true, environmentsUpdated: 1,
    pluginArchived: true,
  });

  // Registry: converted (a commission's status has no board counterpart), original kept as a backup.
  expect(await readJson(path.join(storeDir, 'boards.json'))).toEqual({ boards: [
    { id: 'c1', projectId: 'proj', slug: 'ship-it', title: 'Ship it', createdAt: 1, updatedAt: 2 },
    { id: 'c2', projectId: 'proj', slug: 'old-one', title: 'Old one', createdAt: 1, updatedAt: 3 },
  ] });
  expect(existsSync(path.join(storeDir, 'commissions.json'))).toBe(false);
  expect(existsSync(path.join(storeDir, 'commissions.json.pre-2026.10.6.bak'))).toBe(true);

  // Directories: registered ones moved with their files; the draft stays.
  const ctx = path.join(projectsDir, 'proj');
  expect(await fs.readFile(path.join(ctx, 'boards', 'ship-it', 'contract.md'), 'utf8')).toBe('# Contract');
  expect(await fs.readFile(path.join(ctx, 'boards', 'ship-it', 'assets', 'plot.png'), 'utf8')).toBe('png');
  expect(existsSync(path.join(ctx, 'boards', 'old-one', 'ledger.md'))).toBe(true);
  expect(existsSync(path.join(ctx, 'commissions', 'ship-it'))).toBe(false);
  expect(existsSync(path.join(ctx, 'commissions', '_draft-abcd1234', 'contract.md'))).toBe(true);

  // Sessions: the journal was rewritten under the board keys.
  const journal = await fs.readFile(path.join(storeDir, 'session-registry.jsonl'), 'utf8');
  expect(journal).not.toMatch(/commission/);
  const repo = new SessionRegistryRepo(path.join(storeDir, 'session-registry.jsonl'));
  expect((await repo.getById('s1'))?.boardId).toBe('c1');
  expect((await repo.getById('s1'))?.boardBlockFor).toBe('active:c1');
  expect((await repo.getById('s2'))?.boardId).toBe('c2');
  expect((await repo.getById('s3'))?.boardId ?? null).toBe(null);

  // Config.
  expect(await readJson(path.join(dataDir, 'config', 'settings.json'))).toEqual({ teamEnabled: true });
  expect((await readJson(path.join(dataDir, 'config', 'environments', 'main.json'))).pluginDirs)
    .toEqual(['plugins/cortex-system', 'plugins/cortex-board', 'plugins/cortex-feishu']);
  expect((await readJson(path.join(dataDir, 'config', 'environments', 'creative.json'))).pluginDirs).toEqual([]);
  expect(existsSync(path.join(dataDir, 'plugins', 'cortex-commission'))).toBe(false);
  expect(existsSync(path.join(dataDir, 'config', 'archive', 'retired-commission-20261013T120000Z', 'cortex-commission', 'skills', 'commission', 'SKILL.md'))).toBe(true);
});

test('a second run is a no-op', async () => {
  await retireCommissions({ dataDir, storeDir, projectsDir, version: '2026.10.6', now: NOW });
  const before = await snapshot(root);
  const report = await retireCommissions({ dataDir, storeDir, projectsDir, version: '2026.10.6', now: new Date() });
  expect(report).toEqual({
    commissionsFound: 0, boardsAdded: 0, dirsMoved: 0, dirConflicts: 0, draftsLeft: 1,
    sessionsMapped: 0, journalCompacted: false, settingsStripped: false, environmentsUpdated: 0,
    pluginArchived: false,
  });
  expect(await snapshot(root)).toEqual(before);
});

test('existing boards are kept, a board directory is never overwritten, and an env already on cortex-board drops the duplicate', async () => {
  await write(path.join(storeDir, 'boards.json'), json({ boards: [
    { id: 'c1', projectId: 'proj', slug: 'ship-it', title: 'Already here', status: 'active', createdAt: 9, updatedAt: 9 },
  ] }));
  await write(path.join(projectsDir, 'proj', 'boards', 'ship-it', 'board.html'), '<p>keep</p>');
  await write(path.join(dataDir, 'config', 'environments', 'main.json'), json({
    name: 'main', pluginDirs: ['plugins/cortex-board', 'plugins/cortex-commission'],
  }));

  const report = await retireCommissions({ dataDir, storeDir, projectsDir, version: '2026.10.6', now: NOW });
  expect(report.boardsAdded).toBe(1);
  expect(report.dirConflicts).toBe(1);
  expect(report.dirsMoved).toBe(1);
  const boards = (await readJson(path.join(storeDir, 'boards.json'))).boards;
  expect(boards.map((b: any) => b.title)).toEqual(['Already here', 'Old one']);
  expect(await fs.readFile(path.join(projectsDir, 'proj', 'boards', 'ship-it', 'board.html'), 'utf8')).toBe('<p>keep</p>');
  expect(existsSync(path.join(projectsDir, 'proj', 'commissions', 'ship-it', 'contract.md'))).toBe(true);
  expect((await readJson(path.join(dataDir, 'config', 'environments', 'main.json'))).pluginDirs).toEqual(['plugins/cortex-board']);
});

test('a sealed config keeps settings, environments and plugins; state still moves', async () => {
  process.env.CORTEX_CONFIG_IMMUTABLE = '1';
  const report = await retireCommissions({ dataDir, storeDir, projectsDir, version: '2026.10.6', now: NOW });
  expect(report.dirsMoved).toBe(2);
  expect(report.settingsStripped).toBe(false);
  expect(report.environmentsUpdated).toBe(0);
  expect(report.pluginArchived).toBe(false);
});

test('runs as a step migration under its own key', async () => {
  const defaultsDir = path.join(root, 'defaults');
  await fs.mkdir(defaultsDir, { recursive: true });
  await runMigrations({ dataDir, defaultsDir, storeDir });
  const versions = await readJson(path.join(storeDir, 'versions.json'));
  expect(versions['sentinel:retire-commissions']).toBe('2026.10.6');
  expect(existsSync(path.join(storeDir, 'boards.json'))).toBe(true);
  expect(existsSync(path.join(projectsDir, 'proj', 'boards', 'ship-it'))).toBe(true);
});
