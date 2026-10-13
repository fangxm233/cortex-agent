import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  migrateClaudeConfigHome,
  migrateClaudeTranscripts,
  relocateLegacyClaudePath,
  type ClaudeTranscriptMigrationPaths,
} from '../../src/store/claude-transcript-migration.js';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';

const CORTEX_CWD = '-home-u--cortex';
const OTHER_CWD = '-home-u-repo';

interface Fixture {
  root: string;
  storeDir: string;
  paths: ClaudeTranscriptMigrationPaths;
  registry: SessionRegistryRepo;
}

function write(file: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function makeFixture(): Promise<Fixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-migration-'));
  const storeDir = path.join(root, 'cortex-home', 'data');
  const registry = new SessionRegistryRepo(path.join(storeDir, 'session-registry.jsonl'));
  const register = (name: string, sessionId: string, backend: string, backendSessionId?: string) =>
    registry.registerSession({ sessionId, channel: `web:${name}`, backend, kind: 'local', backendSessionId });
  await register('cortex-1', 'track-a', 'claude', 'aaa');
  await register('cortex-4', 'never-ran', 'claude');
  await register('cortex-2', 'track-b', 'claude', 'bbb');
  await register('cortex-3', 'ppp', 'pi');
  return {
    root,
    storeDir,
    registry,
    paths: {
      legacyProjectsDir: path.join(root, 'home', '.claude', 'projects'),
      projectsDir: path.join(storeDir, 'claude', 'projects'),
    },
  };
}

function legacy(f: Fixture, ...parts: string[]): string {
  return path.join(f.paths.legacyProjectsDir, ...parts);
}

function moved(f: Fixture, ...parts: string[]): string {
  return path.join(f.paths.projectsDir, ...parts);
}

function seedLegacy(f: Fixture): void {
  write(legacy(f, CORTEX_CWD, 'aaa.jsonl'), 'a-transcript');
  write(legacy(f, CORTEX_CWD, 'aaa.jsonl.turn-3.bak'), 'a-backup');
  write(legacy(f, CORTEX_CWD, 'aaa', 'subagents', 'agent-1.jsonl'), 'a-sub');
  write(legacy(f, OTHER_CWD, 'bbb.jsonl'), 'b-transcript');
  write(legacy(f, CORTEX_CWD, 'track-b.jsonl'), 'not-the-backend-id');
  write(legacy(f, CORTEX_CWD, 'ppp.jsonl'), 'pi-id-collision');
  write(legacy(f, CORTEX_CWD, 'never-ran.jsonl'), 'no-backend-id-yet');
  write(legacy(f, CORTEX_CWD, 'terminal.jsonl'), 'user-own');
  write(legacy(f, OTHER_CWD, 'memory', 'MEMORY.md'), 'user-memory');
}

test('moves every file a live claude session owns, keeping its encoded-cwd directory', async () => {
  const f = await makeFixture();
  seedLegacy(f);

  const result = await migrateClaudeTranscripts(f.registry, f.paths);

  assert.deepEqual(result, { moved: 4, skipped: 0, failed: 0 });
  assert.equal(fs.readFileSync(moved(f, CORTEX_CWD, 'aaa.jsonl'), 'utf8'), 'a-transcript');
  assert.equal(fs.readFileSync(moved(f, CORTEX_CWD, 'aaa.jsonl.turn-3.bak'), 'utf8'), 'a-backup');
  assert.equal(fs.readFileSync(moved(f, CORTEX_CWD, 'aaa', 'subagents', 'agent-1.jsonl'), 'utf8'), 'a-sub');
  assert.equal(fs.readFileSync(moved(f, OTHER_CWD, 'bbb.jsonl'), 'utf8'), 'b-transcript');
  for (const gone of [['aaa.jsonl'], ['aaa.jsonl.turn-3.bak'], ['aaa']]) {
    assert.equal(fs.existsSync(legacy(f, CORTEX_CWD, ...gone)), false, gone.join('/'));
  }
});

test('leaves everything no live claude session owns where it was', async () => {
  const f = await makeFixture();
  seedLegacy(f);

  await migrateClaudeTranscripts(f.registry, f.paths);

  assert.deepEqual(fs.readdirSync(legacy(f, CORTEX_CWD)).sort(), ['never-ran.jsonl', 'ppp.jsonl', 'terminal.jsonl', 'track-b.jsonl']);
  assert.deepEqual(fs.readdirSync(legacy(f, OTHER_CWD)), ['memory']);
  assert.equal(fs.existsSync(moved(f, CORTEX_CWD, 'terminal.jsonl')), false);
});

test('a second run finds nothing left to move', async () => {
  const f = await makeFixture();
  seedLegacy(f);
  await migrateClaudeTranscripts(f.registry, f.paths);

  assert.deepEqual(await migrateClaudeTranscripts(f.registry, f.paths), { moved: 0, skipped: 0, failed: 0 });
  assert.equal(fs.readFileSync(moved(f, CORTEX_CWD, 'aaa.jsonl'), 'utf8'), 'a-transcript');
});

test('never overwrites a destination that already exists', async () => {
  const f = await makeFixture();
  seedLegacy(f);
  write(moved(f, CORTEX_CWD, 'aaa.jsonl'), 'newer');

  const result = await migrateClaudeTranscripts(f.registry, f.paths);

  assert.equal(result.skipped, 1);
  assert.equal(fs.readFileSync(moved(f, CORTEX_CWD, 'aaa.jsonl'), 'utf8'), 'newer');
  assert.equal(fs.readFileSync(legacy(f, CORTEX_CWD, 'aaa.jsonl'), 'utf8'), 'a-transcript');
});

test('one file that cannot move is counted and the rest still move', async () => {
  const f = await makeFixture();
  seedLegacy(f);
  write(moved(f, OTHER_CWD));

  const result = await migrateClaudeTranscripts(f.registry, f.paths);

  assert.deepEqual(result, { moved: 3, skipped: 0, failed: 1 });
  assert.equal(fs.readFileSync(legacy(f, OTHER_CWD, 'bbb.jsonl'), 'utf8'), 'b-transcript');
  assert.equal(fs.existsSync(moved(f, CORTEX_CWD, 'aaa.jsonl')), true);
});

test('the boot step reads the registry and config dir under the store dir', async () => {
  const f = await makeFixture();
  seedLegacy(f);

  const result = await migrateClaudeConfigHome(f.storeDir, f.paths.legacyProjectsDir);

  assert.equal(result.moved, 4);
  assert.equal(fs.existsSync(path.join(f.storeDir, 'claude', 'projects', CORTEX_CWD, 'aaa.jsonl')), true);
});

test('the boot step does nothing, and creates no registry, when the store has none', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-migration-'));
  const storeDir = path.join(root, 'data');
  fs.mkdirSync(storeDir);

  assert.deepEqual(await migrateClaudeConfigHome(storeDir, path.join(root, 'missing')), { moved: 0, skipped: 0, failed: 0 });
  assert.deepEqual(fs.readdirSync(storeDir), []);
});

test('a recorded backup path under the shared projects dir maps to its moved location', () => {
  const paths = { legacyProjectsDir: '/home/u/.claude/projects', projectsDir: '/home/u/.cortex/data/claude/projects' };
  assert.equal(
    relocateLegacyClaudePath('/home/u/.claude/projects/-home-u--cortex/aaa.jsonl.turn-2.bak', paths),
    '/home/u/.cortex/data/claude/projects/-home-u--cortex/aaa.jsonl.turn-2.bak',
  );
  for (const unchanged of [
    '/home/u/.cortex/data/claude/projects/-x/aaa.jsonl.turn-2.bak',
    '/home/u/.claude/settings.json',
    '/home/u/.claude/projects',
  ]) {
    assert.equal(relocateLegacyClaudePath(unchanged, paths), unchanged);
  }
});
