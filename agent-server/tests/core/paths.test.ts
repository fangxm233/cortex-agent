// input:  paths module
// output: verify INSTALL_ROOT / PROJECTS_DIR / WORKSPACE_DIR / deprecated aliases / workspace alias resolution
// pos:    Verify path system refactored constant behavior

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_ROOT, PACKAGE_ROOT, SERVER_ROOT, REPO_ROOT, DATA_DIR, PROJECTS_DIR, WORKSPACE_DIR, resolveWorkspaceRelPath } from '../../src/core/paths.js';

test('INSTALL_ROOT resolves to the installed package root (two levels up from dist/core/, equivalent under tsx to src/core/)', () => {
  const testFileDir = path.dirname(fileURLToPath(import.meta.url));
  // Under tsx, paths.ts loads from src/core/, two levels above it is the package root (agent-server/).
  // tests/core/ → ../.. → agent-server/ should equal INSTALL_ROOT.
  const expected = path.resolve(testFileDir, '..', '..');
  assert.equal(INSTALL_ROOT, expected);
});

test('PACKAGE_ROOT / SERVER_ROOT / REPO_ROOT are deprecated aliases for INSTALL_ROOT', () => {
  assert.equal(PACKAGE_ROOT, INSTALL_ROOT);
  assert.equal(SERVER_ROOT, INSTALL_ROOT);
  assert.equal(REPO_ROOT, INSTALL_ROOT);
});

test('PROJECTS_DIR = DATA_DIR/context/projects by default', () => {
  assert.equal(PROJECTS_DIR, path.join(DATA_DIR, 'context', 'projects'));
});

test('WORKSPACE_DIR = DATA_DIR/tmp', () => {
  assert.equal(WORKSPACE_DIR, path.join(DATA_DIR, 'tmp'));
});

test('resolveWorkspaceRelPath maps the `workspace/` alias to WORKSPACE_DIR contents', () => {
  // The UI-relative `workspace/attachments/...` alias must resolve UNDER WORKSPACE_DIR (=DATA_DIR/tmp),
  // NOT to a literal DATA_DIR/workspace/... path. This is the exact regression that made the attachment
  // path handed to the agent point at a non-existent <DATA_DIR>/workspace/attachments/... location.
  const rel = 'workspace/attachments/sess-abc/image.png';
  const resolved = resolveWorkspaceRelPath(rel);
  assert.equal(resolved, path.join(WORKSPACE_DIR, 'attachments', 'sess-abc', 'image.png'));
  // Guard the specific bug shape: the result must live inside WORKSPACE_DIR and never under a sibling
  // `<DATA_DIR>/workspace` directory.
  assert.ok(resolved!.startsWith(WORKSPACE_DIR + path.sep));
  assert.notEqual(resolved, path.join(DATA_DIR, rel));
});

test('resolveWorkspaceRelPath returns null on a non-`workspace/` prefix', () => {
  assert.equal(resolveWorkspaceRelPath('tmp/attachments/x.png'), null);
  assert.equal(resolveWorkspaceRelPath('/etc/passwd'), null);
  assert.equal(resolveWorkspaceRelPath('attachments/x.png'), null);
});

test('resolveWorkspaceRelPath returns null when the target escapes the workspace root', () => {
  assert.equal(resolveWorkspaceRelPath('workspace/../../etc/passwd'), null);
  assert.equal(resolveWorkspaceRelPath('workspace/../tmp-sibling/x'), null);
});
