import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setSubagentModelSource, subagentModelEnv } from '../../src/agent-adapter/claude/spawn-args.js';
import { ANTHROPIC_MODELS } from '../../src/core/anthropic-models.js';
import { decodeHandedModels } from '../../src/core/agents/subagent/catalog.js';

test('the Claude list is handed down unless it is the shipped table or unknown; empty means none', () => {
  setSubagentModelSource(() => ({ pi: [], claude: null }));
  assert.equal(subagentModelEnv().CORTEX_SUBAGENT_CLAUDE_MODELS, undefined);

  setSubagentModelSource(() => ({ pi: [], claude: [...ANTHROPIC_MODELS] }));
  assert.equal(subagentModelEnv().CORTEX_SUBAGENT_CLAUDE_MODELS, undefined);

  setSubagentModelSource(() => ({ pi: [], claude: [] }));
  assert.deepEqual(decodeHandedModels(subagentModelEnv().CORTEX_SUBAGENT_CLAUDE_MODELS), []);

  setSubagentModelSource(() => ({ pi: [{ provider: 'p', id: 'm' }], claude: ['claude-x'] }));
  const env = subagentModelEnv();
  assert.deepEqual(decodeHandedModels(env.CORTEX_SUBAGENT_CLAUDE_MODELS), [{ backend: 'claude', id: 'claude-x' }]);
  assert.deepEqual(JSON.parse(env.CORTEX_SUBAGENT_PI_MODELS!), [{ backend: 'pi', provider: 'p', id: 'm' }]);
});
