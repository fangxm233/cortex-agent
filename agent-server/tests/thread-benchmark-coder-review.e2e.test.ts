// input:  shipped benchmark defaults, thread state machine, identity helpers
// output: benchmark coder-review graph, isolation, and hash contracts
// pos:    Verifies the bounded benchmark coder-review template
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSpawnArgs } from '../src/agent-adapter/claude/spawn-args.js';
import type { AgentSpawnConfig, McpComposition } from '../src/agent-adapter/types.js';
import { generateMcpConfig } from '../src/core/config-generator.js';
import { CONFIG_DIR, DEFAULTS_DIR } from '../src/core/paths.js';
import {
  computeModelExecutionIdentityHash,
  computeRoleToolSurfaceHash,
} from '../src/domain/agent-run/identity.js';
import { roleSurfaceFromSpawnConfig } from '../src/domain/agent-run/role-surface.js';
import {
  createThread,
  evaluateTransitions,
  getAgent,
  getTemplate,
  loadConfig,
  mergeThreadTemplates,
  recordStepResult,
  resolveNextStep,
  resolveTemplateAgents,
} from '../src/domain/threads/index.js';
import { threadStore } from '../src/store/thread-repo.js';
import type { AgentSlotConfig, ThreadRecord } from '../src/core/types/thread-types.js';

const TEMPLATE_ROOT = path.join(CONFIG_DIR, 'thread-templates');
const DEFAULT_TEMPLATE_ROOT = path.join(DEFAULTS_DIR, 'config', 'thread-templates');
const TEMPLATE_PATH = path.join(
  DEFAULT_TEMPLATE_ROOT,
  'templates',
  'benchmark-coder-review.json',
);
// The two placements have two surfaces: the coder mutates the shared workspace, while the reviewer
// runs in a disposable snapshot and holds no file-writing tool at all.
const ALLOWED_TOOLS: Record<string, string[]> = {
  'benchmark-coder': ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'Skill'],
  'benchmark-reviewer': ['Bash', 'Read', 'Glob', 'Grep', 'TodoWrite', 'Skill'],
};
const createdThreadIds = new Set<string>();

beforeAll(() => {
  fs.rmSync(TEMPLATE_ROOT, { recursive: true, force: true });
  assert.equal(mergeThreadTemplates(DEFAULT_TEMPLATE_ROOT, TEMPLATE_ROOT), true);
  generateMcpConfig();
  loadConfig();
});

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

function freshThread(channel: string): ThreadRecord {
  const thread = createThread(channel, {
    templateName: 'benchmark-coder-review',
    userMessage: 'repair the task workspace',
    userMessageTs: String(Date.now()),
  });
  createdThreadIds.add(thread.id);
  return thread;
}

async function simulateStep(threadId: string, output: string): Promise<void> {
  const thread = threadStore.get(threadId)!;
  const next = resolveNextStep(threadId);
  assert.ok(next, 'expected a runnable benchmark step');
  fs.appendFileSync(thread.artifactPath, output);
  await recordStepResult(threadId, next.agentSlotId, {
    sessionId: `track-${next.agentSlotId}-${next.stage}`,
    backendSessionId: `backend-${next.agentSlotId}-${next.stage}`,
    sessionName: `session-${next.stage}`,
    executionId: null,
    input: '',
    startedAt: new Date().toISOString(),
    output,
    costUsd: 0,
    numTurns: 1,
    durationS: 0,
    stage: next.stage,
  });
}

function endpointSequence(thread: ThreadRecord): string[] {
  return thread.steps.map(step => `${step.agentSlotId}:${step.stage}`);
}

function mcpConfigPaths(args: string[]): string[] {
  const start = args.indexOf('--mcp-config');
  assert.ok(start >= 0);
  const result: string[] = [];
  for (let index = start + 1; index < args.length; index += 1) {
    if (args[index].startsWith('--')) break;
    result.push(args[index]);
  }
  return result;
}

function declaredMcpServers(agent: AgentSlotConfig): string[] {
  const composition: McpComposition | undefined = agent.mcpComposition;
  const args = buildSpawnArgs({
    tools: agent.tools,
    needsResume: false,
    sessionId: `benchmark-${agent.slotId}`,
    mcpComposition: composition,
  });
  assert.ok(args.includes('--strict-mcp-config'));
  return mcpConfigPaths(args).flatMap((configPath) => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Object.keys(config.mcpServers);
  });
}

function roleSpawnConfig(agent: AgentSlotConfig): AgentSpawnConfig {
  const template = getTemplate('benchmark-coder-review')!;
  return {
    sessionId: null,
    sessionKey: agent.slotId,
    resume: false,
    systemPrompt: agent.systemPrompt,
    rawTools: agent.tools,
    pluginDirs: agent.pluginDirs,
    mcpComposition: agent.mcpComposition,
    disableHooks: template.disableHooks,
  };
}

test('benchmark defaults resolve as one hook-free four-step template', () => {
  const template = getTemplate('benchmark-coder-review');
  assert.ok(template);
  assert.ok(getAgent('benchmark-coder'));
  assert.ok(getAgent('benchmark-reviewer'));
  assert.equal(template.entryAgent, 'benchmark-coder');
  assert.equal(template.entryStage, 'implement');
  assert.equal(template.maxTotalSteps, 4);
  assert.equal(template.disableHooks, true);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')), 'hooks'), false);
  assert.deepEqual(template.transitions, [
    {
      from: 'benchmark-coder:implement',
      to: 'benchmark-reviewer:audit',
      condition: { type: 'always' },
    },
    {
      from: 'benchmark-reviewer:audit',
      to: 'benchmark-coder:retry',
      condition: {
        type: 'convergence',
        marker: '[IMPL-APPROVED]',
        maxIterations: 1,
      },
    },
    {
      from: 'benchmark-coder:retry',
      to: 'benchmark-reviewer:finalAudit',
      condition: { type: 'always' },
    },
  ]);
});

test('benchmark graph ends after an approved first audit', async () => {
  const thread = freshThread('C-benchmark-approved');
  await simulateStep(thread.id, 'implemented\n');
  assert.equal(evaluateTransitions(thread.id).nextStage, 'audit');
  await simulateStep(thread.id, 'verified\n[IMPL-APPROVED]\n');
  const result = evaluateTransitions(thread.id);
  assert.equal(result.shouldTransition, false);
  assert.equal(result.reason, 'converged');
  assert.deepEqual(endpointSequence(threadStore.get(thread.id)!), [
    'benchmark-coder:implement',
    'benchmark-reviewer:audit',
  ]);
});

test('benchmark graph allows one retry, requires final audit, and stops at four steps', async () => {
  const thread = freshThread('C-benchmark-retry');
  await simulateStep(thread.id, 'implemented\n');
  evaluateTransitions(thread.id);
  await simulateStep(thread.id, 'Blocker: targeted check failed\n');
  const retry = evaluateTransitions(thread.id);
  assert.equal(retry.nextAgent, 'benchmark-coder');
  assert.equal(retry.nextStage, 'retry');
  await simulateStep(thread.id, 'fixed blocker\n');
  const finalAudit = evaluateTransitions(thread.id);
  assert.equal(finalAudit.nextAgent, 'benchmark-reviewer');
  assert.equal(finalAudit.nextStage, 'finalAudit');
  await simulateStep(thread.id, 'Blocker remains\n');
  const capped = evaluateTransitions(thread.id);
  assert.equal(capped.shouldTransition, false);
  assert.equal(capped.reason, 'max_iterations');
  assert.deepEqual(endpointSequence(threadStore.get(thread.id)!), [
    'benchmark-coder:implement',
    'benchmark-reviewer:audit',
    'benchmark-coder:retry',
    'benchmark-reviewer:finalAudit',
  ]);
});

test('benchmark agents resolve the exact native tools and zero MCP tools', () => {
  const template = getTemplate('benchmark-coder-review')!;
  const agents = resolveTemplateAgents(template);
  assert.deepEqual(agents.map(agent => agent.slotId), [
    'benchmark-coder',
    'benchmark-reviewer',
  ]);
  for (const agent of agents) {
    assert.deepEqual(agent.tools?.split(','), ALLOWED_TOOLS[agent.slotId]);
    assert.equal(agent.mcpComposition, 'none');
    assert.deepEqual(declaredMcpServers(agent), []);
  }
});

test('benchmark agents share model identity but have distinct role surfaces', () => {
  const template = getTemplate('benchmark-coder-review')!;
  const agents = resolveTemplateAgents(template);
  assert.deepEqual(agents.map(agent => agent.profile), ['__active__', '__active__']);
  const modelHashes = agents.map(() => computeModelExecutionIdentityHash({
    backend: 'claude',
    requestedModel: 'benchmark-model',
    modelAliasPolicy: { policy: 'exact' },
    providerProtocol: 'anthropic',
    configuredRouteBaseHost: 'gateway.invalid',
    claudeCliVersion: 'fixture-version',
    cliName: 'claude',
    cliVersion: 'fixture-version',
    reasoningEffort: 'high',
    fallbackEmpty: true,
  }));
  assert.equal(new Set(modelHashes).size, 1);
  const roleHashes = agents.map(agent => computeRoleToolSurfaceHash(
    roleSurfaceFromSpawnConfig(roleSpawnConfig(agent)),
  ));
  assert.equal(new Set(roleHashes).size, 2);
});

test('benchmark reviewer prompts require targeted read-only workspace audit', () => {
  const reviewer = getAgent('benchmark-reviewer')!;
  for (const stageName of ['audit', 'finalAudit']) {
    const prompt = reviewer.stages?.[stageName]?.promptTemplate ?? '';
    assert.match(prompt, /inspect the current task workspace/i);
    assert.match(prompt, /targeted verification/i);
    // The verdict is the reviewer's final message, not a file it writes: the coordinator appends
    // that message to the artifact, so the reviewer needs no write of its own.
    assert.match(prompt, /as your final message/i);
    assert.doesNotMatch(prompt, /you may write|Append/i);
    assert.doesNotMatch(prompt, /full test suite|whole-repository|commit/i);
  }
});
