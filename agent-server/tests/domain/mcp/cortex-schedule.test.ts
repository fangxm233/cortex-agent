import { test } from 'vitest';
import assert from 'node:assert/strict';
import { projectFromTarget } from '../../../src/domain/mcp/tools/schedule.js';
import type { CortexContextInternal } from '../../../src/domain/mcp/tools/context.js';

const FULL_CTX: CortexContextInternal = {
  channel: 'C123',
  sessionId: 'sess-uuid-1',
  sessionName: 'cortex-abc111',
  profile: 'fast-worker',
  project: 'cortex-self',
  backend: 'claude',
  scheduleTaskId: null,
  callbackSource: null,
};

test('projectFromTarget: "current-project" names the session project', () => {
  assert.equal(projectFromTarget('current-project', FULL_CTX), 'cortex-self');
});

test('projectFromTarget: an explicit project target names its projectId', () => {
  assert.equal(projectFromTarget({ kind: 'project', projectId: 'my-project' }, FULL_CTX), 'my-project');
});

test('projectFromTarget: "fresh" and an absent target leave the project open', () => {
  assert.equal(projectFromTarget('fresh', FULL_CTX), null);
  assert.equal(projectFromTarget({ kind: 'fresh' }, FULL_CTX), null);
  assert.equal(projectFromTarget(undefined, FULL_CTX), null);
});

test('projectFromTarget: "current-project" without a session project throws', () => {
  assert.throws(() => projectFromTarget('current-project', { ...FULL_CTX, project: null }), /current-project.*project/i);
});
