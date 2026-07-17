// input:  Node test runner + memory-index-regen generateIndex
// output: lifecycle status section + guidance tests
// pos:    Verify index rebuild lifecycle partition behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateIndex } from '../src/domain/memory/index-regen.js';

function mkTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAtomicEntry(filePath: string, frontmatter: string, body = 'Body\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}`);
}

test('generateIndex separates invalidated from stale/superseded and keeps challenged/corrected active', () => {
  const root = mkTemp('index-regen-lifecycle-');
  const knowledgeDir = path.join(root, 'demo', 'knowledge');

  try {
    writeAtomicEntry(path.join(knowledgeDir, 'K-001.md'), 'id: K-001\nproject: demo\ntitle: "valid"\nstatus: valid\nrefs: 0\nlast-ref: null');
    writeAtomicEntry(path.join(knowledgeDir, 'K-002.md'), 'id: K-002\nproject: demo\ntitle: "challenged"\nstatus: challenged:EXP-900\nrefs: 0\nlast-ref: null');
    writeAtomicEntry(path.join(knowledgeDir, 'K-003.md'), 'id: K-003\nproject: demo\ntitle: "corrected"\nstatus: corrected:EXP-901\nrefs: 0\nlast-ref: null');
    writeAtomicEntry(path.join(knowledgeDir, 'K-004.md'), 'id: K-004\nproject: demo\ntitle: "stale"\nstatus: stale\nrefs: 0\nlast-ref: null');
    writeAtomicEntry(path.join(knowledgeDir, 'K-005.md'), 'id: K-005\nproject: demo\ntitle: "invalidated"\nstatus: invalidated:EXP-902\nrefs: 0\nlast-ref: null');
    writeAtomicEntry(path.join(knowledgeDir, 'K-006.md'), 'id: K-006\nproject: demo\ntitle: "superseded"\nstatus: superseded:EXP-903\nrefs: 0\nlast-ref: null');

    generateIndex(knowledgeDir, 'Knowledge Index — demo');

    const index = fs.readFileSync(path.join(knowledgeDir, 'index.md'), 'utf8');

    assert.match(index, /## Active \(3 entries\)/);
    assert.match(index, /\| K-001 \|/);
    assert.match(index, /\| K-002 \|/);
    assert.match(index, /\| K-003 \|/);

    assert.match(index, /## Invalidated \(1 entries\)/);
    assert.match(index, /Do NOT use their conclusions/);
    assert.match(index, /\| K-005 \|/);

    assert.match(index, /## Superseded \/ Deprecated \(2 entries\)/);
    assert.match(index, /\| K-004 \|/);
    assert.match(index, /\| K-006 \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generateIndex includes Use when guidance for empty knowledge and patterns indexes', () => {
  const root = mkTemp('index-regen-use-when-');

  const knowledgeDir = path.join(root, 'demo', 'knowledge');
  const patternsDir = path.join(root, 'demo', 'patterns');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(patternsDir, { recursive: true });

  try {
    generateIndex(knowledgeDir, 'Knowledge Index — demo');
    generateIndex(patternsDir, 'Patterns Index — demo');

    const knowledgeIndex = fs.readFileSync(path.join(knowledgeDir, 'index.md'), 'utf8');
    const patternsIndex = fs.readFileSync(path.join(patternsDir, 'index.md'), 'utf8');

    assert.match(knowledgeIndex, /Use when: applying validated facts\/principles to current work/);
    assert.match(patternsIndex, /Use when: looking for cross-experiment regularities/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
