// input:  Node test runner + domain/threads prompt-builder
// output: resolveTemplateProfiles coverage (hardcoded, __active__, dedup, unknown)
// pos:    Verify template→profile resolution used by task-dispatch rate-limit gating
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { mergeThreadTemplates, loadConfig } from '../../src/domain/threads/template-loader.js';
import { resolveTemplateProfiles } from '../../src/domain/threads/index.js';
import { CONFIG_DIR } from '../../src/core/paths.js';

beforeAll(() => {
  // Self-sufficient template fixture: ensure defaults templates exist in the isolated
  // CORTEX_HOME even when this file is run standalone (empty-skeleton home).
  mergeThreadTemplates(
    path.resolve(process.cwd(), 'defaults/config/thread-templates'),
    path.join(CONFIG_DIR, 'thread-templates'),
  );
  loadConfig();
});

test('resolveTemplateProfiles collects hardcoded agent profiles in slot order', () => {
  // defaults: coder-review = coder(plan) + coder-reviewer(execute)
  assert.deepEqual(resolveTemplateProfiles('coder-review', 'dispatch-prof'), ['plan', 'execute']);
});

test('resolveTemplateProfiles dedupes repeated profiles', () => {
  // defaults: execute-review = executor(execute) + executor-reviewer(execute)
  assert.deepEqual(resolveTemplateProfiles('execute-review', 'dispatch-prof'), ['execute']);
});

test('resolveTemplateProfiles maps __active__ agents to the provided active profile', () => {
  // defaults: default template = __active__ ref → main agent (profile __active__)
  assert.deepEqual(resolveTemplateProfiles('default', 'plan'), ['plan']);
});

test('resolveTemplateProfiles drops __active__ slots when no active profile is provided', () => {
  assert.deepEqual(resolveTemplateProfiles('default', null), []);
});

test('resolveTemplateProfiles returns [] for unknown template (fail-open)', () => {
  assert.deepEqual(resolveTemplateProfiles('nonexistent-template-xyz', 'plan'), []);
});
