import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLEAN_WORKSPACES_DIR, PROMPTS_DIR, sessionSpawnCwd, AGENT_CWD } from '../../src/core/paths.js';
import {
  copyIntoInputs, createWorkspace, resolveGivenPath, workspacePrompt, WORKSPACE_PROMPT_FILE,
} from '../../src/core/workspace.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-workspace-'));
}

test('createWorkspace makes <root>/<name>/inputs and suffixes a taken name', () => {
  const root = tmpDir();
  const first = createWorkspace('a1b2c3d4', root);
  const second = createWorkspace('a1b2c3d4', root);
  assert.equal(first, path.join(root, 'a1b2c3d4'));
  assert.equal(second, path.join(root, 'a1b2c3d4-2'));
  assert.ok(fs.statSync(path.join(second, 'inputs')).isDirectory());
});

test('createWorkspace defaults to the Cortex home workspaces folder', () => {
  const dir = createWorkspace('defaulted');
  assert.equal(path.dirname(dir), CLEAN_WORKSPACES_DIR);
});

test('copyIntoInputs copies under the given name, reuses an identical file and suffixes a different one', async () => {
  const ws = createWorkspace('copy', tmpDir());
  const src = path.join(tmpDir(), 'upload-123.png');
  fs.writeFileSync(src, 'one');
  const first = await copyIntoInputs(ws, src, 'photo.png');
  assert.equal(first, path.join(ws, 'inputs', 'photo.png'));
  assert.equal(await copyIntoInputs(ws, src, 'photo.png'), first, 'identical file is reused');

  const other = path.join(tmpDir(), 'other.png');
  fs.writeFileSync(other, 'two');
  const renamed = await copyIntoInputs(ws, other, 'photo.png');
  assert.equal(renamed, path.join(ws, 'inputs', 'photo_1.png'));
  assert.equal(fs.readFileSync(renamed, 'utf8'), 'two');
});

test('copyIntoInputs copies a directory recursively under its own name', async () => {
  const ws = createWorkspace('dir', tmpDir());
  const src = path.join(tmpDir(), 'dataset');
  fs.mkdirSync(path.join(src, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(src, 'nested', 'a.txt'), 'x');
  const dest = await copyIntoInputs(ws, src);
  assert.equal(fs.readFileSync(path.join(dest, 'nested', 'a.txt'), 'utf8'), 'x');
});

test('resolveGivenPath expands ~ and resolves relative paths against the cwd', () => {
  assert.equal(resolveGivenPath('~/notes.md', '/srv'), path.join(os.homedir(), 'notes.md'));
  assert.equal(resolveGivenPath('data/a.csv', '/srv/orchard'), '/srv/orchard/data/a.csv');
  assert.equal(resolveGivenPath('/abs/b.csv', '/srv'), '/abs/b.csv');
});

test('workspacePrompt fills the workspace path and prefers a user override', () => {
  const shipped = workspacePrompt('/srv/workspaces/ws1');
  assert.match(shipped, /^## Workspace/);
  assert.ok(shipped.includes('the current directory, /srv/workspaces/ws1.'));
  assert.ok(!shipped.includes('{{workspace}}'));

  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROMPTS_DIR, WORKSPACE_PROMPT_FILE), 'Stay in {{workspace}}.\n');
  try {
    assert.equal(workspacePrompt('/srv/w'), 'Stay in /srv/w.');
  } finally {
    fs.rmSync(path.join(PROMPTS_DIR, WORKSPACE_PROMPT_FILE));
  }
});

test('sessionSpawnCwd is the clean workspace, else the default agent cwd', () => {
  assert.equal(sessionSpawnCwd({ workspaceDir: '/srv/workspaces/ws1' }), '/srv/workspaces/ws1');
  assert.equal(sessionSpawnCwd({ workspaceDir: null }), AGENT_CWD);
  assert.equal(sessionSpawnCwd(null), AGENT_CWD);
});
