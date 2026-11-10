// A Claude Code update must retire idle pooled processes, which still run the old binary: the
// install count is part of the pool's reuse identity.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { claudeSpecIdentity } from '../../src/agent-adapter/claude/adapter.js';
import { bumpClaudeCliGeneration } from '../../src/agent-adapter/claude/cli-generation.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

test('an installed Claude Code update changes the identity of every spec', () => {
  const spec = engineSpecFixture({ sessionKey: 'gen' });
  const before = claudeSpecIdentity(spec);
  bumpClaudeCliGeneration();
  const after = claudeSpecIdentity(spec);
  assert.notEqual(after, before);
  assert.equal(after, claudeSpecIdentity(engineSpecFixture({ sessionKey: 'gen' })), 'stable between updates');
});
