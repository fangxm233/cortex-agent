// input:  Node test runner + createThread task-keyed artifact resolution + cleanupWorkspace
// output: manager-thread artifact placement / preservation / cleanup-survival tests
// pos:    Verify DR-0017 W1: manager-template dispatch threads get task-keyed durable artifacts
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR, WORKSPACE_DIR, DEFAULTS_DIR, CONFIG_DIR } from '../src/core/paths.js';
import { taskArtifactPath, ensureTaskArtifact } from '../src/core/task-node.js';
import { createThread, cleanupWorkspace, loadConfig, mergeThreadTemplates } from '../src/domain/threads/index.js';
import { threadStore } from '../src/store/thread-repo.js';

const createdThreadIds = new Set<string>();
const projectDirs: string[] = [];

beforeAll(() => {
  // The isolated test home has no thread-templates config — seed from shipped defaults dir
  // (same path app startup takes) so 'manager' / 'coder-review' resolve.
  mergeThreadTemplates(
    path.join(DEFAULTS_DIR, 'config', 'thread-templates'),
    path.join(CONFIG_DIR, 'thread-templates'),
  );
  loadConfig();
});

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
  for (const d of projectDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function trackProject(name: string): void {
  projectDirs.push(path.join(PROJECTS_DIR, name));
}

function makeThread(opts: { templateName: string; taskId?: string | null; taskProject?: string | null }) {
  const thread = createThread('C-mta-test', {
    templateName: opts.templateName,
    userMessage: 'x',
    userMessageTs: `ts_${Date.now()}`,
    metadata: (opts.taskId || opts.taskProject)
      ? { trigger: 'task-dispatch', taskId: opts.taskId ?? null, taskProject: opts.taskProject ?? null }
      : null,
  });
  createdThreadIds.add(thread.id);
  return thread;
}

test('manager-template dispatch thread gets a task-keyed artifact under the project context dir', () => {
  trackProject('_mta_pa');
  const t = makeThread({ templateName: 'manager', taskId: 'ab12', taskProject: '_mta_pa' });
  assert.equal(t.artifactPath, taskArtifactPath('_mta_pa', 'ab12'));
  assert.ok(fs.existsSync(t.artifactPath), 'task artifact created on disk');
  assert.ok(t.workspacePath.startsWith(path.join(WORKSPACE_DIR, 'threads')), 'tmp workspace still exists for scratch');
});

test('a pre-existing task artifact is preserved (rotation/rehydration continuity)', () => {
  trackProject('_mta_pb');
  const p = ensureTaskArtifact('_mta_pb', 'cd34');
  fs.writeFileSync(p, '## Checkpoint\nprev manager state');
  const t = makeThread({ templateName: 'manager', taskId: 'cd34', taskProject: '_mta_pb' });
  assert.equal(t.artifactPath, p);
  assert.equal(fs.readFileSync(p, 'utf8'), '## Checkpoint\nprev manager state',
    'a new manager incarnation must inherit, not truncate, the previous checkpoint');
});

test('non-manager templates keep the workspace artifact', () => {
  trackProject('_mta_pc');
  const t = makeThread({ templateName: 'coder-review', taskId: 'ef56', taskProject: '_mta_pc' });
  assert.equal(t.artifactPath, path.join(t.workspacePath, 'artifact.md'));
});

test('manager template WITHOUT task metadata keeps the workspace artifact (ad-hoc thread_start path)', () => {
  const t = makeThread({ templateName: 'manager' });
  assert.equal(t.artifactPath, path.join(t.workspacePath, 'artifact.md'));
});

test('cleanupWorkspace removes the tmp workspace but spares the task-keyed artifact', () => {
  trackProject('_mta_pd');
  const t = makeThread({ templateName: 'manager', taskId: 'ab78', taskProject: '_mta_pd' });
  fs.writeFileSync(t.artifactPath, 'durable checkpoint');
  cleanupWorkspace(t.id);
  assert.ok(!fs.existsSync(t.workspacePath), 'tmp workspace removed');
  assert.ok(fs.existsSync(t.artifactPath), 'task artifact survives cleanup');
  assert.equal(fs.readFileSync(t.artifactPath, 'utf8'), 'durable checkpoint');
});
