// input:  active Claude capture registry
// output: path/pair registration and release coverage
// pos:    verifies retention-visible active capture tracking

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ActiveClaudeCaptureRegistry } from '../src/agent-adapter/claude/active-capture-registry.js';

test('active capture registry exposes paths/pairs while registered and clears on release', () => {
  const registry = new ActiveClaudeCaptureRegistry();
  const release = registry.register('pair-1', ['/tmp/a.jsonl', '/tmp/a.txt']);

  assert.deepEqual(new Set(registry.listPairs()), new Set(['pair-1']));
  assert.deepEqual(new Set(registry.listPaths()), new Set(['/tmp/a.jsonl', '/tmp/a.txt']));

  release();
  assert.deepEqual(registry.listPairs(), []);
  assert.deepEqual(registry.listPaths(), []);
});

test('active capture registry ref-counts duplicate pair registration', () => {
  const registry = new ActiveClaudeCaptureRegistry();
  const releaseA = registry.register('pair-1', ['/tmp/a.jsonl']);
  const releaseB = registry.register('pair-1', ['/tmp/a.txt']);

  assert.deepEqual(new Set(registry.listPaths()), new Set(['/tmp/a.jsonl', '/tmp/a.txt']));
  releaseA();
  assert.deepEqual(registry.listPairs(), ['pair-1']);
  releaseB();
  assert.deepEqual(registry.listPairs(), []);
});
