import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  _resetSubagentRuns, hasRunningBackgroundRuns, startSubagentRun, stopSubagentRun,
} from '../../../src/domain/agents/subagent/registry.js';
import { emptyUsage } from '@core/agents/subagent/usage.js';
import type { Invocation } from '@core/agents/subagent/types.js';

const INVOCATION: Invocation = {
  mode: 'single',
  tasks: [{ description: 'dig', prompt: 'p', subagent_type: 'general-purpose' }],
};

/** A run that stays `running` until its abort signal fires. */
function start(sessionId: string, background: boolean): string {
  return startSubagentRun({
    invocation: INVOCATION, sessionId, background,
    execute: (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({
        content: [{ type: 'text', text: 'stopped' }],
        details: { mode: 'single', results: [], usage: emptyUsage() },
      }));
    }),
  }).id;
}

afterEach(() => _resetSubagentRuns());

test('hasRunningBackgroundRuns counts only a running background run of that session', async () => {
  start('s-fg', false);
  start('s-other', true);
  assert.equal(hasRunningBackgroundRuns('s-fg'), false);
  assert.equal(hasRunningBackgroundRuns('s-bg'), false);
  const id = start('s-bg', true);
  assert.equal(hasRunningBackgroundRuns('s-bg'), true);
  stopSubagentRun(id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(hasRunningBackgroundRuns('s-bg'), false);
});
