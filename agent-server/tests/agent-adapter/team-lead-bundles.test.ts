import { test } from 'vitest';
import assert from 'node:assert/strict';
import { engineSpecFixture } from '../engine-spec-fixture.js';
import { resolveClaudeMcpBundles } from '../../src/agent-adapter/claude/spawn-args.js';
import { claudeSpecIdentity } from '../../src/agent-adapter/claude/adapter.js';
import {
  buildSessionRequest, sessionIdentity, PI_TEAM_LEAD_ENV, PI_MCP_COMPOSITION_ENV, PI_INTERACTION_BRIDGE_ENV,
} from '../../src/agent-adapter/pi/session-options.js';
import { buildServerStates } from '../../src/agent-adapter/pi/mcp-bridge.js';
import { buildChildEnv } from '../../src/agent-adapter/pi/child-runner.js';
import type { McpComposition } from '../../src/agent-adapter/types.js';

const WEB = { tools: null, needsResume: false, sessionId: 'uuid', loadWebMcp: true, isUserInitiated: true } as const;

test('Claude: a lead gets cortex-workers beside the interaction bridge; a worker keeps the bridge only', () => {
  const lead = resolveClaudeMcpBundles({ ...WEB, teamLead: true });
  assert.ok(lead.includes('cortex-workers'));
  assert.ok(lead.includes('cortex-interaction-bridge'));
  const worker = resolveClaudeMcpBundles({ ...WEB });
  assert.ok(!worker.includes('cortex-workers'));
  assert.ok(worker.includes('cortex-interaction-bridge'));
  assert.ok(!resolveClaudeMcpBundles({ ...WEB, teamLead: true, mcpComposition: 'none' })
    .includes('cortex-workers'));
});

function spec(teamLead: boolean, composition: McpComposition = 'direct') {
  const s = engineSpecFixture({
    sessionId: 's', sessionKey: 'web:s', channel: 'web:s', resume: false,
    mcpComposition: composition, isUserInitiated: true,
  });
  if (teamLead) s.flags.teamLead = true;
  return s;
}

test('Claude: toggling the lead flag changes the pool identity, so the next turn respawns with resume', () => {
  assert.notEqual(claudeSpecIdentity(spec(true)), claudeSpecIdentity(spec(false)));
  assert.equal(claudeSpecIdentity(spec(false)), claudeSpecIdentity(spec(false)));
  assert.ok(!claudeSpecIdentity(spec(false)).includes('teamLead'), 'non-leads keep their identity');
});

function piRequest(teamLead: boolean, composition: McpComposition = 'direct') {
  return buildSessionRequest(spec(teamLead, composition), {
    agentDir: '/tmp/pi-agent', sessionDir: '/tmp/pi-sessions', sessionPath: null, cwd: '/tmp', streamDeltas: true,
  });
}

function bundlesOf(env: NodeJS.ProcessEnv): string[] {
  const core = buildServerStates(env).find(state => state.name === 'core');
  assert.ok(core?.source.kind === 'bundled');
  return core.source.bundles;
}

test('Pi: the lead env flag selects cortex-workers; a worker keeps the interaction bridge', () => {
  const lead = piRequest(true);
  assert.equal(lead.env[PI_TEAM_LEAD_ENV], '1');
  assert.ok(bundlesOf(lead.env).includes('cortex-workers'));
  assert.ok(bundlesOf(lead.env).includes('cortex-interaction-bridge'));

  const worker = piRequest(false);
  assert.equal(worker.env[PI_TEAM_LEAD_ENV], undefined);
  assert.ok(!bundlesOf(worker.env).includes('cortex-workers'));
  assert.ok(bundlesOf(worker.env).includes('cortex-interaction-bridge'));

  assert.equal(piRequest(true, 'none').env[PI_TEAM_LEAD_ENV], undefined);
  assert.notEqual(sessionIdentity(lead), sessionIdentity(worker), 'a changed flag is a fresh pooled session');
});

test('Pi: an inherited lead flag is reset, and subagent children never get the worker tools', () => {
  const stale = buildSessionRequest(spec(false), {
    agentDir: '/tmp/pi-agent', sessionDir: '/tmp/pi-sessions', sessionPath: null, cwd: '/tmp', streamDeltas: true,
  });
  assert.equal(stale.env[PI_TEAM_LEAD_ENV], undefined);
  const child = buildChildEnv({ [PI_TEAM_LEAD_ENV]: '1', [PI_MCP_COMPOSITION_ENV]: 'direct', [PI_INTERACTION_BRIDGE_ENV]: '1' }, '/tmp/a');
  assert.equal(child[PI_TEAM_LEAD_ENV], undefined);
  assert.ok(!bundlesOf({ [PI_MCP_COMPOSITION_ENV]: 'direct', [PI_TEAM_LEAD_ENV]: '1', CORTEX_PI_SUBAGENT: '1' })
    .includes('cortex-workers'));
});
