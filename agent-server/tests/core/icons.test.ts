import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { Icons } from '../../src/core/icons.js';

describe('Icons', () => {
  it('exports all expected icon names', () => {
    const keys = Object.keys(Icons).sort();
    assert.deepEqual(keys, [
      'add',
      'arrowLeft',
      'arrowRight',
      'blocked',
      'brain',
      'desktop',
      'edit',
      'error',
      'folder',
      'hook',
      'inbox',
      'memo',
      'noEntry',
      'ok',
      'paused',
      'pending',
      'processing',
      'refresh',
      'repeat',
      'reply',
      'resume',
      'satellite',
      'scheduled',
      'scroll',
      'stopped',
      'stopwatch',
      'superseded',
      'tools',
      'waiting',
      'warning',
      'wave',
    ]);
  });

  it('each icon is a non-empty string', () => {
    for (const [key, value] of Object.entries(Icons)) {
      assert.equal(typeof value, 'string', `${key} must be a string`);
      assert.ok(value.length >= 1, `${key} must not be empty`);
    }
  });
});
