import { test } from 'vitest';
import assert from 'node:assert/strict';

import { remainingBg } from '../../src/agent-adapter/bg-wait.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';

function baseResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: 's-bg', total_cost_usd: 0.02, num_turns: 3,
    rateLimited: false, rateLimitMessage: null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    finalOutput: 'base output',
    pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0,
    ...overrides,
  };
}

test('remainingBg: running + undelivered summed; absent fields are 0', () => {
  assert.equal(remainingBg(baseResult({ pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 2 })), 3);
  assert.equal(remainingBg(baseResult({ pendingBackgroundTasks: undefined, undeliveredBackgroundTasks: undefined })), 0);
});
