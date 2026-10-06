import { test, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../../../src/core/paths.js';
import { runMemoryCli } from '../../../src/entry/memory-cli.js';
import { runCli } from '../../../src/entry/cli.js';

const OLD = '2025-01-01';

function write(rel: string, content: string): void {
  const file = path.join(PROJECTS_DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(() => {
  write('demo/experiments/EXP-001.md', `---\nid: EXP-001\ndate: ${OLD}\nproject: demo\nsummary: read often\ntags: [a]\n---\nBody\n`);
  // A stale `refs:` field in the source must not count: only the access log does.
  write('demo/experiments/EXP-002.md', `---\nid: EXP-002\ndate: ${OLD}\nproject: demo\nsummary: never read\ntags: [a]\nrefs: 9\n---\nBody\n`);
  write('demo/_meta/access-log.jsonl', '{"file":"EXP-001.md","tool":"Read","ts":"2026-09-01T00:00:00.000Z"}\n');
  write('notes-only/STATUS.md', '# status\n');
});

test('regen rebuilds the indexes of every memory project and reports them as JSON', () => {
  const result = runMemoryCli(['regen']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, projects: [{ project: 'demo', indexes: ['experiments/index.md'] }] });
  assert.ok(fs.existsSync(path.join(PROJECTS_DIR, 'demo', 'experiments', 'index.md')));
});

test('consolidate counts refs from the access log, not from frontmatter', () => {
  const result = runMemoryCli(['consolidate', '--project', 'demo']);
  assert.equal(result.exitCode, 0, result.stderr);
  const { ok, reports } = JSON.parse(result.stdout);
  assert.equal(ok, true);
  assert.deepEqual(reports[0].stale.map((s: { entryId: string }) => s.entryId), ['EXP-002']);

  const text = runMemoryCli(['consolidate', '--text']);
  assert.equal(text.exitCode, 0, text.stderr);
  assert.match(text.stdout, /STALE \(1\):\n {4}EXP-002 \(experiment, \d+d old, 0 refs\)/);
});

test('usage errors name the valid values and exit non-zero', () => {
  const unknownProject = runMemoryCli(['regen', '--project', 'nope']);
  assert.equal(unknownProject.exitCode, 1);
  assert.match(unknownProject.stderr, /Unknown project: 'nope'/);
  assert.match(unknownProject.stderr, /Valid values: demo/);

  const unknownCommand = runMemoryCli(['rebuild']);
  assert.equal(unknownCommand.exitCode, 1);
  assert.match(unknownCommand.stderr, /Valid values: regen, consolidate/);

  const badFlag = runMemoryCli(['regen', '--text']);
  assert.equal(badFlag.exitCode, 1);
  assert.match(badFlag.stderr, /Valid values: --project/);
});

test('cortex memory is wired into the top-level CLI', async () => {
  const help = await runCli(['memory', '--help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /cortex memory regen --project wm-align/);
  const top = await runCli(['--help']);
  assert.match(top.stdout, /memory/);
});
