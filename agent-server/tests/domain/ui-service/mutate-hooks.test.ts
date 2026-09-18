import assert from 'node:assert/strict';
import { test } from 'vitest';

import { hookDraftFromArgs, testProcessOptions } from '../../../src/domain/ui-service/mutate/hooks.js';
import type { MountedHook } from '../../../src/store/hook-registry.js';

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
    source: 'managed',
    entry: { id: 'blocking-hook', event: 'agent:pre-tool', run: { script: 'ask.mjs', timeout } },
    filePath: '/tmp/x.json',
  } as MountedHook;
}

test('clamps a long declared timeout so a blocking hook cannot park the request', () => {
  assert.equal(testProcessOptions(registryHook(1800), '/hooks', '{}').timeoutMs, 15_000);
});

test('resolves a script against the hooks directory with quoting', () => {
  assert.equal(testProcessOptions(registryHook(5), '/hooks', '{}').command, "node '/hooks/ask.mjs'");
});

test('clamps template hooks too, whose timeout is already in milliseconds', () => {
  const template = {
    kind: 'template',
    id: 'template:x:end',
    event: 'cortex:thread.end',
    enabled: true,
    source: 'template-scoped',
    run: { command: 'node post.mjs', args: ['reviewer'], timeout: 30_000 },
    template: 'x',
    phase: 'end',
  } as MountedHook;

  const options = testProcessOptions(template, '/hooks', '{}');
  assert.equal(options.timeoutMs, 15_000);
  assert.deepEqual(options.args, ['reviewer']);
});
