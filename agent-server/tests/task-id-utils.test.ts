// input:  Node test runner + task-system/task-id-utils API
// output: hash gen/collect/backfill/validate unit tests
// pos:    Verify task id/hash utility independent API
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import {
  assignIds,
  collectAllExistingHashes,
  generateHash,
  validateIds,
} from '../src/domain/tasks/system/task-id-utils.js';

const P = '_test_idutils_';
let testCounter = 0;
function nextProject(): string { return `${P}${++testCounter}`; }

function writeFixture(project: string, content: string): { tasksPath: string; cleanup: () => void } {
  const projectDir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(projectDir, { recursive: true });
  const tasksPath = path.join(projectDir, 'TASKS.yaml');
  const backup = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : null;
  fs.writeFileSync(tasksPath, content);
  return {
    tasksPath,
    cleanup: () => {
      if (backup !== null) fs.writeFileSync(tasksPath, backup);
      else { try { fs.unlinkSync(tasksPath); } catch {} }
      try { fs.rmdirSync(projectDir); } catch {}
    },
  };
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

test('generateHash produces 4-digit lowercase hex', () => {
  for (let i = 0; i < 50; i++) {
    const hash = generateHash();
    assert.match(hash, /^[0-9a-f]{4}$/);
  }
});

test('generateHash avoids collisions with existing set', () => {
  const existing = new Set<string>();
  for (let i = 0; i < 0x10000 - 10; i++) {
    existing.add(i.toString(16).padStart(4, '0'));
  }
  for (let i = 0; i < 10; i++) {
    const hash = generateHash(existing);
    assert.equal(existing.has(hash), false);
    existing.add(hash);
  }
});

test('collectAllExistingHashes scans all projects under context/projects', () => {
  const proj1 = nextProject();
  const proj2 = nextProject();
  const f1 = writeFixture(proj1, 'tasks:\n  - id: "1111"\n    text: A\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n');
  const f2 = writeFixture(proj2, 'tasks:\n  - id: "2222"\n    text: B\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n  - id: "3333"\n    text: Done\n    why: ""\n    done-when: ""\n    priority: medium\n    status: done\n    template: default\n    plan: ""\n');
  try {
    const hashes = collectAllExistingHashes();
    // The real workspace may have other hashes, so just check ours are included
    assert.ok(hashes.has('1111'));
    assert.ok(hashes.has('2222'));
    assert.ok(hashes.has('3333'));
  } finally { f1.cleanup(); f2.cleanup(); }
});

test('assignIds backfills 4-hex ids for tasks missing them', () => {
  const proj = nextProject();
  const f = writeFixture(proj,
    'tasks:\n  - id: ""\n    text: Needs id\n    why: x\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n  - id: abcd\n    text: Already has id\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n  - id: ""\n    text: Another needs id\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n');
  try {
    const result = assignIds(proj);
    assert.equal(result.success, true);
    assert.equal(result.assigned, 2);

    const content = readFile(f.tasksPath);
    const matches = [...content.matchAll(/id:\s*"?([0-9a-f]{4})"?/g)].map((m) => m[1]);
    assert.equal(matches.length, 3);
    assert.ok(matches.includes('abcd'));
    assert.equal(new Set(matches).size, 3);
  } finally { f.cleanup(); }
});

test('assignIds is a no-op when every task already has an id', () => {
  const proj = nextProject();
  const f = writeFixture(proj,
    'tasks:\n  - id: "1111"\n    text: A\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n  - id: "2222"\n    text: B\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n');
  try {
    const before = readFile(f.tasksPath);
    const result = assignIds(proj);
    assert.equal(result.success, true);
    assert.equal(result.assigned, 0);
    assert.equal(readFile(f.tasksPath), before);
  } finally { f.cleanup(); }
});

test('assignIds scoped to single project leaves other projects untouched', () => {
  const projA = nextProject();
  const projB = nextProject();
  const fA = writeFixture(projA, 'tasks:\n  - id: ""\n    text: Needs id\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n');
  const fB = writeFixture(projB, 'tasks:\n  - id: ""\n    text: Also needs id\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n');
  try {
    const result = assignIds(projA);
    assert.equal(result.success, true);
    assert.equal(result.assigned, 1);

    const alphaContent = readFile(fA.tasksPath);
    // Should have a real 4-hex id now
    assert.match(alphaContent, /id:\s*"?[0-9a-f]{4}"?/);
    // beta should still have empty id
    const betaContent = readFile(fB.tasksPath);
    assert.match(betaContent, /id:\s*""/);
  } finally { fA.cleanup(); fB.cleanup(); }
});

test('validateIds reports no collisions for unique cross-project ids', () => {
  const projA = nextProject();
  const projB = nextProject();
  // Use IDs highly likely to be unique to avoid collision with other test data
  const idA = 'f0a1';
  const idB = 'f0b2';
  const fA = writeFixture(projA, `tasks:\n  - id: "${idA}"\n    text: A\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n`);
  const fB = writeFixture(projB, `tasks:\n  - id: "${idB}"\n    text: B\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n`);
  try {
    const result = validateIds();
    // Only check that our specific IDs don't collide (other tests may have data)
    assert.deepEqual(result.collisions.filter((c: any) => c.id === idA || c.id === idB), []);
  } finally { fA.cleanup(); fB.cleanup(); }
});

test('validateIds detects cross-project id collisions', () => {
  const projA = nextProject();
  const projB = nextProject();
  // Use a unique ID that won't collide with real tasks
  const collisionId = 'ff01';
  const fA = writeFixture(projA, `tasks:\n  - id: "${collisionId}"\n    text: A\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n`);
  const fB = writeFixture(projB, `tasks:\n  - id: "${collisionId}"\n    text: B\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: default\n    plan: ""\n`);
  try {
    const result = validateIds();
    assert.equal(result.success, false);
    const collision = result.collisions.find(c => c.id === collisionId);
    assert.ok(collision, `should find collision for id ${collisionId}`);
    assert.ok(collision.projects.includes(projA));
    assert.ok(collision.projects.includes(projB));
  } finally { fA.cleanup(); fB.cleanup(); }
});
