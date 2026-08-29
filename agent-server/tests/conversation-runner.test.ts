// input:  prompt builder and execution registration seams
// output: prompt and registration ordering tests
// pos:    Verifies thread-free conversation execution
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// Plain user messages no longer run as a `templateName:'default'` thread; they run via
// runConversation, which assembles its prompt with buildConversationPrompt (no thread, no
// artifact, no [ABORT] protocol). These tests pin that assembly so the migration does not
// silently change every chat turn.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildConversationPrompt, THREAD_PROTOCOL_PREAMBLE } from '../src/domain/threads/prompt-builder.js';
import {
  registerConversationHandle,
  resolveConversationCommission,
  resolveConversationProject,
} from '../src/orchestration/conversation-runner.js';
import type { CommissionPromptContext } from '../src/domain/commissions/commission-context.js';
import type { AgentSlotConfig } from '../src/core/types/thread-types.js';
import type { Project } from '../src/domain/projects/project-types.js';

function makeAgentConfig(overrides: Partial<AgentSlotConfig> = {}): AgentSlotConfig {
  return {
    slotId: 'main',
    profile: '__active__',
    persistSession: false,
    directive: '',
    systemPrompt: 'SYSTEM',
    promptTemplate: '{{input}}',
    claudeAgent: null,
    outputStyle: null,
    tools: 'Read',
    pluginDirs: null,
    stages: undefined,
    entryStage: undefined,
    ...overrides,
  } as AgentSlotConfig;
}

test('registration callback fires only after the backend handle is cancellable', () => {
  const order: string[] = [];
  registerConversationHandle(
    { register: () => { order.push('register'); return 'execution-id'; } },
    {} as never,
    () => { order.push('release-start-guard'); },
  );
  assert.deepEqual(order, ['register', 'release-start-guard']);
});

test('buildConversationPrompt with the default {{input}} template and empty directive is just the message', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hello world');
  assert.equal(prompt, 'hello world');
  assert.ok(!prompt.includes(THREAD_PROTOCOL_PREAMBLE), 'conversation prompt must not contain the thread protocol preamble');
});

test('buildConversationPrompt prepends a non-empty directive, still no preamble', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: 'You are the direct agent.' }), 'what is 2+2?');
  assert.ok(prompt.startsWith('You are the direct agent.'));
  assert.ok(prompt.includes('what is 2+2?'));
  assert.ok(!prompt.includes(THREAD_PROTOCOL_PREAMBLE));
});

test('buildConversationPrompt applies a custom promptTemplate', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '', promptTemplate: 'User asked: {{input}}' }), 'status?');
  assert.equal(prompt, 'User asked: status?');
});

// ── Project prefix (Web UI direct sessions bound to a project) ──────────────

test('buildConversationPrompt injects a project block naming the project id and context dir', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: 'DIRECTIVE' }), 'hello', {
    project: { id: 'tactile-vr', contextDir: '/ctx/projects/tactile-vr' },
  });
  assert.ok(prompt.includes('tactile-vr'), 'project id must appear in the prompt');
  assert.ok(prompt.includes('/ctx/projects/tactile-vr'), 'project context dir must appear in the prompt');
  // The project block is a prefix: it comes before the user message.
  assert.ok(prompt.indexOf('tactile-vr') < prompt.indexOf('hello'));
  assert.ok(prompt.endsWith('hello'), 'user message stays last');
  assert.ok(!prompt.includes(THREAD_PROTOCOL_PREAMBLE));
});

test('buildConversationPrompt without a project opt injects no project block', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hello');
  assert.equal(prompt, 'hello');
});

test('buildConversationPrompt with project:null behaves like no project', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hello', { project: null });
  assert.equal(prompt, 'hello');
});

// ── resolveConversationProject gating ───────────────────────────────────────

function makeStore(projects: Project[]): { get(id: string): Project | undefined } {
  return { get: (id: string) => projects.find((p) => p.id === id) };
}

const userProject: Project = { id: 'proj-a', name: 'proj-a', kind: 'user', contextDir: '/ctx/projects/proj-a' };
const generalProject: Project = { id: 'general', name: 'general', kind: 'general', contextDir: '/ctx/projects/general' };

test('resolveConversationProject returns the project for a fresh web session bound to a user project', () => {
  const p = resolveConversationProject({
    channel: 'web:abc123', projectId: 'proj-a', isFreshSession: true, store: makeStore([userProject, generalProject]),
  });
  assert.deepEqual(p, { id: 'proj-a', contextDir: '/ctx/projects/proj-a' });
});

test('resolveConversationProject returns null for non-web channels', () => {
  const p = resolveConversationProject({
    channel: 'slack:C0123', projectId: 'proj-a', isFreshSession: true, store: makeStore([userProject]),
  });
  assert.equal(p, null);
});

test('resolveConversationProject returns null on a resumed (non-fresh) session', () => {
  const p = resolveConversationProject({
    channel: 'web:abc123', projectId: 'proj-a', isFreshSession: false, store: makeStore([userProject]),
  });
  assert.equal(p, null);
});

test('resolveConversationProject returns null for the general umbrella project', () => {
  const p = resolveConversationProject({
    channel: 'web:abc123', projectId: 'general', isFreshSession: true, store: makeStore([userProject, generalProject]),
  });
  assert.equal(p, null);
});

test('resolveConversationProject returns null when the project is unknown to the store', () => {
  const p = resolveConversationProject({
    channel: 'web:abc123', projectId: 'deleted-proj', isFreshSession: true, store: makeStore([userProject]),
  });
  assert.equal(p, null);
});

// ── [Commission] block ──────────────────────────────────────────────────────

const commissionCtx: CommissionPromptContext = {
  id: 'comm-1',
  title: 'Ship the parser',
  dir: '/ctx/projects/proj-a/commissions/ship-the-parser',
  hasLedger: true,
};

test('buildConversationPrompt injects the commission block as an index plus the protocol', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hello', {
    project: { id: 'proj-a', contextDir: '/ctx/projects/proj-a' },
    commission: commissionCtx,
  });
  assert.match(prompt, /\[Commission\] This session belongs to the commission "Ship the parser" \(comm-1\)/);
  assert.match(prompt, /Commission directory: \/ctx\/projects\/proj-a\/commissions\/ship-the-parser/);
  assert.match(prompt, /Read both files now/);
  assert.match(prompt, /Commission protocol:/);
  assert.ok(prompt.indexOf('[Session Project]') < prompt.indexOf('[Commission]'), 'commission block follows the project block');
  assert.ok(prompt.endsWith('hello'));
});

test('the commission block never pastes contract or ledger content', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hi', {
    commission: commissionCtx,
  });
  assert.ok(!prompt.includes('--- contract.md ---'), 'no contract snapshot');
  assert.ok(!prompt.includes('ledger digest'), 'no ledger snapshot');
  // The whole block stays small enough to be free at the start of every commission session.
  assert.ok(prompt.length < 1_800, `block unexpectedly large: ${prompt.length}`);
});

test('buildConversationPrompt tells the agent to create ledger.md when it does not exist yet', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hi', {
    commission: { ...commissionCtx, hasLedger: false },
  });
  assert.match(prompt, /ledger\.md   — NOT created yet/);
});

test('resolveConversationCommission loads the context only for commission-bound sessions', async () => {
  const load = (async (id: string) => ({ ...commissionCtx, id })) as typeof import('../src/domain/commissions/commission-context.js').loadCommissionPromptContext;
  const bound = await resolveConversationCommission('sess-1', {
    getSession: async () => ({ commissionId: 'comm-9' }), load,
  });
  assert.equal(bound?.id, 'comm-9');

  const unbound = await resolveConversationCommission('sess-1', {
    getSession: async () => ({ commissionId: null }), load,
  });
  assert.equal(unbound, null);

  const failing = await resolveConversationCommission('sess-1', {
    getSession: async () => { throw new Error('registry down'); }, load,
  });
  assert.equal(failing, null, 'injection is best-effort — failures inject nothing');
});
