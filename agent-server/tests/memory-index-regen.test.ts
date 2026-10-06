import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateIndex, parseFrontmatter } from '../src/domain/memory/index-regen.js';

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
    assert.match(index, /\| K-005 \|/);

    assert.match(index, /## Superseded \/ Deprecated \(2 entries\)/);
    assert.match(index, /\| K-004 \|/);
    assert.match(index, /\| K-006 \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generateIndex never rewrites atomic files and takes refs from the access log', () => {
  const root = mkTemp('index-regen-readonly-');
  const projectDir = path.join(root, 'demo');
  const expDir = path.join(projectDir, 'experiments');
  try {
    // Every shape the old hand-rolled serializer mangled: quoted items with commas, braces,
    // backslashes, a block list, a block scalar, a comment, and no refs fields at all.
    const source = [
      '---',
      'id: EXP-001',
      'date: 2026-09-26',
      'project: demo',
      '# authored comment',
      'summary: M2c tuning slides along one axis ("punish high supply"); choked A stays ≈$31k',
      'tags: [balance, market]',
      'evidence: ["my-pc D:/Projects/m2c-sweep2/*.txt (55 configs, 10 seeds each)", "runs/seed{1,2}-arm{2,3}/metrics.json", "C:\\\\data\\\\x"]',
      'links:',
      '  - EXP-000',
      '  - K-001',
      'notes: |',
      '  line one',
      '  line two',
      'refs: 0',
      'last-ref: null',
      '---',
      '',
      '## EXP-001',
      '',
    ].join('\n');
    const bare = '---\nid: EXP-002\ndate: 2026-09-27\nproject: demo\nsummary: no refs fields\ntags: [x]\n---\nBody\n';
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, 'EXP-001.md'), source);
    fs.writeFileSync(path.join(expDir, 'EXP-002.md'), bare);
    fs.mkdirSync(path.join(projectDir, '_meta'));
    fs.writeFileSync(path.join(projectDir, '_meta', 'access-log.jsonl'), [
      '{"file":"EXP-001.md","tool":"Read","ts":"2026-09-27T01:00:00.000Z"}',
      '{"file":"EXP-001.md","tool":"Grep","ts":"2026-09-28T02:00:00.000Z"}',
      'not json',
      '',
    ].join('\n'));

    generateIndex(expDir, 'Experiments Index — demo');
    generateIndex(expDir, 'Experiments Index — demo');

    assert.equal(fs.readFileSync(path.join(expDir, 'EXP-001.md'), 'utf8'), source);
    assert.equal(fs.readFileSync(path.join(expDir, 'EXP-002.md'), 'utf8'), bare);
    const index = fs.readFileSync(path.join(expDir, 'index.md'), 'utf8');
    assert.match(index, /\| EXP-001 \| 2026-09-26 \| M2c tuning .* \| `balance`, `market` \| 2 \| 2026-09-28 \| EXP-000, K-001 \|/);
    assert.match(index, /\| EXP-002 \| 2026-09-27 \| no refs fields \| `x` \| 0 \|  \|  \|/);
    assert.ok(index.indexOf('| EXP-001 |') < index.indexOf('| EXP-002 |'), 'sorted by access-log refs');
    assert.deepEqual(fs.readdirSync(expDir).sort(), ['EXP-001.md', 'EXP-002.md', 'index.md'], 'no temp files left behind');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontmatter that is not valid YAML is still indexed and flagged', () => {
  const root = mkTemp('index-regen-lenient-');
  const knowledgeDir = path.join(root, 'demo', 'knowledge');
  try {
    writeAtomicEntry(
      path.join(knowledgeDir, 'K-043.md'),
      'id: K-043\ntitle: "dev rebuild compiles the working tree"\nstatus: active\nevidence: [logs/server.log 12:18:26, git reflog HEAD@{3-4}]',
    );
    const { meta, valid } = parseFrontmatter(fs.readFileSync(path.join(knowledgeDir, 'K-043.md'), 'utf8'));
    assert.equal(valid, false);
    assert.equal(meta.id, 'K-043');
    assert.equal(meta.title, 'dev rebuild compiles the working tree');
    assert.equal(meta.evidence, '[logs/server.log 12:18:26, git reflog HEAD@{3-4}]');

    generateIndex(knowledgeDir, 'Knowledge Index — demo');
    const index = fs.readFileSync(path.join(knowledgeDir, 'index.md'), 'utf8');
    assert.match(index, /\| K-043 \| dev rebuild compiles the working tree \|/);
    assert.match(index, /Invalid YAML frontmatter \(fix the file\): K-043\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('table cells cannot break their row', () => {
  const root = mkTemp('index-regen-cells-');
  const patternsDir = path.join(root, 'demo', 'patterns');
  try {
    writeAtomicEntry(path.join(patternsDir, 'PAT-001.md'), 'id: PAT-001\nsummary: "a | b\\nc"\ntags: [t]\nsource-experiments: [EXP-001, 7]');
    generateIndex(patternsDir, 'Patterns Index — demo');
    const index = fs.readFileSync(path.join(patternsDir, 'index.md'), 'utf8');
    assert.match(index, /\| PAT-001 \| a \\\| b c \| `t` \| EXP-001, 7 \| 0 \|  \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
