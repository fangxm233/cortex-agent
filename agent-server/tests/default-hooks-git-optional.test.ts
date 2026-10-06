import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })));
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-hook-no-git-'));
  homes.push(dir);
  return dir;
}
function hook(name: string, cwd: string, input = '', path = '') {
  return execFileSync(process.execPath, [resolve('defaults/hooks', name)], {
    cwd, input, encoding: 'utf8', env: { ...process.env, CORTEX_HOME: cwd, PATH: path },
  });
}
it('saves memory without a commit demand or Git invocation in a non-repository', () => {
  const dir = home();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho invoked >&2\nexit 90\n', { mode: 0o755 });
  const prompt = hook('new-session-hook.mjs', dir, '', bin);
  expect(prompt).toContain('Save context updates directly to disk');
  expect(prompt).not.toContain('Run `git status`');
  expect(prompt).not.toContain('Commit context file changes');
});
it('records memory access without Git', () => {
  const dir = home();
  hook('memory-ref-tracker.mjs', dir, JSON.stringify({
    tool_name: 'Read', tool_input: { file_path: join(dir, 'context/projects/demo/knowledge/K-001.md') },
  }));
  const record = JSON.parse(readFileSync(join(dir, 'context/projects/demo/_meta/access-log.jsonl'), 'utf8'));
  expect(record.file).toBe('K-001.md');
});
it('keeps commit guidance and existing-change warning inside repositories', () => {
  const dir = home();
  execFileSync('git', ['init', '-q', dir]);
  const nested = join(dir, 'context');
  mkdirSync(nested);
  writeFileSync(join(nested, 'STATUS.md'), 'test');
  const prompt = hook('new-session-hook.mjs', nested, '', process.env.PATH);
  expect(prompt).toContain('Commit context file changes');
  expect(prompt).toContain('already uncommitted changes');
});
