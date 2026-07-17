// input:  Node test runner + dispatch-utils module
// output: registry loading + taskId + session naming tests
// pos:    Verify device registry and ID/naming generation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { generateTaskId, buildDispatchSessionName, getMachineRegistry } from '../src/domain/tasks/dispatch-utils.js';

test('generateTaskId returns four hex characters', () => {
  const taskId = generateTaskId();
  assert.match(taskId, /^[0-9a-f]{4}$/);
});

test('buildDispatchSessionName formats task-dispatch session names from task ids', () => {
  assert.equal(buildDispatchSessionName('abcd'), 'task-dispatch-abcd');
});

test('getMachineRegistry() entries have required fields', () => {
  const registry = getMachineRegistry();
  for (const [name, entry] of Object.entries(registry)) {
    assert.equal(typeof entry.cortexPath, 'string', `${name}.cortexPath should be string`);
    assert.equal(typeof entry.gpuCount, 'number', `${name}.gpuCount should be number`);
  }
});
