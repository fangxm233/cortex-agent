import assert from 'node:assert/strict';
import { test } from 'vitest';
import { subscriptionModesFor } from '../../../src/domain/costs/subscription-modes.js';

test('a PI OAuth login makes its own gateway mode a subscription, never a Claude Code relay mode', () => {
  const modes = subscriptionModesFor(['plan'], new Set(['openai', 'anthropic']));
  assert.deepEqual([...modes], ['plan', 'openai', 'pi-anthropic']);
});
