import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRules, parseRuleFrontmatter, MAX_CONTEXT_CHARS } from '../../../defaults/hooks/cortex-context-lib.mjs';
import { loadCortexRules } from '../../../src/domain/memory/rules-loader.js';
import { AgentsMDInjector } from '../../../src/domain/memory/agents-md-injector.js';

const RULES_HOOK = path.resolve(__dirname, '../../../defaults/hooks/rules-loader.mjs');

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('only the paths key holds rule paths', () => {
  const tagged = parseRuleFrontmatter('---\ntitle: global\ntags:\n  - meta\n  - "style"\n---\nbody\n');
  assert.deepEqual(tagged, { paths: [], body: 'body\n' });

  const block = parseRuleFrontmatter('---\nowner: me\npaths:\n  - "context/**/AGENTS.md"\n\n  # comment\n  - \'x/*.md\'\nnext:\n  - not-a-path\n---\nb');
  assert.deepEqual(block.paths, ['context/**/AGENTS.md', 'x/*.md']);

  const flow = parseRuleFrontmatter('---\r\npaths: ["src/{a,b}/**", docs/*.md]\r\n---\r\nb');
  assert.deepEqual(flow, { paths: ['src/{a,b}/**', 'docs/*.md'], body: 'b' });

  assert.deepEqual(parseRuleFrontmatter('---\npaths: "only/**"\n---\n').paths, ['only/**']);
  assert.deepEqual(parseRuleFrontmatter('no frontmatter\n- x\n'), { paths: [], body: 'no frontmatter\n- x\n' });
});

test('rules load in file-name order on both sides', () => {
  const dir = tmp('rules-order-');
  try {
    for (const name of ['c.md', 'a.md', 'b.md']) fs.writeFileSync(path.join(dir, name), `${name}\n`);
    fs.writeFileSync(path.join(dir, 'scoped.md'), '---\npaths:\n  - "x/**"\n---\nscoped\n');
    fs.writeFileSync(path.join(dir, 'tagged.md'), '---\ntags:\n  - y\n---\ntagged\n');
    assert.deepEqual(loadRules(dir).map((r) => r.file), ['a.md', 'b.md', 'c.md', 'scoped.md', 'tagged.md']);
    assert.deepEqual(loadCortexRules(dir), ['a.md\n', 'b.md\n', 'c.md\n', 'tagged\n']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rules-loader hook applies a scoped rule once per session and ignores non-path lists', () => {
  const home = tmp('rules-hook-home-');
  try {
    fs.mkdirSync(path.join(home, 'rules'));
    fs.writeFileSync(path.join(home, 'rules', 'scoped.md'), '---\npaths:\n  - "proj/**"\n---\nSCOPED RULE\n');
    fs.writeFileSync(path.join(home, 'rules', 'tagged.md'), '---\ntags:\n  - "proj/**"\n---\nTAGGED GLOBAL\n');
    const run = () => {
      const result = spawnSync(process.execPath, [RULES_HOOK], {
        input: JSON.stringify({ session_id: 'rules-s1', tool_name: 'Read', tool_input: { file_path: '/w/proj/a.md' } }),
        encoding: 'utf8',
        env: { ...process.env, CORTEX_HOME: home },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const first = run();
    assert.match(first, /SCOPED RULE/);
    assert.doesNotMatch(first, /TAGGED GLOBAL/);
    assert.equal(run(), '', 'deduped within the session');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'tmp', 'rules-cache', 'rules-s1.json'), 'utf8')), ['scoped.md']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('MCP-side injection keeps to the same inline budget and leaves overflow uncached', () => {
  const cacheDir = tmp('agents-budget-');
  try {
    const inj = new AgentsMDInjector({ sessionId: 'budget', cacheDir });
    const big = 'x'.repeat(MAX_CONTEXT_CHARS - 300);
    const entries = [
      { path: '/r/a/AGENTS.md', content: big, mtimeMs: 1 },
      { path: '/r/AGENTS.md', content: 'second', mtimeMs: 1 },
    ];
    const first = inj.buildBlocks('lab', entries);
    assert.equal(first.length, 2);
    assert.ok(first[0].text.includes(big));
    assert.match(first[1].text, /1 AGENTS rule file\(s\) were too large to inline here[\s\S]*- lab:\/r\/AGENTS\.md/);

    const second = inj.buildBlocks('lab', entries);
    assert.equal(second.length, 1, 'the inlined entry is cached, the overflowed one is offered again');
    assert.ok(second[0].text.includes('second'));
    assert.equal(inj.buildBlocks('lab', entries).length, 0);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
