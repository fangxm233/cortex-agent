// input:  Node test runner + project-store + fs
// output: regression tests for ProjectStore: list/get/exists/getDefault/resolveFromMessage + scaffolding + cache invalidation
// pos:    verifies ProjectStore behaves correctly with temp directories
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const STORE_MODULE_PATH = '../src/domain/projects/project-store.js';

/**
 * Create a temp PROJECTS_DIR with optional initial subdirectories.
 */
function makeTempProjectsDir(initialDirs: string[] = []): { baseDir: string; cleanup: () => void } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-test-'));
  for (const d of initialDirs) {
    fs.mkdirSync(path.join(baseDir, d), { recursive: true });
  }
  const cleanup = () => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  };
  return { baseDir, cleanup };
}

function makeStore(baseDir: string): Promise<{ ProjectStore: any; store: any }> {
  return import(STORE_MODULE_PATH).then((mod) => {
    const store = new mod.ProjectStore({ projectsDir: baseDir, watchEnabled: false });
    return store.initialize().then(() => ({ ProjectStore: mod.ProjectStore, store }));
  });
}

test('ProjectStore - list returns general when dir is empty', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir();
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const projects = store.list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, 'general');
  assert.equal(projects[0].kind, 'general');
  assert.equal(projects[0].contextDir, path.join(baseDir, 'general'));
});

test('ProjectStore - list returns user projects plus general', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['cortex-self', 'some-project']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const projects = store.list();
  const ids = projects.map(p => p.id).sort();
  assert.deepEqual(ids, ['cortex-self', 'general', 'some-project']);
  assert.equal(projects.find(p => p.id === 'cortex-self')!.kind, 'user');
  assert.equal(projects.find(p => p.id === 'some-project')!.kind, 'user');
});

test('ProjectStore - get returns project by id', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['my-project']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const p = store.get('my-project');
  assert.ok(p);
  assert.equal(p!.id, 'my-project');
  assert.equal(p!.kind, 'user');
  assert.equal(p!.contextDir, path.join(baseDir, 'my-project'));
});

test('ProjectStore - get returns undefined for unknown project', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir();
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  assert.equal(store.get('nonexistent'), undefined);
});

test('ProjectStore - exists returns true for known projects', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['known-project']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  assert.equal(store.exists('known-project'), true);
  assert.equal(store.exists('general'), true);
  assert.equal(store.exists('phantom'), false);
});

test('ProjectStore - getDefault returns general', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['some-project']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const d = store.getDefault();
  assert.equal(d.id, 'general');
  assert.equal(d.kind, 'general');
});

// ── resolveFromMessage: existing patterns (substring match) ──

test('ProjectStore - resolveFromMessage matches Project: <name>', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['cortex-self']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const result = store.resolveFromMessage('Project: cortex-self');
  assert.ok(result);
  assert.equal(result!.id, 'cortex-self');
});

test('ProjectStore - resolveFromMessage matches **Project:** <name>', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['my-project']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const result = store.resolveFromMessage('**Project:** my-project');
  assert.ok(result);
  assert.equal(result!.id, 'my-project');
});

test('ProjectStore - resolveFromMessage returns general for unknown project', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir();
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const result = store.resolveFromMessage('Project: nonexistent');
  assert.ok(result);
  assert.equal(result!.id, 'general');
});

test('ProjectStore - resolveFromMessage returns general when no match', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['cortex-self']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const result = store.resolveFromMessage('Hello world');
  assert.ok(result);
  assert.equal(result!.id, 'general');
});

// ── resolveFromMessage: [project:xxx] tag ──

test('ProjectStore - [project:xxx] tag overrides everything', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['orchard', 'cortex-self']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  // Tag with valid project id wins over substring
  const r1 = store.resolveFromMessage('[project:cortex-self] check orchard status');
  assert.ok(r1);
  assert.equal(r1!.id, 'cortex-self');

  // Tag alone with valid project
  const r2 = store.resolveFromMessage('[project:orchard] hello');
  assert.ok(r2);
  assert.equal(r2!.id, 'orchard');

  // Tag with non-existent project returns general
  const r3 = store.resolveFromMessage('[project:fantasy] something');
  assert.ok(r3);
  assert.equal(r3!.id, 'general');
});

test('ProjectStore - [project:xxx] tag works with empty projects dir', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir();
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  // Tag with non-existent project and no user projects — general
  const r = store.resolveFromMessage('[project:solo] message');
  assert.ok(r);
  assert.equal(r!.id, 'general');
});

// ── resolveFromMessage: dynamic name matching ──

test('ProjectStore - case-insensitive substring match on project names', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['MyProject', 'another-app']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  // Exact case match
  const r1 = store.resolveFromMessage('fix another-app bug');
  assert.ok(r1);
  assert.equal(r1!.id, 'another-app');

  // Lowercase message
  const r2 = store.resolveFromMessage('debug myproject issue');
  assert.ok(r2);
  assert.equal(r2!.id, 'MyProject');

  // Uppercase message
  const r3 = store.resolveFromMessage('CHECK ANOTHER-APP STATUS');
  assert.ok(r3);
  assert.equal(r3!.id, 'another-app');
});

test('ProjectStore - longest match wins when multiple project names appear', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['orchard', 'orchard-dataset']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  // Message contains both, longer one wins
  const r1 = store.resolveFromMessage('check orchard-dataset status');
  assert.ok(r1);
  assert.equal(r1!.id, 'orchard-dataset');

  // Only shorter appears
  const r2 = store.resolveFromMessage('check orchard status');
  assert.ok(r2);
  assert.equal(r2!.id, 'orchard');
});

test('ProjectStore - no match returns general', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['orchard', 'cortex-self']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const r1 = store.resolveFromMessage('some unrelated text');
  assert.ok(r1);
  assert.equal(r1!.id, 'general');

  const r2 = store.resolveFromMessage('what time is it');
  assert.ok(r2);
  assert.equal(r2!.id, 'general');
});

test('ProjectStore - empty message returns general', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['orchard']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const r = store.resolveFromMessage('');
  assert.ok(r);
  assert.equal(r!.id, 'general');
});

test('ProjectStore - null message returns general', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['orchard']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const r = store.resolveFromMessage(null as any);
  assert.ok(r);
  assert.equal(r!.id, 'general');
});

test('ProjectStore - undefined message returns general', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['orchard']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const r = store.resolveFromMessage(undefined as any);
  assert.ok(r);
  assert.equal(r!.id, 'general');
});

test('ProjectStore - empty projects dir returns general for any message except tag', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir();
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  // No user projects — unrelated text returns general
  const r1 = store.resolveFromMessage('debug orchard issue');
  assert.ok(r1);
  assert.equal(r1!.id, 'general');

  // No user projects — text referring to non-existent project returns general
  const r2 = store.resolveFromMessage('cortex-self update');
  assert.ok(r2);
  assert.equal(r2!.id, 'general');
});

test('ProjectStore - project name is substring of another but only partial appears', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['atlas', 'atlas-extra', 'atlas-security']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  // Only "atlas" in message, not the longer names
  const r = store.resolveFromMessage('atlas setup');
  assert.ok(r);
  assert.equal(r!.id, 'atlas');
});

test('ProjectStore - tag takes priority over dynamic match', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['tag-test', 'other']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  // Tag with valid project id 'other' wins over substring 'tag-test'
  const r = store.resolveFromMessage('[project:other] fix tag-test');
  assert.ok(r);
  assert.equal(r!.id, 'other');
});

test('ProjectStore - exact project name match in message', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['cortex-self', 'nimbus', 'beacon-nav']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const r1 = store.resolveFromMessage('cortex-self needs a restart');
  assert.ok(r1);
  assert.equal(r1!.id, 'cortex-self');

  const r2 = store.resolveFromMessage('nimbus experiment results');
  assert.ok(r2);
  assert.equal(r2!.id, 'nimbus');

  const r3 = store.resolveFromMessage('beacon-nav paper draft');
  assert.ok(r3);
  assert.equal(r3!.id, 'beacon-nav');
});

// ── Scaffolding ──

test('ProjectStore - scaffolding creates general directory on initialize', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir();
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const generalDir = path.join(baseDir, 'general');
  assert.ok(fs.existsSync(generalDir));
  assert.ok(fs.existsSync(path.join(generalDir, 'STATUS.md')));
  assert.ok(fs.existsSync(path.join(generalDir, 'CORTEX.md')));

  const statusContent = fs.readFileSync(path.join(generalDir, 'STATUS.md'), 'utf8');
  assert.ok(statusContent.includes('# general'));
});

test('ProjectStore - scaffolding does not overwrite existing general', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['general']);
  t.onTestFinished(cleanup);

  // Pre-create a STATUS.md with custom content
  fs.writeFileSync(path.join(baseDir, 'general', 'STATUS.md'), '# custom', 'utf8');

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  // Should not overwrite
  const content = fs.readFileSync(path.join(baseDir, 'general', 'STATUS.md'), 'utf8');
  assert.equal(content, '# custom');
});

// ── createProject ──

test('ProjectStore - createProject creates dir + STATUS.md + CORTEX.md and returns project', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir();
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const result = store.createProject('nimbus');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.project.id, 'nimbus');
  assert.equal(result.project.kind, 'user');
  assert.equal(result.project.contextDir, path.join(baseDir, 'nimbus'));

  const projectDir = path.join(baseDir, 'nimbus');
  assert.ok(fs.existsSync(projectDir));
  assert.ok(fs.existsSync(path.join(projectDir, 'STATUS.md')));
  assert.ok(fs.existsSync(path.join(projectDir, 'CORTEX.md')));
  const status = fs.readFileSync(path.join(projectDir, 'STATUS.md'), 'utf8');
  assert.ok(status.includes('# nimbus'));

  // New project appears in the cache
  assert.equal(store.exists('nimbus'), true);
  assert.ok(store.list().some((p: any) => p.id === 'nimbus'));
});

test('ProjectStore - createProject rejects invalid names (traversal / separators / empty / reserved)', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir();
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  for (const bad of ['..', '../evil', 'a/b', 'a\\b', '', '   ', '.hidden', 'general', '/abs', 'a b']) {
    const result = store.createProject(bad);
    assert.equal(result.ok, false, `expected reject for ${JSON.stringify(bad)}`);
    if (!result.ok) assert.equal(result.code, 'invalid-name', `expected invalid-name for ${JSON.stringify(bad)}`);
  }

  // No new project directory was created by any rejected name (only 'general' scaffold exists)
  const ids = store.list().map((p: any) => p.id).sort();
  assert.deepEqual(ids, ['general']);
});

test('ProjectStore - createProject rejects a duplicate without overwriting', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['orchard']);
  t.onTestFinished(cleanup);

  // Pre-existing project with custom content
  fs.writeFileSync(path.join(baseDir, 'orchard', 'STATUS.md'), '# preserve-me', 'utf8');

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const result = store.createProject('orchard');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'already-exists');

  // Existing content untouched (no overwrite)
  const content = fs.readFileSync(path.join(baseDir, 'orchard', 'STATUS.md'), 'utf8');
  assert.equal(content, '# preserve-me');
});

// ── Dotfile handling ──

test('ProjectStore - ignore dotfiles in project enumeration', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['real-project']);
  t.onTestFinished(cleanup);

  // Create dotfile dirs and regular files that should be ignored
  fs.mkdirSync(path.join(baseDir, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'some-file.md'), '', 'utf8');

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  const projects = store.list();
  const ids = projects.map(p => p.id).sort();
  assert.deepEqual(ids, ['general', 'real-project']);
});

// ── Cache invalidation ──

test('ProjectStore - list after cache refresh picks up new directory', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['existing']);
  t.onTestFinished(cleanup);

  const { store } = await makeStore(baseDir);
  t.onTestFinished(() => store.destroy());

  let ids = store.list().map(p => p.id).sort();
  assert.deepEqual(ids, ['existing', 'general']);

  // Manually add a new dir and refresh
  fs.mkdirSync(path.join(baseDir, 'new-project'));
  store.refresh();

  ids = store.list().map(p => p.id).sort();
  assert.deepEqual(ids, ['existing', 'general', 'new-project']);
});

test('ProjectStore - fs.watch event triggers cache refresh', async (t) => {
  const { baseDir, cleanup } = makeTempProjectsDir(['existing']);
  t.onTestFinished(cleanup);

  const mod = await import(STORE_MODULE_PATH);
  const store = new mod.ProjectStore({ projectsDir: baseDir, watchEnabled: true });
  await store.initialize();
  t.onTestFinished(() => store.destroy());

  let ids = store.list().map(p => p.id).sort();
  assert.deepEqual(ids, ['existing', 'general']);

  // Create new directory — should trigger fs.watch rename event
  fs.mkdirSync(path.join(baseDir, 'new-project-from-watch'));

  // Wait for debounce (1000ms) + OS event propagation buffer
  await new Promise(r => setTimeout(r, 1200));

  ids = store.list().map(p => p.id).sort();
  assert.deepEqual(ids, ['existing', 'general', 'new-project-from-watch']);
});
