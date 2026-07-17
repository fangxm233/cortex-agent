// input:  Node test runner + domain/threads/template-loader (directory config + migration + merge)
// output: loadConfig dir/file parity (golden equivalence), fail-soft skip, migrateThreadTemplatesToDir,
//         mergeThreadTemplates per-file copy-if-missing
// pos:    DR-0017 D6 Phase 2.5 — config directory-ization + shell definitions back to JSON
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  loadConfig,
  migrateThreadTemplatesToDir,
  mergeThreadTemplates,
} from '../../src/domain/threads/template-loader.js';
import { CONFIG_DIR } from '../../src/core/paths.js';

const CONFIG_FILE = path.join(CONFIG_DIR, 'thread-templates.json');
const CONFIG_DIR_PATH = path.join(CONFIG_DIR, 'thread-templates');

const WORKER_REVIEW = {
  params: ['worker', 'reviewer'],
  agents: ['{worker}', '{reviewer}'],
  transitions: [
    { from: '{worker}:{worker.entryStage}', to: '{reviewer}', condition: { type: 'always' } },
    { from: '{reviewer}', to: '{worker}:retry', condition: { type: 'convergence', marker: '[APPROVED]', maxIterations: 1 } },
    { from: '{worker}:retry', to: '{reviewer}', condition: { type: 'output_not_contains', pattern: '\\[REVISED\\]' } },
  ],
  entryAgent: '{worker}',
  entryStage: '{worker.entryStage}',
  maxTotalSteps: 4,
  hooks: { onEnd: { command: 'node ~/.cortex/hooks/post-task-hook.mjs', args: ['{worker}'], timeout: 10000 } },
};

function workerAgent(name: string, produce: string) {
  return {
    name, profile: '__active__', persistSession: true, entryStage: produce,
    stages: { [produce]: { promptTemplate: `${name} produce` }, retry: { promptTemplate: `${name} retry` } },
  };
}
function reviewerAgent(name: string) {
  return { name, profile: '__active__', persistSession: true, promptTemplate: 'review' };
}

const FIXTURE = {
  agents: {
    executor: workerAgent('executor', 'execute'),
    'executor-reviewer': reviewerAgent('executor-reviewer'),
  },
  templates: {
    'execute-review': { shell: 'worker-review', worker: 'executor', reviewer: 'executor-reviewer', description: 'exec then review' },
    plain: { name: 'plain', description: 'single agent', agents: ['executor'], transitions: [], entryAgent: 'executor', maxTotalSteps: 1 },
  },
  shells: { 'worker-review': WORKER_REVIEW },
};

function clean(): void {
  rmSync(CONFIG_DIR_PATH, { recursive: true, force: true });
  rmSync(CONFIG_FILE, { force: true });
  rmSync(`${CONFIG_FILE}.migrated-bak`, { force: true });
}

function writeSingleFile(cfg: unknown): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function writeDir(cfg: any): void {
  for (const sub of ['agents', 'templates', 'shells']) mkdirSync(path.join(CONFIG_DIR_PATH, sub), { recursive: true });
  for (const [name, a] of Object.entries(cfg.agents || {})) writeFileSync(path.join(CONFIG_DIR_PATH, 'agents', `${name}.json`), JSON.stringify(a, null, 2), 'utf8');
  for (const [name, t] of Object.entries(cfg.templates || {})) writeFileSync(path.join(CONFIG_DIR_PATH, 'templates', `${name}.json`), JSON.stringify(t, null, 2), 'utf8');
  for (const [name, s] of Object.entries(cfg.shells || {})) writeFileSync(path.join(CONFIG_DIR_PATH, 'shells', `${name}.json`), JSON.stringify(s, null, 2), 'utf8');
}

// --- Golden equivalence: dir-loaded config === same-content single-file-loaded config ---

test('loadConfig from directory equals loadConfig from same-content single file', () => {
  clean();
  writeSingleFile(FIXTURE);
  const fromFile = loadConfig();
  const fileSnapshot = JSON.parse(JSON.stringify({ agents: fromFile.agents, templates: fromFile.templates }));

  clean();
  writeDir(FIXTURE);
  const fromDir = loadConfig();
  const dirSnapshot = JSON.parse(JSON.stringify({ agents: fromDir.agents, templates: fromDir.templates }));

  assert.deepEqual(dirSnapshot, fileSnapshot);
  // sanity: the shell binding was actually expanded (3-transition convergence loop)
  assert.equal(dirSnapshot.templates['execute-review'].transitions.length, 3);
  assert.equal(dirSnapshot.templates['execute-review'].entryStage, 'execute');
});

// --- Directory precedence: dir wins over a stale single file ---

test('loadConfig prefers the directory when both dir and single file exist', () => {
  clean();
  writeSingleFile({ agents: {}, templates: { onlyInFile: { name: 'onlyInFile', description: '', agents: [], transitions: [], entryAgent: 'x', maxTotalSteps: 1 } }, shells: {} });
  writeDir(FIXTURE);
  const { templates } = loadConfig();
  assert.ok(templates['plain'], 'dir template loaded');
  assert.equal(templates['onlyInFile'], undefined, 'single-file template ignored when dir present');
});

// --- Fail-soft: name-field ≠ filename is skipped; the rest still load ---

test('loadConfig skips an agent whose name field disagrees with its filename', () => {
  clean();
  writeDir(FIXTURE);
  // add a mismatched agent file
  writeFileSync(path.join(CONFIG_DIR_PATH, 'agents', 'renamed.json'), JSON.stringify({ ...reviewerAgent('actual-name') }, null, 2), 'utf8');
  const { agents, templates } = loadConfig();
  assert.equal(agents['renamed'], undefined, 'name-mismatch agent skipped');
  assert.equal(agents['actual-name'], undefined, 'not keyed by its name field either');
  assert.ok(agents['executor'], 'other agents still load');
  assert.ok(templates['plain'], 'templates still load');
});

test('loadConfig fail-soft skips a broken shell binding but keeps the rest', () => {
  clean();
  const cfg = JSON.parse(JSON.stringify(FIXTURE));
  cfg.templates['broken'] = { shell: 'worker-review', worker: 'ghost', reviewer: 'executor-reviewer', description: 'bad' };
  writeDir(cfg);
  const { templates } = loadConfig();
  assert.ok(templates['execute-review'], 'valid binding expanded');
  assert.equal(templates['broken'], undefined, 'broken binding skipped');
  assert.ok(templates['plain'], 'full template unaffected');
});

test('loadConfig fail-soft skips a shell binding referencing an unknown shell', () => {
  clean();
  const cfg = JSON.parse(JSON.stringify(FIXTURE));
  cfg.templates['noshell'] = { shell: 'no-such-shell', worker: 'executor', reviewer: 'executor-reviewer' };
  writeDir(cfg);
  const { templates } = loadConfig();
  assert.equal(templates['noshell'], undefined, 'unknown-shell binding skipped');
  assert.ok(templates['execute-review'], 'valid binding still expanded');
});

// --- One-time migration: single file → directory + backup ---

test('migrateThreadTemplatesToDir splits the single file and backs up the original', () => {
  clean();
  writeSingleFile(FIXTURE);
  const original = readFileSync(CONFIG_FILE, 'utf8');

  const migrated = migrateThreadTemplatesToDir();
  assert.equal(migrated, true);

  // directory populated, one file per entity
  assert.ok(existsSync(path.join(CONFIG_DIR_PATH, 'agents', 'executor.json')));
  assert.ok(existsSync(path.join(CONFIG_DIR_PATH, 'templates', 'execute-review.json')));
  assert.ok(existsSync(path.join(CONFIG_DIR_PATH, 'shells')), 'shells dir created (even if empty)');
  assert.deepEqual(readdirSync(path.join(CONFIG_DIR_PATH, 'agents')).sort(), ['executor-reviewer.json', 'executor.json']);

  // original file renamed to .migrated-bak with content preserved, not deleted
  assert.equal(existsSync(CONFIG_FILE), false, 'single file removed');
  assert.equal(readFileSync(`${CONFIG_FILE}.migrated-bak`, 'utf8'), original, 'backup preserves original content');

  // migrated dir loads back to the same config as the original file did
  const { templates } = loadConfig();
  assert.equal(templates['execute-review'].transitions.length, 3);
});

test('migrateThreadTemplatesToDir is a no-op when the directory already exists', () => {
  clean();
  writeSingleFile(FIXTURE);
  writeDir(FIXTURE);
  assert.equal(migrateThreadTemplatesToDir(), false);
  assert.ok(existsSync(CONFIG_FILE), 'single file left untouched when dir present');
});

test('migrateThreadTemplatesToDir is a no-op when there is no single file', () => {
  clean();
  assert.equal(migrateThreadTemplatesToDir(), false);
});

// --- mergeThreadTemplates: per-file copy-if-missing (defaults dir → user dir) ---

test('mergeThreadTemplates copies missing files and preserves existing ones', () => {
  clean();
  const defaultsDir = path.join(CONFIG_DIR, '_defaults-tt');
  rmSync(defaultsDir, { recursive: true, force: true });
  for (const sub of ['agents', 'templates', 'shells']) mkdirSync(path.join(defaultsDir, sub), { recursive: true });
  writeFileSync(path.join(defaultsDir, 'agents', 'executor.json'), JSON.stringify(workerAgent('executor', 'execute'), null, 2), 'utf8');
  writeFileSync(path.join(defaultsDir, 'shells', 'worker-review.json'), JSON.stringify(WORKER_REVIEW, null, 2), 'utf8');

  // user dir already has a customized executor.json
  mkdirSync(path.join(CONFIG_DIR_PATH, 'agents'), { recursive: true });
  const custom = JSON.stringify({ ...workerAgent('executor', 'execute'), profile: 'CUSTOM' }, null, 2);
  writeFileSync(path.join(CONFIG_DIR_PATH, 'agents', 'executor.json'), custom, 'utf8');

  const changed = mergeThreadTemplates(defaultsDir, CONFIG_DIR_PATH);
  assert.equal(changed, true);
  // new shell file added
  assert.ok(existsSync(path.join(CONFIG_DIR_PATH, 'shells', 'worker-review.json')), 'missing shell copied in');
  // existing user file preserved (not overwritten)
  assert.equal(readFileSync(path.join(CONFIG_DIR_PATH, 'agents', 'executor.json'), 'utf8'), custom, 'existing file preserved');

  // second run is a no-op (everything present)
  assert.equal(mergeThreadTemplates(defaultsDir, CONFIG_DIR_PATH), false);
});
