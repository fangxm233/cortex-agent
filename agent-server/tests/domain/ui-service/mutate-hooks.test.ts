import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';

import { hookDraftFromArgs } from '../../../src/domain/ui-service/mutate/hooks.js';
import { hookProcessOptions, type MountedHook } from '../../../src/store/hook-registry.js';

test('rebuilds the nested run shape from flat form fields', () => {
  const draft = hookDraftFromArgs({ event: 'agent:pre-tool', script: 'x.mjs', timeoutSec: 12 });
  assert.deepEqual(draft.run, { script: 'x.mjs', timeout: 12 });
  assert.equal(draft.event, 'agent:pre-tool');
});

test('omitted fields stay absent so the writer drops them', () => {
  const draft = hookDraftFromArgs({ event: 'agent:pre-tool', script: 'x.mjs' });
  assert.equal('matcher' in draft, false);
  assert.equal('scope' in draft, false);
  assert.equal('result' in draft, false);
  assert.equal('enabled' in draft, false);
  assert.equal(draft.run.timeout, undefined);
});

test('a regex matcher wins when both matcher forms are supplied', () => {
  const draft = hookDraftFromArgs({
    event: 'agent:pre-tool',
    script: 'x.mjs',
    matcher: 'Edit',
    matcherFilters: { source: 'x' },
  });
  assert.equal(draft.matcher, 'Edit');
});

test('blocking can never be set from the flat draft', () => {
  const draft = hookDraftFromArgs({ event: 'agent:pre-tool', script: 'x.mjs' } as never);
  assert.equal('blocking' in draft, false);
});

// ── test-run timeout clamp ────────────────────────────────────────

function registryHook(timeout?: number): MountedHook {
  return {
    kind: 'registry',
    id: 'blocking-hook',
    event: 'agent:pre-tool',
    enabled: true,
    source: 'builtin',
    overridden: false,
    entry: { id: 'blocking-hook', event: 'agent:pre-tool', run: { script: 'ask.mjs', timeout } },
    filePath: '/tmp/x.json',
  } as MountedHook;
}

const NO_SCRIPTS = { user: '/hooks', builtin: null };

test('clamps a long declared timeout so a blocking hook cannot park the request', () => {
  assert.equal(hookProcessOptions(registryHook(1800), NO_SCRIPTS, '{}', 15_000).timeoutMs, 15_000);
});

test('resolves a script against the hooks directory with quoting', () => {
  assert.equal(hookProcessOptions(registryHook(5), NO_SCRIPTS, '{}', 15_000).command, "node '/hooks/ask.mjs'");
});

test('a shipped script runs in place; a user copy runs with the helper fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-scripts-'));
  try {
    const dirs = { user: path.join(root, 'user'), builtin: path.join(root, 'shipped') };
    fs.mkdirSync(dirs.user);
    fs.mkdirSync(dirs.builtin);
    fs.writeFileSync(path.join(dirs.builtin, 'ask.mjs'), '');
    assert.equal(hookProcessOptions(registryHook(5), dirs, '{}').command, `node '${path.join(dirs.builtin, 'ask.mjs')}'`);

    fs.writeFileSync(path.join(dirs.user, 'ask.mjs'), '');
    const command = hookProcessOptions(registryHook(5), dirs, '{}').command!;
    assert.match(command, /^node '--import' 'file:\/\/[^']*\/hooks\/overlay\/register\.mjs' /);
    assert.ok(command.endsWith(`'${path.join(dirs.user, 'ask.mjs')}'`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
