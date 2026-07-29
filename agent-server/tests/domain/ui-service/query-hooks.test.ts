// input:  fixture registry, template and script directories
// output: hooks.list DTO derivation tests
// pos:    Verifies the hooks read model exposed to the UI
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';

import { readHooksOverview } from '../../../src/domain/ui-service/query/hooks.js';

interface Dirs {
  registry: string;
  templates: string;
  scripts: string;
}

function makeDirs(t: { onTestFinished(callback: () => void): void }): Dirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-overview-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = {
    registry: path.join(root, 'hooks'),
    templates: path.join(root, 'templates'),
    scripts: path.join(root, 'scripts'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

function writeJson(dir: string, filename: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, filename), `${JSON.stringify(body, null, 2)}\n`);
}

function find(overview: { hooks: { id: string }[] }, id: string): any {
  const hook = overview.hooks.find((candidate) => candidate.id === id);
  assert.ok(hook, `expected hook ${id} in the overview`);
  return hook;
}

test('maps a registry declaration into the full detail DTO', (t) => {
  const dirs = makeDirs(t);
  fs.writeFileSync(path.join(dirs.scripts, 'guard.mjs'), '');
  writeJson(dirs.registry, '01-guard.json', {
    id: 'guard',
    event: 'agent:pre-tool',
    matcher: 'Edit|Write',
    run: { script: 'guard.mjs', timeout: 10 },
    scope: { backends: ['claude'], requiresTool: 'Edit' },
    version: '2026.7.29',
  });

  const hook = find(readHooksOverview(dirs.registry, dirs.templates, dirs.scripts), 'guard');

  assert.equal(hook.event, 'agent:pre-tool');
  assert.equal(hook.matcher, 'Edit|Write');
  assert.equal(hook.matcherFilters, null);
  assert.deepEqual(hook.run, { script: 'guard.mjs', command: null, timeoutSec: 10 });
  assert.deepEqual(hook.scope, { backends: ['claude'], requiresTool: 'Edit' });
  assert.equal(hook.source, 'managed');
  assert.equal(hook.version, '2026.7.29');
  assert.equal(hook.fileName, '01-guard.json');
  assert.equal(hook.enabled, true);
  assert.equal(hook.editable, false);
  assert.equal(hook.scriptExists, true);
  assert.deepEqual(hook.mountsOn, ['claude']);
  assert.equal(hook.appliesAt, 'next-agent');
});

test('a user declaration is editable and carries no version', (t) => {
  const dirs = makeDirs(t);
  fs.writeFileSync(path.join(dirs.scripts, 'mine.mjs'), '');
  writeJson(dirs.registry, '50-mine.json', {
    id: 'mine',
    event: 'cortex:session.new',
    run: { script: 'mine.mjs' },
    result: 'stdout-as-prompt',
  });

  const hook = find(readHooksOverview(dirs.registry, dirs.templates, dirs.scripts), 'mine');

  assert.equal(hook.source, 'user');
  assert.equal(hook.editable, true);
  assert.equal(hook.version, null);
  assert.equal(hook.result, 'stdout-as-prompt');
  assert.deepEqual(hook.legalResults, ['none', 'stdout-as-prompt']);
  assert.deepEqual(hook.mountsOn, ['server']);
  assert.equal(hook.appliesAt, 'server-restart');
  assert.equal(hook.run.timeoutSec, null);
});

test('an object matcher lands in matcherFilters, not matcher', (t) => {
  const dirs = makeDirs(t);
  writeJson(dirs.registry, '50-scoped.json', {
    id: 'scoped',
    event: 'cortex:thread.end',
    matcher: { source: 'task-dispatch' },
    run: { command: 'true' },
  });

  const hook = find(readHooksOverview(dirs.registry, dirs.templates, dirs.scripts), 'scoped');

  assert.equal(hook.matcher, null);
  assert.deepEqual(hook.matcherFilters, { source: 'task-dispatch' });
  assert.deepEqual(hook.run, { script: null, command: 'true', timeoutSec: null });
  assert.equal(hook.scriptExists, null, 'a command hook has no script to resolve');
});

test('flags a declaration whose script is missing from disk', (t) => {
  const dirs = makeDirs(t);
  writeJson(dirs.registry, '50-broken.json', {
    id: 'broken',
    event: 'agent:post-tool',
    run: { script: 'not-there.mjs' },
  });

  assert.equal(find(readHooksOverview(dirs.registry, dirs.templates, dirs.scripts), 'broken').scriptExists, false);
});

test('template hooks are listed, read-only, and carry their phase', (t) => {
  const dirs = makeDirs(t);
  writeJson(dirs.templates, 'coder-review.json', {
    name: 'coder-review',
    hooks: { onEnd: { command: 'node post-task.mjs', args: ['reviewer'], timeout: 10000 } },
  });

  const hook = find(readHooksOverview(dirs.registry, dirs.templates, dirs.scripts), 'template:coder-review:end');

  assert.equal(hook.source, 'template-scoped');
  assert.equal(hook.editable, false);
  assert.equal(hook.template, 'coder-review');
  assert.equal(hook.phase, 'end');
  assert.equal(hook.event, 'cortex:thread.end');
  assert.equal(hook.fileName, null);
  assert.equal(hook.run.command, 'node post-task.mjs');
});

test('order follows the registry load order, which is the execution order', (t) => {
  const dirs = makeDirs(t);
  writeJson(dirs.registry, '02-second.json', { id: 'second', event: 'agent:pre-tool', run: { command: 'true' } });
  writeJson(dirs.registry, '01-first.json', { id: 'first', event: 'agent:pre-tool', run: { command: 'true' } });

  const overview = readHooksOverview(dirs.registry, dirs.templates, dirs.scripts);

  assert.deepEqual(overview.hooks.map((h) => h.id).slice(0, 2), ['first', 'second']);
  assert.equal(find(overview, 'first').order, 0);
  assert.equal(find(overview, 'second').order, 1);
});

test('lists available scripts with the hooks that reference them', (t) => {
  const dirs = makeDirs(t);
  fs.writeFileSync(path.join(dirs.scripts, 'used.mjs'), '');
  fs.writeFileSync(path.join(dirs.scripts, 'spare.mjs'), '');
  fs.writeFileSync(path.join(dirs.scripts, 'notes.txt'), '');
  writeJson(dirs.registry, '50-a.json', { id: 'a', event: 'agent:pre-tool', run: { script: 'used.mjs' } });
  writeJson(dirs.registry, '51-b.json', { id: 'b', event: 'agent:post-tool', run: { script: 'used.mjs' } });

  const { scripts } = readHooksOverview(dirs.registry, dirs.templates, dirs.scripts);

  assert.deepEqual(scripts.map((s) => s.name), ['spare.mjs', 'used.mjs']);
  assert.deepEqual(scripts.find((s) => s.name === 'used.mjs')!.usedBy, ['a', 'b']);
  assert.deepEqual(scripts.find((s) => s.name === 'spare.mjs')!.usedBy, []);
});

test('a script invoked through a raw command still counts as used', (t) => {
  const dirs = makeDirs(t);
  fs.writeFileSync(path.join(dirs.scripts, 'post-task-hook.mjs'), '');
  // Template hooks and command-based registry entries reference scripts by command string, not by
  // run.script. Reporting those as unused would invite deleting a script that is live.
  writeJson(dirs.templates, 'coder-review.json', {
    name: 'coder-review',
    hooks: { onEnd: { command: 'node ~/.cortex/hooks/post-task-hook.mjs', args: ['coder'] } },
  });
  writeJson(dirs.registry, '50-cmd.json', {
    id: 'cmd',
    event: 'agent:pre-tool',
    run: { command: 'node /somewhere/post-task-hook.mjs' },
  });

  const { scripts } = readHooksOverview(dirs.registry, dirs.templates, dirs.scripts);

  assert.deepEqual(scripts[0].usedBy, ['cmd', 'template:coder-review:end']);
});

test('a substring collision does not count as usage', (t) => {
  const dirs = makeDirs(t);
  fs.writeFileSync(path.join(dirs.scripts, 'task.mjs'), '');
  writeJson(dirs.registry, '50-cmd.json', {
    id: 'cmd',
    event: 'agent:pre-tool',
    run: { command: 'node /somewhere/post-task.mjs' },
  });

  const { scripts } = readHooksOverview(dirs.registry, dirs.templates, dirs.scripts);

  assert.deepEqual(scripts[0].usedBy, []);
});

test('missing directories yield an empty overview rather than throwing', (t) => {
  const dirs = makeDirs(t);
  const overview = readHooksOverview(
    path.join(dirs.registry, 'nope'),
    path.join(dirs.templates, 'nope'),
    path.join(dirs.scripts, 'nope'),
  );
  assert.deepEqual(overview.hooks, []);
  assert.deepEqual(overview.scripts, []);
});
